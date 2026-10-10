import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calcularHorariosLivres, paraMinutos as m, paraHHMM, recortarDia, unirPeriodos, dentroDoFuncionamento,
} from "../src/agenda.js";

// segunda: 17:00–23:00 (exemplo do seed)
const SEMANA = [{ ini: m("17:00"), fim: m("23:00") }];
const horas = (lista) => lista.map(paraHHMM);

test("converte horários, inclusive 24:00", () => {
  assert.equal(m("20:30"), 1230);
  assert.equal(m("20:30:00"), 1230);
  assert.equal(m("24:00"), 1440);
  assert.equal(paraHHMM(1230), "20:30");
  assert.equal(paraHHMM(1440), "24:00");
});

test("1h de 30 em 30 min: de 17:00 até 22:00, sem passar do fechamento", () => {
  const livres = horas(calcularHorariosLivres({ turnos: SEMANA, ocupados: [], duracao: 60, intervalo: 30 }));
  assert.equal(livres[0], "17:00");
  assert.ok(livres.includes("17:30"));
  assert.equal(livres.at(-1), "22:00");
});

test("2h não começa depois das 21:00", () => {
  const livres = horas(calcularHorariosLivres({ turnos: SEMANA, ocupados: [], duracao: 120, intervalo: 30 }));
  assert.equal(livres.at(-1), "21:00");
});

test("ocupado 20:00–21:00 tira os horários que batem, mas não os que encostam", () => {
  const ocupados = [{ ini: m("20:00"), fim: m("21:00") }];
  const livres = horas(calcularHorariosLivres({ turnos: SEMANA, ocupados, duracao: 60, intervalo: 30 }));
  assert.ok(livres.includes("19:00"));    // 19–20 encosta: pode
  assert.ok(!livres.includes("19:30"));   // 19:30–20:30 bate
  assert.ok(!livres.includes("20:30"));
  assert.ok(livres.includes("21:00"));    // 21–22 encosta: pode
});

test("antecedência mínima esconde o que começa cedo demais", () => {
  const livres = horas(calcularHorariosLivres({
    turnos: SEMANA, ocupados: [], duracao: 60, intervalo: 30, minimoInicio: m("19:10"),
  }));
  assert.equal(livres[0], "19:30");
});

test("bloqueio de vários dias é recortado em cada dia", () => {
  const bloqueio = [{ ini: m("20:00"), fim: 1440 + 1440 + m("10:00") }]; // dia 0 20h até dia 2 10h
  assert.deepEqual(recortarDia(bloqueio, 0), [{ ini: m("20:00"), fim: 1440 }]);
  assert.deepEqual(recortarDia(bloqueio, 1), [{ ini: 0, fim: 1440 }]);
  assert.deepEqual(recortarDia(bloqueio, 2), [{ ini: 0, fim: m("10:00") }]);
  assert.deepEqual(recortarDia(bloqueio, 3), []);
});

test("une períodos encostados para o site não revelar quantas reservas há", () => {
  const unidos = unirPeriodos([
    { ini: m("21:00"), fim: m("22:00") }, { ini: m("20:00"), fim: m("21:00") }, { ini: m("22:30"), fim: m("23:00") },
  ]);
  assert.deepEqual(unidos, [{ ini: m("20:00"), fim: m("22:00") }, { ini: m("22:30"), fim: m("23:00") }]);
});

test("confere se um período cabe no funcionamento", () => {
  assert.ok(dentroDoFuncionamento(SEMANA, m("21:00"), m("23:00")));
  assert.ok(!dentroDoFuncionamento(SEMANA, m("22:00"), m("23:30")));
  assert.ok(!dentroDoFuncionamento([], m("18:00"), m("19:00")));
});
