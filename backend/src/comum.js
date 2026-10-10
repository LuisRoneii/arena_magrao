// Peças usadas pelas rotas públicas e pelas do painel.

import { pool } from "./db.js";
import { ErroHttp } from "./erros.js";

/* ---------------------------------------------------------------------
   Arena da URL: carrega uma vez e deixa em req.arena (com as configurações)
--------------------------------------------------------------------- */
export const CAMPOS_ARENA = `id, nome, slug, fuso_horario, whatsapp, instagram, endereco, link_mapa,
  pix_chave, antecedencia_reserva_min, antecedencia_cancelamento_horas, janela_reserva_dias,
  duracoes_permitidas, intervalo_grade_min, mensalidade_padrao_centavos, max_reservas_futuras`;

export async function carregarArena(req, res, next) {
  const { rows } = await pool.query(`SELECT ${CAMPOS_ARENA} FROM arenas WHERE slug = $1`, [req.params.slug]);
  if (!rows[0]) throw new ErroHttp(404, "Arena não encontrada.");
  req.arena = rows[0];
  next();
}

/* ---------------------------------------------------------------------
   Validações de entrada (toda rota valida no servidor, não só no formulário)
--------------------------------------------------------------------- */
export function idValido(valor, nome) {
  try {
    return inteiroValido(valor, nome, 1, 2147483647);
  } catch {
    throw new ErroHttp(400, `Campo "${nome}" inválido.`);
  }
}

export function dataValida(valor, nome = "data") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor ?? "")) {
    throw new ErroHttp(400, `Campo "${nome}" deve estar no formato AAAA-MM-DD.`);
  }
  const [a, m, d] = valor.split("-").map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || a < 2000) {
    throw new ErroHttp(400, `Campo "${nome}" não é uma data válida.`);
  }
  return valor;
}

export function mesValido(valor, nome = "mes") {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(valor ?? "")) {
    throw new ErroHttp(400, `Campo "${nome}" deve estar no formato AAAA-MM.`);
  }
  return valor;
}

// "HH:MM"; com fimDoDia, aceita também "24:00" (fechamento à meia-noite)
export function horarioValido(valor, nome = "horario", { fimDoDia = false } = {}) {
  const texto = String(valor ?? "");
  // aceita também "20:00:00", que é como o banco devolve um TIME
  const ok = /^([01]\d|2[0-3]):[0-5]\d(:00)?$/.test(texto) || (fimDoDia && /^24:00(:00)?$/.test(texto));
  if (!ok) throw new ErroHttp(400, `Campo "${nome}" deve estar no formato HH:MM.`);
  return texto.slice(0, 5);
}

export function textoValido(valor, nome, min, max) {
  const texto = String(valor ?? "").trim();
  if (texto.length < min || texto.length > max) {
    throw new ErroHttp(400, `Campo "${nome}" deve ter entre ${min} e ${max} caracteres.`);
  }
  return texto;
}

// texto opcional: vazio vira null
export function textoOpcional(valor, nome, max) {
  const texto = String(valor ?? "").trim();
  if (!texto) return null;
  return textoValido(texto, nome, 1, max);
}

export function inteiroValido(valor, nome, min, max) {
  // Number(null), Number("") e Number(false) dariam 0: só aceita número ou texto numérico
  const aceito = typeof valor === "number" || (typeof valor === "string" && /^-?\d+$/.test(valor.trim()));
  const n = aceito ? Number(valor) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ErroHttp(400, `Campo "${nome}" deve ser um número inteiro entre ${min} e ${max}.`);
  }
  return n;
}

// dinheiro chega sempre em centavos inteiros (R$ 150,00 = 15000)
export function centavosValido(valor, nome) {
  return inteiroValido(valor, nome, 0, 10_000_000);
}

export function diaSemanaValido(valor, nome = "dia_semana") {
  return inteiroValido(valor, nome, 0, 6);
}

export function duracaoValida(valor, arena) {
  const duracao = Number(valor);
  if (!arena.duracoes_permitidas.includes(duracao)) {
    const opcoes = arena.duracoes_permitidas.map(formatarDuracao).join(", ");
    throw new ErroHttp(400, `Duração inválida. Opções: ${opcoes}.`);
  }
  return duracao;
}

export const FORMAS_PAGAMENTO = ["pix", "dinheiro", "cartao"];

export function formaPagamentoValida(valor) {
  const forma = String(valor ?? "");
  if (!FORMAS_PAGAMENTO.includes(forma)) {
    throw new ErroHttp(400, `Campo "forma_pagamento" deve ser: ${FORMAS_PAGAMENTO.join(", ")}.`);
  }
  return forma;
}

// LGPD: o site só envia depois que a pessoa marca "li e aceito a política de privacidade"
export function aceiteValido(valor) {
  if (valor !== true) {
    throw new ErroHttp(400, "Para continuar, aceite a política de privacidade.");
  }
  return true;
}

/* ---------------------------------------------------------------------
   WhatsApp: celular brasileiro com DDD e 9º dígito.
   Aceita "(47) 99999-0000", "+55 47 99999-0000", "47999990000"...
   Devolve só os 11 dígitos, sem o 55: "47999990000".
--------------------------------------------------------------------- */
const DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

export function telefoneValido(valor, nome = "telefone") {
  let digitos = String(valor ?? "").replace(/\D/g, "");
  if (digitos.length === 13 && digitos.startsWith("55")) digitos = digitos.slice(2);
  const ok = digitos.length === 11 && DDDS.has(Number(digitos.slice(0, 2))) && digitos[2] === "9";
  if (!ok) {
    throw new ErroHttp(400, `Campo "${nome}": informe um celular com DDD, por exemplo (47) 99999-0000.`);
  }
  return digitos;
}

/* ---------------------------------------------------------------------
   Formatação
--------------------------------------------------------------------- */
// 90 -> "1h30"
export function formatarDuracao(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (!h) return `${m} min`;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

/* ---------------------------------------------------------------------
   Relógio: "agora" vem SEMPRE do banco, no fuso da Arena (nunca do cliente)
--------------------------------------------------------------------- */
export async function agoraNaArena(db, arena) {
  const { rows: [r] } = await db.query(
    `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS hoje,
            (EXTRACT(HOUR FROM now() AT TIME ZONE $1) * 60
             + EXTRACT(MINUTE FROM now() AT TIME ZONE $1))::int    AS minuto`,
    [arena.fuso_horario]
  );
  return r; // { hoje: "2026-10-10", minuto: 1234 }
}
