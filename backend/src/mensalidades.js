// Mensalidades dos mensalistas: regras puras + geração idempotente no banco.
//
// - Uma por contrato por mês (UNIQUE (contrato_id, competencia) no banco).
// - Valor fixo por mês: mês com 5 quartas custa o mesmo que mês com 4.
// - "Atrasada" não é gravada: é pendente com vencimento já passado.

// "2026-10" -> "2026-10-01"
export function competenciaDe(mes) {
  return `${mes}-01`;
}

// competência "2026-10-01" + dia 10 -> "2026-10-10" (dia_vencimento vai de 1 a 28)
export function vencimentoDe(competencia, diaVencimento) {
  return `${competencia.slice(0, 8)}${String(diaVencimento).padStart(2, "0")}`;
}

// situação mostrada no painel: pendente | atrasada | paga | cancelada
export function situacaoDe({ status, vencimento }, hoje) {
  if (status === "pendente" && vencimento < hoje) return "atrasada";
  return status;
}

/**
 * Gera as mensalidades do mês para os contratos ativos que valem naquele mês.
 * Pode rodar quantas vezes quiser: o ON CONFLICT não deixa duplicar.
 * Contrato pausado não gera (o dono decide se cobra).
 * @returns {{competencia:string, criadas:number, ja_existiam:number}}
 */
export async function gerarMensalidades(db, arenaId, mes) {
  const competencia = competenciaDe(mes);

  const { rows: [{ total }] } = await db.query(
    `SELECT count(*) AS total
       FROM contratos_mensalistas
      WHERE arena_id = $1 AND status = 'ativo'
        AND data_inicio < ($2::date + interval '1 month')
        AND (data_fim IS NULL OR data_fim >= $2::date)`,
    [arenaId, competencia]
  );

  const { rowCount: criadas } = await db.query(
    `INSERT INTO mensalidades (arena_id, contrato_id, competencia, valor_centavos, vencimento)
     SELECT c.arena_id, c.id, $2::date, c.valor_mensal_centavos, $2::date + (c.dia_vencimento - 1)
       FROM contratos_mensalistas c
      WHERE c.arena_id = $1 AND c.status = 'ativo'
        AND c.data_inicio < ($2::date + interval '1 month')
        AND (c.data_fim IS NULL OR c.data_fim >= $2::date)
     ON CONFLICT (contrato_id, competencia) DO NOTHING`,
    [arenaId, competencia]
  );

  return { competencia, criadas, ja_existiam: total - criadas };
}
