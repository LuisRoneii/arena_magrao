// Cria (ou atualiza a senha de) uma conta do painel.
// Uso: npm run criar-admin
// Pergunta os dados no terminal. Rode uma vez para cada pessoa.

import "dotenv/config";
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { pool } from "../src/db.js";
import { gerarHashSenha } from "../src/autenticacao.js";

// lê as respostas linha a linha (funciona digitando ou colando várias de uma vez)
const rl = readline.createInterface({ input, terminal: false });
const linhas = [];
const esperando = [];
rl.on("line", (l) => (esperando.length ? esperando.shift()(l) : linhas.push(l)));
rl.on("close", () => esperando.splice(0).forEach((r) => r("")));
rl.question = (pergunta) => {
  output.write(pergunta);
  return linhas.length ? Promise.resolve(linhas.shift()) : new Promise((r) => esperando.push(r));
};

try {
  const slug = (await rl.question("Arena (slug) [arena-do-magrao]: ")).trim() || "arena-do-magrao";
  const { rows: [arena] } = await pool.query("SELECT id, nome FROM arenas WHERE slug = $1", [slug]);
  if (!arena) throw new Error(`Arena "${slug}" não encontrada. Rodou o seed.sql?`);
  console.log(`\n${arena.nome}`);

  const nome = (await rl.question("Nome da pessoa: ")).trim();
  const email = (await rl.question("E-mail de login: ")).trim().toLowerCase();
  const papel = ((await rl.question("Papel: dono ou funcionario [dono]: ")).trim() || "dono").toLowerCase();
  const senha = await rl.question("Senha (mínimo 10 caracteres): ");

  if (!nome || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Nome e e-mail válido são obrigatórios.");
  if (!["dono", "funcionario"].includes(papel)) throw new Error('Papel deve ser "dono" ou "funcionario".');
  if (senha.length < 10) throw new Error("A senha precisa ter pelo menos 10 caracteres.");

  const hash = await gerarHashSenha(senha);
  await pool.query(
    `INSERT INTO contas_admin (arena_id, nome, email, senha_hash, papel)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (arena_id, email)
     DO UPDATE SET nome = EXCLUDED.nome, senha_hash = EXCLUDED.senha_hash, papel = EXCLUDED.papel, ativo = TRUE`,
    [arena.id, nome, email, hash, papel]
  );
  console.log(`\nConta pronta (${papel}). Entre no painel com ${email}.`);
} catch (err) {
  console.error(`\nErro: ${err.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
  await pool.end();
}
