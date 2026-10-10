// Apoio aos testes de integração: banco de teste limpo + API rodando numa porta livre.
//
// Usa DATABASE_URL_TESTE do .env. O banco é APAGADO e recriado a cada arquivo de teste,
// por isso há duas travas: o nome do banco precisa ter "teste" e não pode ser o mesmo
// da DATABASE_URL. Sem DATABASE_URL_TESTE, os testes de integração são pulados.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

const urlTeste = process.env.DATABASE_URL_TESTE;
const nomeBanco = (url) => (url ? new URL(url).pathname.slice(1) : null);

export const pular = !urlTeste
  ? "defina DATABASE_URL_TESTE no backend/.env para rodar os testes de integração"
  : false;

if (urlTeste) {
  if (!/teste/i.test(nomeBanco(urlTeste)) || nomeBanco(urlTeste) === nomeBanco(process.env.DATABASE_URL)) {
    throw new Error('DATABASE_URL_TESTE precisa apontar para um banco só de testes (com "teste" no nome).');
  }
  process.env.DATABASE_URL = urlTeste;
}
process.env.LIMITES_DESLIGADOS = "1";
process.env.JWT_SEGREDO ||= "segredo-so-para-os-testes-automaticos-0123456789";

const SCHEMA = fileURLToPath(new URL("../../../database/schema.sql", import.meta.url));

// Arena de teste: aberta 24h todo dia, sem antecedência mínima.
// Preço: 00h–18h normal R$ 100/h; 18h–24h nobre R$ 150/h.
const SEED_TESTE = `
  INSERT INTO arenas (id, nome, slug, antecedencia_reserva_min, antecedencia_cancelamento_horas,
                      janela_reserva_dias, mensalidade_padrao_centavos, whatsapp)
  VALUES (1, 'Arena Teste', 'arena-teste', 0, 0, 30, 40000, '47999990000');
  INSERT INTO funcionamento (arena_id, dia_semana, hora_inicio, hora_fim)
  SELECT 1, d, '00:00', '24:00' FROM generate_series(0, 6) AS d;
  INSERT INTO faixas_preco (arena_id, dia_semana, hora_inicio, hora_fim, preco_hora_centavos, nobre)
  SELECT 1, d, '00:00'::time, '18:00'::time, 10000, FALSE FROM generate_series(0, 6) AS d
  UNION ALL
  SELECT 1, d, '18:00'::time, '24:00'::time, 15000, TRUE FROM generate_series(0, 6) AS d;
  SELECT setval('arenas_id_seq', 1);
`;

export async function iniciar() {
  const { pool } = await import("../../src/db.js");
  const { app } = await import("../../src/app.js");
  const { gerarHashSenha } = await import("../../src/autenticacao.js");

  await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  await pool.query(await readFile(SCHEMA, "utf8"));
  await pool.query(SEED_TESTE);

  const servidor = await new Promise((ok) => {
    const s = app.listen(0, () => ok(s));
  });
  const base = `http://127.0.0.1:${servidor.address().port}/api/arena-teste`;
  const { rows: [{ hoje }] } = await pool.query(
    "SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS hoje"
  );

  async function api(metodo, caminho, corpo, token) {
    const resp = await fetch(base + caminho, {
      method: metodo,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const texto = await resp.text();
    return { status: resp.status, corpo: texto ? JSON.parse(texto) : null };
  }

  // data de hoje + n dias, no fuso da Arena
  function dia(n) {
    const [a, m, d] = hoje.split("-").map(Number);
    return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
  }
  const diaSemana = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();

  // celular válido e diferente a cada chamada (o limite por WhatsApp não atrapalha os testes)
  let seq = 10_000_000;
  const telefone = () => `4799${String(seq++).slice(-7)}`;

  async function reservar({ data, horario, duracao_min = 60, nome = "Jogador Teste", tel = telefone(), extra = {} }) {
    return api("POST", "/reservas", {
      data, horario, duracao_min, nome, telefone: tel, aceite_privacidade: true, ...extra,
    });
  }

  async function login(papel = "dono") {
    const email = `${papel}-${seq++}@teste.com`;
    await pool.query(
      `INSERT INTO contas_admin (arena_id, nome, email, senha_hash, papel) VALUES (1, $1, $2, $3, $4)`,
      [`Conta ${papel}`, email, await gerarHashSenha("senha-de-teste-123"), papel]
    );
    const r = await api("POST", "/admin/login", { email, senha: "senha-de-teste-123" });
    if (r.status !== 200) throw new Error(`login falhou: ${JSON.stringify(r.corpo)}`);
    return r.corpo.token;
  }

  async function configurar(campos) {
    const sets = Object.keys(campos).map((c, i) => `${c} = $${i + 1}`).join(", ");
    await pool.query(`UPDATE arenas SET ${sets} WHERE id = 1`, Object.values(campos));
  }

  async function fechar() {
    await new Promise((ok) => servidor.close(ok));
    await pool.end();
  }

  return { api, pool, hoje, dia, diaSemana, telefone, reservar, login, configurar, fechar };
}
