// Lógica pura de horários (sem banco), para ser fácil de testar.
// Tudo trabalha em "minutos desde a meia-noite" no horário local da Arena
// (o Brasil não tem horário de verão desde 2019, então todo dia tem 1440 minutos).

export const MINUTOS_DIA = 24 * 60;

// "09:30" ou "09:30:00" -> 570; "24:00" -> 1440
export function paraMinutos(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

// 570 -> "09:30"; 1440 -> "24:00"
export function paraHHMM(minutos) {
  const h = String(Math.floor(minutos / 60)).padStart(2, "0");
  const m = String(minutos % 60).padStart(2, "0");
  return `${h}:${m}`;
}

// dois intervalos [ini, fim) se sobrepõem? (encostar não conta: 20–21 e 21–22 convivem)
export function sobrepoe(a, b) {
  return a.ini < b.fim && b.ini < a.fim;
}

/**
 * Recorta períodos (em minutos contados a partir da meia-noite do 1º dia) para um dia.
 * Ex.: um bloqueio de 2 dias vira [0, 1440) em cada um deles.
 * @param {{ini:number, fim:number}[]} periodos
 * @param {number} indiceDia  0 = primeiro dia do intervalo consultado
 */
export function recortarDia(periodos, indiceDia) {
  const base = indiceDia * MINUTOS_DIA;
  return periodos
    .filter((p) => p.ini < base + MINUTOS_DIA && p.fim > base)
    .map((p) => ({ ...p, ini: Math.max(p.ini, base) - base, fim: Math.min(p.fim, base + MINUTOS_DIA) - base }));
}

// junta períodos que se tocam ou sobrepõem (para o site mostrar "ocupado" sem revelar
// quantas reservas existem nem de quem são)
export function unirPeriodos(periodos) {
  const ordenados = [...periodos].sort((a, b) => a.ini - b.ini);
  const unidos = [];
  for (const p of ordenados) {
    const ultimo = unidos.at(-1);
    if (ultimo && p.ini <= ultimo.fim) ultimo.fim = Math.max(ultimo.fim, p.fim);
    else unidos.push({ ini: p.ini, fim: p.fim });
  }
  return unidos;
}

/**
 * Horários de início em que cabe uma reserva de `duracao` minutos.
 * @param {object} p
 * @param {{ini:number, fim:number}[]} p.turnos      funcionamento do dia
 * @param {{ini:number, fim:number}[]} p.ocupados    reservas confirmadas e bloqueios do dia
 * @param {number} p.duracao                         minutos (60, 90, 120…)
 * @param {number} p.intervalo                       de quantos em quantos minutos começa um horário
 * @param {number|null} [p.minimoInicio]             menor início aceito no dia (agora + antecedência);
 *                                                   null = sem restrição
 * @returns {number[]} inícios livres, em minutos
 */
export function calcularHorariosLivres({ turnos, ocupados, duracao, intervalo, minimoInicio = null }) {
  const livres = [];
  for (const turno of turnos) {
    // a reserva começa e termina dentro do mesmo turno
    for (let ini = turno.ini; ini + duracao <= turno.fim; ini += intervalo) {
      if (minimoInicio !== null && ini < minimoInicio) continue;
      const candidato = { ini, fim: ini + duracao };
      if (ocupados.some((o) => sobrepoe(candidato, o))) continue;
      livres.push(ini);
    }
  }
  return livres;
}

// o período [ini, fim) cabe inteiro dentro de algum turno?
export function dentroDoFuncionamento(turnos, ini, fim) {
  return turnos.some((t) => ini >= t.ini && fim <= t.fim);
}
