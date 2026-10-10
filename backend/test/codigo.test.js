import { test } from "node:test";
import assert from "node:assert/strict";
import { gerarCodigo, normalizarCodigo, formatarCodigo } from "../src/codigo.js";

test("gera 10 caracteres sem letras que confundem", () => {
  for (let i = 0; i < 500; i++) {
    assert.match(gerarCodigo(), /^[0-9A-HJKMNP-TV-Z]{10}$/);
  }
});

test("códigos não se repetem na prática", () => {
  const vistos = new Set(Array.from({ length: 5000 }, gerarCodigo));
  assert.equal(vistos.size, 5000);
});

test("perdoa minúsculas, hífen, espaço e I/L/O digitados", () => {
  assert.equal(normalizarCodigo("k7qm-2xpa-9f"), "K7QM2XPA9F");
  assert.equal(normalizarCodigo(" K7QM 2XPA 9F "), "K7QM2XPA9F");
  assert.equal(normalizarCodigo("ILO0-0000-00"), "1100000000");
});

test("recusa o que não pode ser código", () => {
  assert.equal(normalizarCodigo("K7QM2XPA9"), null);    // curto
  assert.equal(normalizarCodigo("K7QM2XPA9FU"), null);  // longo
  assert.equal(normalizarCodigo("K7QM2XPA9U"), null);   // U não existe
  assert.equal(normalizarCodigo(undefined), null);
  assert.equal(normalizarCodigo("' OR 1=1--"), null);
});

test("formata para mostrar", () => {
  assert.equal(formatarCodigo("K7QM2XPA9F"), "K7QM-2XPA-9F");
});
