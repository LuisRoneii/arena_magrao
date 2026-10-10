import { test } from "node:test";
import assert from "node:assert/strict";
import { competenciaDe, vencimentoDe, situacaoDe } from "../src/mensalidades.js";

test("competência é o dia 1 do mês", () => {
  assert.equal(competenciaDe("2026-10"), "2026-10-01");
});

test("vencimento no dia escolhido do mês da competência", () => {
  assert.equal(vencimentoDe("2026-10-01", 10), "2026-10-10");
  assert.equal(vencimentoDe("2027-02-01", 5), "2027-02-05");
});

test("atrasada = pendente com vencimento antes de hoje", () => {
  assert.equal(situacaoDe({ status: "pendente", vencimento: "2026-10-09" }, "2026-10-10"), "atrasada");
  assert.equal(situacaoDe({ status: "pendente", vencimento: "2026-10-10" }, "2026-10-10"), "pendente"); // vence hoje
  assert.equal(situacaoDe({ status: "paga", vencimento: "2026-10-01" }, "2026-10-10"), "paga");
  assert.equal(situacaoDe({ status: "cancelada", vencimento: "2026-10-01" }, "2026-10-10"), "cancelada");
});
