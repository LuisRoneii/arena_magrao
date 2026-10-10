import { test } from "node:test";
import assert from "node:assert/strict";

// comum.js importa o db.js, que exige DATABASE_URL (só importar não conecta)
process.env.DATABASE_URL ??= "postgres://ninguem@localhost:1/nada";
const { telefoneValido, horarioValido, dataValida, duracaoValida, formatarDuracao, centavosValido, aceiteValido } =
  await import("../src/comum.js");

test("telefone: celular BR com DDD e 9º dígito, guardado com 11 dígitos", () => {
  assert.equal(telefoneValido("(47) 99999-0000"), "47999990000");
  assert.equal(telefoneValido("+55 47 99999-0000"), "47999990000");
  assert.equal(telefoneValido("47999990000"), "47999990000");
});

test("telefone: recusa fixo, sem 9º dígito, DDD inexistente e lixo", () => {
  for (const t of ["(47) 3333-0000", "4799990000", "(20) 99999-0000", "(10) 99999-0000", "99999-0000", "abc", "", null]) {
    assert.throws(() => telefoneValido(t), { status: 400 }, String(t));
  }
});

test("horário: HH:MM, aceita o formato do banco e 24:00 só quando pedido", () => {
  assert.equal(horarioValido("20:30"), "20:30");
  assert.equal(horarioValido("20:30:00"), "20:30");
  assert.equal(horarioValido("24:00", "hora_fim", { fimDoDia: true }), "24:00");
  for (const h of ["24:00", "20:60", "8:00", "20:00abc", "20:00:30", ""]) {
    assert.throws(() => horarioValido(h), { status: 400 }, h);
  }
});

test("data: AAAA-MM-DD e que exista no calendário", () => {
  assert.equal(dataValida("2026-02-28"), "2026-02-28");
  for (const d of ["2026-02-30", "2026-13-01", "26-01-01", "2026-1-1", ""]) {
    assert.throws(() => dataValida(d), { status: 400 }, d);
  }
});

test("duração: só as permitidas pela Arena", () => {
  const arena = { duracoes_permitidas: [60, 90, 120] };
  assert.equal(duracaoValida(90, arena), 90);
  assert.equal(duracaoValida("120", arena), 120);
  assert.throws(() => duracaoValida(45, arena), /1h, 1h30, 2h/);
});

test("centavos: só inteiro não negativo", () => {
  assert.equal(centavosValido(15000, "valor"), 15000);
  for (const v of [150.5, -1, "abc", null]) assert.throws(() => centavosValido(v, "valor"), { status: 400 });
});

test("aceite da privacidade precisa ser true", () => {
  assert.equal(aceiteValido(true), true);
  for (const v of [false, "true", 1, undefined]) assert.throws(() => aceiteValido(v), { status: 400 });
});

test("formata duração", () => {
  assert.equal(formatarDuracao(60), "1h");
  assert.equal(formatarDuracao(90), "1h30");
  assert.equal(formatarDuracao(30), "30 min");
});
