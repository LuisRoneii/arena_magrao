import { test } from "node:test";
import assert from "node:assert/strict";
import { calcularPreco, trechosSemPreco } from "../src/precos.js";
import { paraMinutos as m } from "../src/agenda.js";

// semana: 17–19 normal R$ 120/h, 19–23 nobre R$ 160/h
const FAIXAS = [
  { ini: m("17:00"), fim: m("19:00"), preco_hora_centavos: 12000, nobre: false },
  { ini: m("19:00"), fim: m("23:00"), preco_hora_centavos: 16000, nobre: true },
];

test("1h no horário normal", () => {
  assert.deepEqual(calcularPreco(FAIXAS, m("17:00"), m("18:00")), { valor_centavos: 12000, nobre: false });
});

test("1h no horário nobre", () => {
  assert.deepEqual(calcularPreco(FAIXAS, m("20:00"), m("21:00")), { valor_centavos: 16000, nobre: true });
});

test("1h30 e 2h cobram proporcional à duração", () => {
  assert.equal(calcularPreco(FAIXAS, m("17:00"), m("18:30")).valor_centavos, 18000);
  assert.equal(calcularPreco(FAIXAS, m("20:00"), m("22:00")).valor_centavos, 32000);
});

test("1h30 que cruza do normal para o nobre paga cada parte pelo seu preço", () => {
  // 17:30–19:00: tudo normal
  assert.deepEqual(calcularPreco(FAIXAS, m("17:30"), m("19:00")), { valor_centavos: 18000, nobre: false });
  // 18:30–20:00: 30 min normal (R$ 60) + 60 min nobre (R$ 160)
  assert.deepEqual(calcularPreco(FAIXAS, m("18:30"), m("20:00")), { valor_centavos: 22000, nobre: true });
});

test("arredonda para o centavo", () => {
  const faixa = [{ ini: 0, fim: 1440, preco_hora_centavos: 10001, nobre: false }];
  assert.equal(calcularPreco(faixa, 0, 90).valor_centavos, 15002); // 15001,5 -> 15002
});

test("sem faixa para algum minuto: não inventa preço", () => {
  assert.equal(calcularPreco(FAIXAS, m("22:30"), m("23:30")), null);
});

test("aponta os trechos de funcionamento sem preço", () => {
  const turnos = [{ ini: m("16:00"), fim: m("23:00") }];
  assert.deepEqual(trechosSemPreco(turnos, FAIXAS), [{ ini: m("16:00"), fim: m("17:00") }]);
  assert.deepEqual(trechosSemPreco([{ ini: m("17:00"), fim: m("23:00") }], FAIXAS), []);
});
