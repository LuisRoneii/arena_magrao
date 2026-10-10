// Código da reserva: 10 caracteres Crockford base32, ex.: K7QM-2XPA-9F.
// Sem I, L, O e U (confundem com 1, 0 e V). 32 símbolos × 10 = 50 bits aleatórios.
// Sozinho ele não abre nada: a consulta exige o número da reserva + o código,
// e a rota tem limite de tentativas por IP (limiteConsulta).

import { randomBytes } from "node:crypto";

const ALFABETO = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const TAMANHO_CODIGO = 10;

export function gerarCodigo() {
  // 256 é múltiplo de 32: "byte & 31" sorteia cada símbolo com a mesma chance
  return Array.from(randomBytes(TAMANHO_CODIGO), (b) => ALFABETO[b & 31]).join("");
}

// O que a pessoa digitou -> forma guardada no banco, ou null se não tem como ser um código.
// Perdoa minúsculas, hífens, espaços e as letras que se confundem (I/L -> 1, O -> 0).
export function normalizarCodigo(texto) {
  const limpo = String(texto ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  const valido = limpo.length === TAMANHO_CODIGO && [...limpo].every((c) => ALFABETO.includes(c));
  return valido ? limpo : null;
}

// "K7QM2XPA9F" -> "K7QM-2XPA-9F" (só para mostrar)
export function formatarCodigo(codigo) {
  return codigo ? `${codigo.slice(0, 4)}-${codigo.slice(4, 8)}-${codigo.slice(8)}` : null;
}
