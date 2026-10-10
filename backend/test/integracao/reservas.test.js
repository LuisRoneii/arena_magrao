// Reservas avulsas pelo site: conflitos, corrida, antecedência, preço, código e remarcar.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { pular, iniciar } from "./ajuda.js";

describe("reservas avulsas", { skip: pular }, () => {
  let t;
  before(async () => { t = await iniciar(); });
  after(async () => { await t?.fechar(); });

  test("avulsa × avulsa: o mesmo horário não pode ser reservado duas vezes", async () => {
    const data = t.dia(2);
    const a = await t.reservar({ data, horario: "10:00" });
    assert.equal(a.status, 201, JSON.stringify(a.corpo));
    const b = await t.reservar({ data, horario: "10:00" });
    assert.equal(b.status, 409);
    // sobreposição parcial também: 1h30 começando 9:30 bate com 10:00–11:00
    const c = await t.reservar({ data, horario: "09:30", duracao_min: 90 });
    assert.equal(c.status, 409);
    // encostado pode: 11:00–12:00
    const d = await t.reservar({ data, horario: "11:00" });
    assert.equal(d.status, 201);
  });

  test("duas pessoas clicando ao mesmo tempo: só uma consegue", async () => {
    const data = t.dia(3);
    const respostas = await Promise.all(
      Array.from({ length: 6 }, () => t.reservar({ data, horario: "20:00" }))
    );
    const status = respostas.map((r) => r.status).sort();
    assert.deepEqual(status, [201, 409, 409, 409, 409, 409]);
    const { rows } = await t.pool.query(
      `SELECT count(*) AS n FROM reservas
        WHERE status = 'confirmada' AND inicio = ($1::date + '20:00'::time) AT TIME ZONE 'America/Sao_Paulo'`,
      [data]
    );
    assert.equal(rows[0].n, 1);
  });

  test("preço por faixa e por duração, calculado no servidor", async () => {
    const data = t.dia(4);
    const normal = await t.reservar({ data, horario: "08:00" });              // 1h normal
    const nobre = await t.reservar({ data, horario: "20:00", duracao_min: 120 }); // 2h nobre
    const cruza = await t.reservar({ data, horario: "17:30", duracao_min: 90 });  // 30 normal + 60 nobre
    assert.equal(normal.corpo.valor_centavos, 10000);
    assert.equal(nobre.corpo.valor_centavos, 30000);
    assert.equal(nobre.corpo.nobre, true);
    assert.equal(cruza.corpo.valor_centavos, 5000 + 15000);
  });

  test("a agenda pública mostra ocupado sem nome nem tipo", async () => {
    const data = t.dia(4);
    const r = await t.api("GET", `/agenda?inicio=${data}&dias=1&duracao=60`);
    assert.equal(r.status, 200);
    const [dia] = r.corpo.dias;
    assert.ok(dia.ocupados.some((o) => o.inicio === "20:00" && o.fim === "22:00"));
    assert.ok(!dia.livres.some((l) => l.horario === "20:00"));
    assert.ok(!JSON.stringify(r.corpo).includes("Jogador"));
    assert.ok(!JSON.stringify(r.corpo).includes("4799"));
  });

  test("duração fora das permitidas e horário fora da grade são recusados", async () => {
    assert.equal((await t.reservar({ data: t.dia(5), horario: "10:00", duracao_min: 45 })).status, 400);
    assert.equal((await t.reservar({ data: t.dia(5), horario: "10:15" })).status, 409);
  });

  test("fora do funcionamento é recusado", async () => {
    await t.pool.query("UPDATE funcionamento SET hora_inicio = '08:00', hora_fim = '22:00' WHERE dia_semana = $1",
      [t.diaSemana(t.dia(6))]);
    assert.equal((await t.reservar({ data: t.dia(6), horario: "07:00" })).status, 409);
    assert.equal((await t.reservar({ data: t.dia(6), horario: "21:30" })).status, 409); // terminaria 22:30
    assert.equal((await t.reservar({ data: t.dia(6), horario: "21:00" })).status, 201);
    await t.pool.query("UPDATE funcionamento SET hora_inicio = '00:00', hora_fim = '24:00'");
  });

  test("sem aceitar a política de privacidade não reserva", async () => {
    const r = await t.reservar({ data: t.dia(5), horario: "12:00", extra: { aceite_privacidade: false } });
    assert.equal(r.status, 400);
  });

  test("antecedência mínima para reservar", async () => {
    await t.configurar({ antecedencia_reserva_min: 48 * 60 });
    try {
      // amanhã 10:00 fica a menos de 48h de qualquer hora de hoje
      assert.equal((await t.reservar({ data: t.dia(1), horario: "10:00" })).status, 409);
      // daqui a 3 dias, 10:00, fica a mais de 48h
      assert.equal((await t.reservar({ data: t.dia(3), horario: "10:00" })).status, 201);
      // ontem nunca
      assert.equal((await t.reservar({ data: t.dia(-1), horario: "10:00" })).status, 409);
    } finally {
      await t.configurar({ antecedencia_reserva_min: 0 });
    }
  });

  test("janela: não reserva além dos dias permitidos", async () => {
    assert.equal((await t.reservar({ data: t.dia(31), horario: "10:00" })).status, 409);
    assert.equal((await t.reservar({ data: t.dia(30), horario: "10:00" })).status, 201);
  });

  test("consulta pelo número + código, e só com os dois", async () => {
    const r = await t.reservar({ data: t.dia(7), horario: "15:00", nome: "Fulano da Silva" });
    const { id, codigo } = r.corpo;
    assert.match(codigo, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/);

    const ok = await t.api("GET", `/reservas/${id}?codigo=${codigo.toLowerCase()}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.corpo.nome, "Fulano da Silva");
    assert.equal(ok.corpo.horario, "15:00");
    assert.equal(ok.corpo.cliente_telefone, undefined); // telefone não volta

    // código de outra reserva não abre esta
    const outra = await t.reservar({ data: t.dia(7), horario: "16:00" });
    assert.equal((await t.api("GET", `/reservas/${id}?codigo=${outra.corpo.codigo}`)).status, 404);
    assert.equal((await t.api("GET", `/reservas/${id}?codigo=lixo`)).status, 404);
    assert.equal((await t.api("GET", `/reservas/${id}`)).status, 404);
  });

  test("antecedência mínima para cancelar", async () => {
    const perto = await t.reservar({ data: t.dia(2), horario: "18:00" });
    const longe = await t.reservar({ data: t.dia(5), horario: "18:00" });
    await t.configurar({ antecedencia_cancelamento_horas: 72 });
    try {
      const negado = await t.api("POST", `/reservas/${perto.corpo.id}/cancelar`, { codigo: perto.corpo.codigo });
      assert.equal(negado.status, 409);
      assert.match(negado.corpo.erro, /72 horas/);
      const consulta = await t.api("GET", `/reservas/${perto.corpo.id}?codigo=${perto.corpo.codigo}`);
      assert.equal(consulta.corpo.pode_cancelar, false);

      const ok = await t.api("POST", `/reservas/${longe.corpo.id}/cancelar`, { codigo: longe.corpo.codigo });
      assert.equal(ok.status, 200);
      // cancelada libera o horário
      assert.equal((await t.reservar({ data: t.dia(5), horario: "18:00" })).status, 201);
      // cancelar de novo: já não está confirmada
      assert.equal((await t.api("POST", `/reservas/${longe.corpo.id}/cancelar`, { codigo: longe.corpo.codigo })).status, 409);
    } finally {
      await t.configurar({ antecedencia_cancelamento_horas: 0 });
    }
  });

  test("remarcar troca o horário numa transação só", async () => {
    const tel = t.telefone();
    const antiga = await t.reservar({ data: t.dia(8), horario: "10:00", tel });
    const ocupada = await t.reservar({ data: t.dia(8), horario: "14:00" });
    assert.equal(ocupada.status, 201);

    // novo horário ocupado: falha e a antiga continua confirmada
    const falha = await t.reservar({
      data: t.dia(8), horario: "14:00", tel, extra: { remarcar: { id: antiga.corpo.id, codigo: antiga.corpo.codigo } },
    });
    assert.equal(falha.status, 409);
    const ainda = await t.api("GET", `/reservas/${antiga.corpo.id}?codigo=${antiga.corpo.codigo}`);
    assert.equal(ainda.corpo.status, "confirmada");

    const nova = await t.reservar({
      data: t.dia(8), horario: "11:00", tel, extra: { remarcar: { id: antiga.corpo.id, codigo: antiga.corpo.codigo } },
    });
    assert.equal(nova.status, 201);
    assert.equal(nova.corpo.remarcada, true);
    const velha = await t.api("GET", `/reservas/${antiga.corpo.id}?codigo=${antiga.corpo.codigo}`);
    assert.equal(velha.corpo.status, "cancelada");
  });

  test("o mesmo WhatsApp não acumula mais reservas que o limite", async () => {
    const tel = t.telefone();
    for (const h of ["06:00", "07:00", "08:00"]) {
      assert.equal((await t.reservar({ data: t.dia(9), horario: h, tel })).status, 201);
    }
    const quarta = await t.reservar({ data: t.dia(9), horario: "09:00", tel });
    assert.equal(quarta.status, 409);
    assert.match(quarta.corpo.erro, /WhatsApp/);
  });

  test("telefone sem 9º dígito é recusado", async () => {
    assert.equal((await t.reservar({ data: t.dia(10), horario: "10:00", tel: "4733330000" })).status, 400);
  });
});
