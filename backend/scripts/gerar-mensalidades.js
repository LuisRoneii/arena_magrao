// Gera as mensalidades do mês para os mensalistas ativos.
// Uso: npm run gerar-mensalidades            (mês atual, no fuso da Arena)
//      npm run gerar-mensalidades 2026-11    (mês informado)
// Pode rodar quantas vezes quiser: o que já existe não é duplicado.
// Dá para agendar no cron do servidor (ex.: todo dia 1º às 6h), mas não é obrigatório:
// o painel tem o botão "Gerar mensalidades do mês", que faz a mesma coisa.

import "dotenv/config";
import { pool } from "../src/db.js";
import { mesValido } from "../src/comum.js";
import { gerarMensalidades } from "../src/mensalidades.js";

const SLUG = process.env.ARENA_SLUG || "arena-do-magrao";

try {
  const { rows: [arena] } = await pool.query(
    "SELECT id, nome, fuso_horario FROM arenas WHERE slug = $1", [SLUG]
  );
  if (!arena) throw new Error(`Arena "${SLUG}" não encontrada.`);

  let mes = process.argv[2];
  if (mes) {
    mesValido(mes);
  } else {
    const { rows: [r] } = await pool.query(
      "SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM') AS mes", [arena.fuso_horario]
    );
    mes = r.mes;
  }

  const { criadas, ja_existiam } = await gerarMensalidades(pool, arena.id, mes);
  console.log(`${arena.nome}, ${mes}: ${criadas} mensalidade(s) criada(s), ${ja_existiam} já existia(m).`);
} catch (err) {
  console.error(`Erro: ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
