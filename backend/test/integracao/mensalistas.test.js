// Mensalistas: contratos, ocorrências, exceções, conflitos, solicitações e mensalidades.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { pular, iniciar } from "./ajuda.js";

describe("mensalistas", { skip: pular }, () => {
  let t;
  let token;
  before(async () => {
    t = await iniciar();
    token = await t.login("dono");
  });
  after(async () => { await t?.fechar(); });

  const contrato = (campos) => t.api("POST", "/admin/contratos", {
    nome: "Responsável Teste", telefone: t.telefone(), duracao_min: 60,
    valor_mensal_centavos: 40000, dia_vencimento: 10, data_inicio: t.hoje, ...campos,
  }, token);

  test("dois contratos não ocupam o mesmo dia e horário", async () => {
    const dia = t.diaSemana(t.dia(9));
    const a = await contrato({ dia_semana: dia, hora_inicio: "20:00", data_fim: t.dia(60) });
    assert.equal(a.status, 201, JSON.stringify(a.corpo));
    const b = await contrato({ dia_semana: dia, hora_inicio: "20:30" });
    assert.equal(b.status, 409);
    assert.match(b.corpo.erro, /mensalista/);
    // depois que o primeiro termina, o mesmo horário pode ter outro contrato
    const c = await contrato({ dia_semana: dia, hora_inicio: "20:00", data_inicio: t.dia(61) });
    assert.equal(c.status, 201, JSON.stringify(c.corpo));
  });

  test("avulsa × mensalista: o horário do mensalista aparece ocupado e não aceita avulsa", async () => {
    const r = await contrato({ dia_semana: t.diaSemana(t.dia(8)), hora_inicio: "19:00" });
    assert.equal(r.status, 201);
    assert.deepEqual(r.corpo.conflitos, []);

    assert.equal((await t.reservar({ data: t.dia(8), horario: "19:00" })).status, 409);
    assert.equal((await t.reservar({ data: t.dia(8), horario: "18:30" })).status, 409); // 18:30–19:30 bate
    assert.equal((await t.reservar({ data: t.dia(8), horario: "18:00" })).status, 201); // encosta

    const agenda = await t.api("GET", `/agenda?inicio=${t.dia(8)}&dias=1`);
    assert.ok(agenda.corpo.dias[0].ocupados.some((o) => o.fim === "20:00"));
  });

  test("exceção libera o horário para avulso só naquela data", async () => {
    const { corpo: lista } = await t.api("GET", "/admin/contratos", undefined, token);
    const c = lista.find((x) => x.hora_inicio === "19:00");

    // data que não cai no dia do mensalista
    assert.equal((await t.api("POST", `/admin/contratos/${c.id}/excecoes`, { data: t.dia(9) }, token)).status, 400);

    const ex = await t.api("POST", `/admin/contratos/${c.id}/excecoes`, { data: t.dia(8), motivo: "Feriado" }, token);
    assert.equal(ex.status, 201);
    assert.equal((await t.reservar({ data: t.dia(8), horario: "19:00" })).status, 201);   // liberado
    assert.equal((await t.reservar({ data: t.dia(15), horario: "19:00" })).status, 409);  // semana seguinte não

    // gerar de novo as ocorrências não desfaz a exceção
    await t.api("GET", `/agenda?inicio=${t.dia(8)}&dias=1`);
    const { rows } = await t.pool.query(
      "SELECT status FROM reservas WHERE contrato_id = $1 AND data_ocorrencia = $2", [c.id, t.dia(8)]);
    assert.equal(rows[0].status, "liberada");

    // desfazer a exceção: o horário já foi pego por avulso
    const desfazer = await t.api("DELETE", `/admin/contratos/${c.id}/excecoes/${t.dia(8)}`, undefined, token);
    assert.equal(desfazer.status, 409);

    // mensalidade não muda com a exceção
    const det = await t.api("GET", `/admin/contratos/${c.id}`, undefined, token);
    assert.equal(det.corpo.valor_mensal_centavos, 40000);
    assert.equal(det.corpo.excecoes.length, 1);
  });

  test("contrato sobre avulsas já marcadas: avisa os conflitos e não apaga nada", async () => {
    const r1 = await t.reservar({ data: t.dia(10), horario: "21:00" });
    const r2 = await t.reservar({ data: t.dia(17), horario: "21:00" });
    assert.equal(r1.status, 201);

    const c = await contrato({ dia_semana: t.diaSemana(t.dia(10)), hora_inicio: "21:00" });
    assert.equal(c.status, 201);
    assert.deepEqual(c.corpo.conflitos.map((x) => x.reserva_id).sort(), [r1.corpo.id, r2.corpo.id].sort());
    const avulsas = await t.pool.query("SELECT status FROM reservas WHERE id = ANY($1)", [[r1.corpo.id, r2.corpo.id]]);
    assert.ok(avulsas.rows.every((x) => x.status === "confirmada"));

    // o cliente cancela a primeira: o mensalista recupera o horário sozinho
    await t.api("POST", `/reservas/${r1.corpo.id}/cancelar`, { codigo: r1.corpo.codigo });
    const agenda = await t.api("GET", `/admin/agenda?inicio=${t.dia(10)}&dias=1`, undefined, token);
    const oc = agenda.corpo.reservas.find((x) => x.origem === "mensalista" && x.inicio === "21:00");
    assert.equal(oc.status, "confirmada");

    // a segunda o dono resolve: fica o mensalista, a avulsa é cancelada e volta quem avisar
    const det = await t.api("GET", `/admin/contratos/${c.corpo.contrato.id}`, undefined, token);
    assert.equal(det.corpo.conflitos.length, 1);
    const resolver = await t.api("POST", `/admin/ocorrencias/${det.corpo.conflitos[0].ocorrencia_id}/resolver`,
      { manter: "mensalista" }, token);
    assert.equal(resolver.status, 200);
    assert.equal(resolver.corpo.canceladas[0].id, r2.corpo.id);
    assert.ok(resolver.corpo.canceladas[0].cliente_telefone);
  });

  test("pausar libera os horários; reativar volta e avisa o que ficou no caminho", async () => {
    const c = await contrato({ dia_semana: t.diaSemana(t.dia(12)), hora_inicio: "08:00" });
    const id = c.corpo.contrato.id;
    assert.equal((await t.reservar({ data: t.dia(12), horario: "08:00" })).status, 409);

    assert.equal((await t.api("PATCH", `/admin/contratos/${id}`, { acao: "pausar" }, token)).status, 200);
    const avulsa = await t.reservar({ data: t.dia(12), horario: "08:00" });
    assert.equal(avulsa.status, 201);

    // pausado continua segurando a vaga para novos contratos
    assert.equal((await contrato({ dia_semana: t.diaSemana(t.dia(12)), hora_inicio: "08:00" })).status, 409);

    const reativar = await t.api("PATCH", `/admin/contratos/${id}`, { acao: "reativar" }, token);
    assert.equal(reativar.status, 200);
    assert.equal(reativar.corpo.conflitos.length, 1);
    assert.equal(reativar.corpo.conflitos[0].reserva_id, avulsa.corpo.id);
    assert.equal((await t.reservar({ data: t.dia(19), horario: "08:00" })).status, 409);

    // encerrar libera o horário de vez
    const enc = await t.api("PATCH", `/admin/contratos/${id}`, { acao: "encerrar" }, token);
    assert.equal(enc.corpo.contrato.status, "encerrado");
    assert.equal((await t.reservar({ data: t.dia(19), horario: "08:00" })).status, 201);
  });

  test("solicitação do site vira contrato só com aprovação", async () => {
    const tel = t.telefone();
    const s = await t.api("POST", "/solicitacoes-mensalista", {
      nome: "Grupo da Sexta", telefone: tel, dia_semana: t.diaSemana(t.dia(13)), hora_inicio: "22:00",
      duracao_min: 60, observacao: "Somos 14", aceite_privacidade: true,
    });
    assert.equal(s.status, 201);
    // nada foi reservado
    assert.equal((await t.reservar({ data: t.dia(13), horario: "22:00" })).status, 201);

    const pendentes = await t.api("GET", "/admin/solicitacoes", undefined, token);
    const pedido = pendentes.corpo.find((x) => x.id === s.corpo.id);
    assert.equal(pedido.hora_fim, "23:00");

    const ap = await t.api("POST", `/admin/solicitacoes/${s.corpo.id}/aprovar`,
      { valor_mensal_centavos: 45000, data_inicio: t.dia(14) }, token);
    assert.equal(ap.status, 201, JSON.stringify(ap.corpo));
    assert.equal(ap.corpo.contrato.nome_grupo, null);
    assert.equal(ap.corpo.contrato.valor_mensal_centavos, 45000);
    assert.equal(ap.corpo.contrato.telefone, tel);
    assert.equal((await t.api("POST", `/admin/solicitacoes/${s.corpo.id}/aprovar`, {}, token)).status, 404);
    // sem aprovação do dono não sai nada: recusar a mesma também já não dá
    assert.equal((await t.api("POST", `/admin/solicitacoes/${s.corpo.id}/recusar`, {}, token)).status, 404);
  });

  test("mensalidades: gerar duas vezes não duplica, e atrasada é calculada", async () => {
    const [a, m] = t.hoje.split("-").map(Number);
    const mesAnterior = m === 1 ? `${a - 1}-12` : `${a}-${String(m - 1).padStart(2, "0")}`;
    const c = await contrato({
      dia_semana: t.diaSemana(t.dia(11)), hora_inicio: "06:00", data_inicio: t.dia(-70), dia_vencimento: 5,
    });
    assert.equal(c.status, 201, JSON.stringify(c.corpo));

    const g1 = await t.api("POST", "/admin/mensalidades/gerar", { mes: mesAnterior }, token);
    assert.equal(g1.status, 200);
    assert.ok(g1.corpo.criadas >= 1);
    const g2 = await t.api("POST", "/admin/mensalidades/gerar", { mes: mesAnterior }, token);
    assert.equal(g2.corpo.criadas, 0);
    assert.equal(g2.corpo.ja_existiam, g1.corpo.criadas);

    const lista = await t.api("GET", `/admin/mensalidades?mes=${mesAnterior}`, undefined, token);
    const minha = lista.corpo.mensalidades.find((x) => x.contrato_id === c.corpo.contrato.id);
    assert.equal(minha.situacao, "atrasada");             // venceu dia 5 do mês passado
    assert.equal(minha.vencimento, `${mesAnterior}-05`);
    assert.equal(minha.valor_centavos, 40000);            // valor fixo, não por jogo
    assert.ok(lista.corpo.totais.atrasado_centavos >= 40000);

    // atrasada não bloqueia nada sozinha: o contrato continua ativo
    const det = await t.api("GET", `/admin/contratos/${c.corpo.contrato.id}`, undefined, token);
    assert.equal(det.corpo.status, "ativo");

    const pago = await t.api("PATCH", `/admin/mensalidades/${minha.id}`, { acao: "pagar", forma_pagamento: "pix" }, token);
    assert.equal(pago.status, 200);
    assert.equal(pago.corpo.situacao, "paga");
    assert.equal(pago.corpo.pago_em, t.hoje);
    // pagar de novo: já está paga
    assert.equal((await t.api("PATCH", `/admin/mensalidades/${minha.id}`, { acao: "pagar", forma_pagamento: "pix" }, token)).status, 409);

    // o script do terminal usa a mesma função: no mês atual, cria uma por contrato ativo
    const atual = await t.api("POST", "/admin/mensalidades/gerar", { mes: t.hoje.slice(0, 7) }, token);
    const { rows } = await t.pool.query(
      `SELECT count(*) AS n FROM contratos_mensalistas
        WHERE status = 'ativo' AND data_inicio < ($1::date + interval '1 month')
          AND (data_fim IS NULL OR data_fim >= $1::date)`, [`${t.hoje.slice(0, 7)}-01`]);
    assert.equal(atual.corpo.criadas, rows[0].n);
  });

  test("a constraint do banco barra a sobreposição mesmo sem passar pela API", async () => {
    // duas transações gravando ao mesmo tempo: a segunda espera a primeira e falha
    const [c1, c2] = await Promise.all([t.pool.connect(), t.pool.connect()]);
    const inserir = (db) => db.query(
      `INSERT INTO reservas (arena_id, origem, inicio, fim, cliente_nome)
       VALUES (1, 'painel', ($1::date + '03:00'::time) AT TIME ZONE 'America/Sao_Paulo',
                            ($1::date + '04:00'::time) AT TIME ZONE 'America/Sao_Paulo', 'Teste')`,
      [t.dia(20)]);
    try {
      await c1.query("BEGIN");
      await c2.query("BEGIN");
      await inserir(c1);
      const segunda = inserir(c2).then(() => "gravou", (e) => e.code);
      await c1.query("COMMIT");
      assert.equal(await segunda, "23P01");
    } finally {
      await c2.query("ROLLBACK");
      c1.release();
      c2.release();
    }
  });
});
