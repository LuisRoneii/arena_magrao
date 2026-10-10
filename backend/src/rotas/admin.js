// Rotas do painel dos donos. Todas ficam sob /api/:slug/admin e, com exceção do
// login, exigem o token (exigirLogin). Faturamento e configurações exigem o papel
// "dono" (exigirPapel, em admin-gestao.js).

import { Router } from "express";
import { pool } from "../db.js";
import { ErroHttp } from "../erros.js";
import { gerarToken, senhaConfereOuFinge, exigirLogin } from "../autenticacao.js";
import { agoraNaArena } from "../comum.js";
import { limiteLogin } from "../limites.js";
import { rotasAgenda } from "./admin-agenda.js";
import { rotasMensalistas } from "./admin-mensalistas.js";
import { rotasGestao } from "./admin-gestao.js";

export const rotasAdmin = Router({ mergeParams: true });

/* ---------------------------------------------------------------------
   POST /admin/login   { email, senha }  ->  { token, nome, papel }
--------------------------------------------------------------------- */
rotasAdmin.post("/login", limiteLogin, async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const senha = String(req.body?.senha ?? "");
  if (!email || !senha) throw new ErroHttp(400, "Informe e-mail e senha.");

  const { rows: [conta] } = await pool.query(
    `SELECT id, arena_id, nome, senha_hash, papel
       FROM contas_admin
      WHERE arena_id = $1 AND lower(email) = $2 AND ativo`,
    [req.arena.id, email]
  );
  // mesma mensagem (e mesmo tempo de resposta) para e-mail inexistente e senha errada
  if (!(await senhaConfereOuFinge(senha, conta?.senha_hash))) {
    throw new ErroHttp(401, "E-mail ou senha incorretos.");
  }

  res.json({ token: gerarToken(conta), nome: conta.nome, papel: conta.papel });
});

// daqui para baixo, tudo exige login
rotasAdmin.use(exigirLogin);

/* ---------------------------------------------------------------------
   GET /admin/sessao -> quem está logado e a data de hoje no fuso da Arena
   (o painel não usa o relógio do celular para decidir "hoje")
--------------------------------------------------------------------- */
rotasAdmin.get("/sessao", async (req, res) => {
  const agora = await agoraNaArena(pool, req.arena);
  res.json({ nome: req.conta.nome, papel: req.conta.papel, hoje: agora.hoje, minuto: agora.minuto });
});

rotasAdmin.use(rotasAgenda);
rotasAdmin.use(rotasMensalistas);
rotasAdmin.use(rotasGestao);
