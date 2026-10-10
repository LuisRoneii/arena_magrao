// Painel: login, papéis, bloqueios, reservas manuais, pagamento, faturamento e configurações.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { pular, iniciar } from "./ajuda.js";

describe("painel", { skip: pular }, () => {
  let t;
  let dono;
  let funcionario;
  before(async () => {
    t = await iniciar();
    dono = await t.login("dono");
    funcionario = await t.login("funcionario");
  });
  after(async () => { await t?.fechar(); });

  test("rotas do painel exigem login", async () => {
    for (const [metodo, rota] of [
      ["GET", "/admin/agenda"], ["GET", "/admin/contratos"], ["GET", "/admin/mensalidades"],
      ["POST", "/admin/reservas"], ["POST", "/admin/bloqueios"], ["GET", "/admin/faturamento?mes=2026-10"],
      ["GET", "/admin/configuracoes"], ["PATCH", "/admin/mensalidades/1"],
    ]) {
      const r = await t.api(metodo, rota, metodo === "GET" ? undefined : {});
      assert.equal(r.status, 401, `${metodo} ${rota}`);
    }
    assert.equal((await t.api("GET", "/admin/agenda", undefined, "token-falso")).status, 401);
  });

  test("login: senha errada e e-mail inexistente têm a mesma resposta", async () => {
    const a = await t.api("POST", "/admin/login", { email: "ninguem@teste.com", senha: "x" });
    const { rows: [conta] } = await t.pool.query("SELECT email FROM contas_admin LIMIT 1");
    const b = await t.api("POST", "/admin/login", { email: conta.email, senha: "senha-errada" });
    assert.equal(a.status, 401);
    assert.deepEqual(a.corpo, b.corpo);
  });

  test("funcionário não vê faturamento nem configurações; dono vê", async () => {
    assert.equal((await t.api("GET", "/admin/faturamento?mes=2026-10", undefined, funcionario)).status, 403);
    assert.equal((await t.api("GET", "/admin/configuracoes", undefined, funcionario)).status, 403);
    assert.equal((await t.api("PUT", "/admin/configuracoes", {}, funcionario)).status, 403);
    // mas usa a agenda e as mensalidades normalmente (trabalha na beira da quadra)
    assert.equal((await t.api("GET", "/admin/agenda", undefined, funcionario)).status, 200);
    assert.equal((await t.api("GET", "/admin/mensalidades", undefined, funcionario)).status, 200);

    assert.equal((await t.api("GET", "/admin/faturamento?mes=2026-10", undefined, dono)).status, 200);
    assert.equal((await t.api("GET", "/admin/configuracoes", undefined, dono)).status, 200);
    const sessao = await t.api("GET", "/admin/sessao", undefined, funcionario);
    assert.equal(sessao.corpo.papel, "funcionario");
    assert.equal(sessao.corpo.hoje, t.hoje);
  });

  test("bloqueio tira o horário da agenda e não aceita reserva por cima", async () => {
    const b = await t.api("POST", "/admin/bloqueios",
      { data_inicio: t.dia(5), hora_inicio: "08:00", hora_fim: "12:00", motivo: "Manutenção do gramado" }, dono);
    assert.equal(b.status, 201, JSON.stringify(b.corpo));
    assert.equal((await t.reservar({ data: t.dia(5), horario: "10:00" })).status, 409);
    assert.equal((await t.reservar({ data: t.dia(5), horario: "12:00" })).status, 201);

    const lista = await t.api("GET", "/admin/bloqueios", undefined, dono);
    assert.ok(lista.corpo.some((x) => x.id === b.corpo.id && x.motivo === "Manutenção do gramado"));

    // remover o bloqueio libera de novo
    assert.equal((await t.api("DELETE", `/admin/bloqueios/${b.corpo.id}`, undefined, dono)).status, 204);
    assert.equal((await t.reservar({ data: t.dia(5), horario: "10:00" })).status, 201);
  });

  test("bloqueio sobre reservas: 409 com a lista; com liberar_mensalistas, o mensalista vira exceção", async () => {
    const data = t.dia(6);
    const avulsa = await t.reservar({ data, horario: "15:00", nome: "Cliente do Torneio" });
    const c = await t.api("POST", "/admin/contratos", {
      nome: "Mensalista Torneio", telefone: t.telefone(), dia_semana: t.diaSemana(data), hora_inicio: "19:00",
      duracao_min: 60, dia_vencimento: 10,
    }, dono);
    assert.equal(c.status, 201);

    const negado = await t.api("POST", "/admin/bloqueios", { data_inicio: data, motivo: "Torneio" }, dono);
    assert.equal(negado.status, 409);
    const origens = negado.corpo.conflitos.map((x) => x.origem).sort();
    assert.deepEqual(origens, ["mensalista", "site"]);
    assert.ok(negado.corpo.conflitos.some((x) => x.nome === "Cliente do Torneio" && x.telefone));

    // o dono cancela a avulsa e libera o mensalista no mesmo pedido do bloqueio
    assert.equal((await t.api("PATCH", `/admin/reservas/${avulsa.corpo.id}`, { acao: "cancelar" }, dono)).status, 200);
    const ok = await t.api("POST", "/admin/bloqueios",
      { data_inicio: data, motivo: "Torneio", liberar_mensalistas: true }, dono);
    assert.equal(ok.status, 201, JSON.stringify(ok.corpo));

    const agenda = await t.api("GET", `/admin/agenda?inicio=${data}&dias=1`, undefined, dono);
    const oc = agenda.corpo.reservas.find((x) => x.origem === "mensalista");
    assert.equal(oc.status, "liberada");
    assert.equal(oc.motivo, "Bloqueio: Torneio");
    // semana seguinte o mensalista joga normalmente
    assert.equal((await t.reservar({ data: t.dia(13), horario: "19:00" })).status, 409);
  });

  test("reserva manual, pagamento, remarcar e valor", async () => {
    const nova = await t.api("POST", "/admin/reservas",
      { data: t.dia(7), horario: "20:00", duracao_min: 90, nome: "Cliente no balcão" }, funcionario);
    assert.equal(nova.status, 201, JSON.stringify(nova.corpo));
    assert.equal(nova.corpo.valor_centavos, 22500); // 1h30 nobre
    assert.equal(nova.corpo.codigo, null);          // sem WhatsApp, sem código

    const id = nova.corpo.id;
    const pago = await t.api("PATCH", `/admin/reservas/${id}`, { acao: "pagar", forma_pagamento: "dinheiro" }, funcionario);
    assert.equal(pago.status, 200);
    assert.equal(pago.corpo.pago, true);
    assert.equal(pago.corpo.pago_em, t.hoje);
    assert.equal((await t.api("PATCH", `/admin/reservas/${id}`, { acao: "pagar", forma_pagamento: "cheque" }, dono)).status, 400);

    // remarcar para horário normal: já paga, o valor combinado fica
    const rem = await t.api("PATCH", `/admin/reservas/${id}`,
      { acao: "remarcar", data: t.dia(7), horario: "08:00", duracao_min: 60 }, dono);
    assert.equal(rem.status, 200, JSON.stringify(rem.corpo));
    assert.equal(rem.corpo.inicio, "08:00");
    assert.equal(rem.corpo.valor_centavos, 22500);

    // remarcar por cima de outra reserva: 409
    await t.reservar({ data: t.dia(7), horario: "10:00" });
    assert.equal((await t.api("PATCH", `/admin/reservas/${id}`,
      { acao: "remarcar", data: t.dia(7), horario: "09:30", duracao_min: 60 }, dono)).status, 409);

    const desconto = await t.api("PATCH", `/admin/reservas/${id}`, { acao: "valor", valor_centavos: 20000 }, dono);
    assert.equal(desconto.corpo.valor_centavos, 20000);
  });

  test("faturamento separa avulso e mensalidades, com previsto, recebido e em aberto", async () => {
    // mês de uma data sem nada, para os números serem previsíveis
    const data = t.dia(25);
    const mes = data.slice(0, 7);
    const antes = (await t.api("GET", `/admin/faturamento?mes=${mes}`, undefined, dono)).corpo;

    const r1 = await t.api("POST", "/admin/reservas", { data, horario: "09:00", duracao_min: 60, nome: "Ana" }, dono);
    const r2 = await t.api("POST", "/admin/reservas", { data, horario: "10:00", duracao_min: 60, nome: "Bia" }, dono);
    assert.equal(r1.status, 201, JSON.stringify(r1.corpo));
    assert.equal(r2.status, 201, JSON.stringify(r2.corpo));
    await t.api("PATCH", `/admin/reservas/${r1.corpo.id}`, { acao: "pagar", forma_pagamento: "pix" }, dono);

    const f = (await t.api("GET", `/admin/faturamento?mes=${mes}`, undefined, dono)).corpo;
    assert.equal(f.avulso.previsto_centavos - antes.avulso.previsto_centavos, 20000);
    assert.equal(f.avulso.recebido_centavos - antes.avulso.recebido_centavos, 10000);
    assert.equal(f.avulso.em_aberto_centavos - antes.avulso.em_aberto_centavos, 10000);
    assert.equal(f.avulso.por_forma.pix - antes.avulso.por_forma.pix, 10000);
    assert.ok("mensalidades" in f && "atrasado_centavos" in f.mensalidades);
    assert.equal(f.total.previsto_centavos, f.avulso.previsto_centavos + f.mensalidades.previsto_centavos);
    assert.equal((await t.api("GET", "/admin/faturamento?mes=10-2026", undefined, dono)).status, 400);
  });

  test("configurações: salva tudo junto e recusa faixa de preço faltando ou sobreposta", async () => {
    const atual = (await t.api("GET", "/admin/configuracoes", undefined, dono)).corpo;
    assert.equal(atual.funcionamento.length, 7);

    const semPreco = await t.api("PUT", "/admin/configuracoes", {
      ...atual,
      funcionamento: [{ dia_semana: 1, inicio: "17:00", fim: "23:00" }],
      faixas_preco: [{ dia_semana: 1, inicio: "18:00", fim: "23:00", preco_hora_centavos: 15000, nobre: true }],
    }, dono);
    assert.equal(semPreco.status, 400);
    assert.match(semPreco.corpo.erro, /segunda.*17:00–18:00/);

    const sobreposta = await t.api("PUT", "/admin/configuracoes", {
      ...atual,
      funcionamento: [{ dia_semana: 1, inicio: "17:00", fim: "23:00" }],
      faixas_preco: [
        { dia_semana: 1, inicio: "17:00", fim: "20:00", preco_hora_centavos: 12000 },
        { dia_semana: 1, inicio: "19:00", fim: "23:00", preco_hora_centavos: 15000, nobre: true },
      ],
    }, dono);
    assert.equal(sobreposta.status, 400);
    assert.match(sobreposta.corpo.erro, /sobrepostas/);

    // nada mudou depois das tentativas que falharam (transação desfeita)
    const depois = (await t.api("GET", "/admin/configuracoes", undefined, dono)).corpo;
    assert.deepEqual(depois.funcionamento, atual.funcionamento);

    const salvo = await t.api("PUT", "/admin/configuracoes", {
      arena: { ...atual.arena, whatsapp: "(47) 98888-7777", instagram: "@arena_do_magrao", janela_reserva_dias: 20 },
      funcionamento: atual.funcionamento,
      faixas_preco: atual.faixas_preco,
    }, dono);
    assert.equal(salvo.status, 200, JSON.stringify(salvo.corpo));
    assert.equal(salvo.corpo.arena.whatsapp, "47988887777");
    assert.equal(salvo.corpo.arena.instagram, "arena_do_magrao");
    assert.equal((await t.api("GET", "/info")).corpo.janela_reserva_dias, 20);
  });
});
