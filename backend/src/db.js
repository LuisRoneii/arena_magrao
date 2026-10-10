import pg from "pg";

// SUM() e COUNT() chegam como BIGINT, que o pg entrega como texto para não perder
// precisão. Somas de centavos de uma quadra cabem com folga num número do JS.
pg.types.setTypeParser(pg.types.builtins.INT8, (valor) => parseInt(valor, 10));

// DATE fica como texto "AAAA-MM-DD". Sem isso o pg cria um Date à meia-noite do fuso
// do servidor, e a data pode "voltar um dia" quando convertida.
pg.types.setTypeParser(pg.types.builtins.DATE, (valor) => valor);

if (!process.env.DATABASE_URL) {
  console.error("Faltou a variável DATABASE_URL. Copie .env.example para .env e preencha.");
  process.exit(1);
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

// Roda `fn` dentro de uma transação com um client só, como no remarcar da barbearia.
// Qualquer erro desfaz tudo (ROLLBACK) e é repassado para quem chamou.
export async function transacao(fn) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const resultado = await fn(db);
    await db.query("COMMIT");
    return resultado;
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}
