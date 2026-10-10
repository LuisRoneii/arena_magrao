// Preço de uma reserva pelas faixas de preço do dia (lógica pura, testável).
//
// Cada minuto custa preco_hora_centavos / 60 da faixa em que está. Assim uma
// reserva das 18:30 às 20:00, com o nobre começando às 19:00, paga 30 minutos
// do preço normal e 60 do nobre. O total é arredondado para o centavo.

/**
 * @param {{ini:number, fim:number, preco_hora_centavos:number, nobre:boolean}[]} faixas  faixas do dia
 * @param {number} ini  início em minutos do dia
 * @param {number} fim  fim em minutos do dia
 * @returns {{valor_centavos:number, nobre:boolean} | null}  null se algum minuto não tem faixa
 */
export function calcularPreco(faixas, ini, fim) {
  let soma = 0;        // centavos × minutos (inteiro: divide por 60 só no final)
  let cobertos = 0;
  let nobre = false;
  for (const f of faixas) {
    const minutos = Math.min(fim, f.fim) - Math.max(ini, f.ini);
    if (minutos <= 0) continue;
    soma += minutos * f.preco_hora_centavos;
    cobertos += minutos;
    if (f.nobre) nobre = true;
  }
  if (cobertos !== fim - ini) return null; // configuração incompleta: não dá preço errado
  return { valor_centavos: Math.round(soma / 60), nobre };
}

/**
 * As faixas cobrem todo o funcionamento do dia? Usado ao salvar as configurações.
 * Devolve os trechos de funcionamento sem preço (lista vazia = tudo certo).
 */
export function trechosSemPreco(turnos, faixas) {
  const faltando = [];
  for (const t of turnos) {
    // percorre o turno pulando de faixa em faixa
    let cursor = t.ini;
    const ordenadas = faixas.filter((f) => f.fim > t.ini && f.ini < t.fim).sort((a, b) => a.ini - b.ini);
    for (const f of ordenadas) {
      if (f.ini > cursor) faltando.push({ ini: cursor, fim: f.ini });
      cursor = Math.max(cursor, f.fim);
    }
    if (cursor < t.fim) faltando.push({ ini: cursor, fim: t.fim });
  }
  return faltando;
}
