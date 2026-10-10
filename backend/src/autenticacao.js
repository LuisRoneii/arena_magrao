// Login do painel: senha com bcrypt e sessão com token JWT (igual à barbearia).
//
// 1. O painel manda e-mail e senha para POST /api/:slug/admin/login.
// 2. A API confere a senha com o hash guardado em contas_admin.
// 3. Se bater, devolve um token assinado com JWT_SEGREDO, válido por 12 horas.
// 4. O painel guarda o token no sessionStorage e manda em toda requisição:
//    "Authorization: Bearer <token>".
// 5. exigirLogin() confere a assinatura e a arena; exigirPapel() confere o papel.

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { ErroHttp } from "./erros.js";

const VALIDADE_TOKEN = "12h";

function segredo() {
  const s = process.env.JWT_SEGREDO;
  if (!s || s.length < 32) {
    throw new Error("Defina JWT_SEGREDO no .env com pelo menos 32 caracteres (veja .env.example).");
  }
  return s;
}

export async function gerarHashSenha(senha) {
  return bcrypt.hash(senha, 10);
}

export async function senhaConfere(senha, hash) {
  return bcrypt.compare(senha, hash);
}

// hash de uma senha qualquer: compara com ele quando o e-mail não existe, para a
// resposta demorar o mesmo e não entregar quais e-mails têm conta
const HASH_FALSO = bcrypt.hashSync("senha-que-nao-existe", 10);
export async function senhaConfereOuFinge(senha, hash) {
  return bcrypt.compare(senha, hash ?? HASH_FALSO).then((ok) => ok && !!hash);
}

export function gerarToken(conta) {
  return jwt.sign(
    { sub: conta.id, arena_id: conta.arena_id, papel: conta.papel, nome: conta.nome },
    segredo(),
    { expiresIn: VALIDADE_TOKEN, algorithm: "HS256" }
  );
}

// middleware: só passa quem mandou um token válido desta arena
export function exigirLogin(req, res, next) {
  const [tipo, token] = String(req.headers.authorization || "").split(" ");
  if (tipo !== "Bearer" || !token) {
    throw new ErroHttp(401, "Faça login para continuar.");
  }
  let dados;
  try {
    dados = jwt.verify(token, segredo(), { algorithms: ["HS256"] });
  } catch (e) {
    throw new ErroHttp(401, "Sessão expirada. Entre de novo.");
  }
  if (dados.arena_id !== req.arena.id) {
    throw new ErroHttp(403, "Sem acesso a esta arena.");
  }
  req.conta = dados;
  next();
}

// middleware: só para o papel informado (ex.: faturamento e configurações = "dono")
export function exigirPapel(...papeis) {
  return (req, res, next) => {
    if (!papeis.includes(req.conta?.papel)) {
      throw new ErroHttp(403, "Sua conta não tem acesso a esta área.");
    }
    next();
  };
}
