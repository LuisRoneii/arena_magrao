// Disponibilidade da quadra: junta funcionamento, faixas de preço, reservas,
// ocorrências de mensalista e bloqueios, e devolve os horários livres de cada dia.
// A conta em si é feita pelas funções puras de agenda.js e precos.js.
//
// Usada pela agenda do site, pela checagem antes de gravar uma reserva e pelo painel.
// A palavra final é sempre do banco (constraint EXCLUDE), dentro da transação.

import { agoraNaArena } from "./comum.js";
import { garantirOcorrencias } from "./ocorrencias.js";
import {
  MINUTOS_DIA, paraMinutos, paraHHMM, recortarDia, unirPeriodos, calcularHorariosLivres,
} from "./agenda.js";
import { calcularPreco } from "./precos.js";

/* ---------------------------------------------------------------------
   Datas "AAAA-MM-DD" (aritmética em UTC: só calendário, sem fuso)
--------------------------------------------------------------------- */
export function somarDias(iso, n) {
  const [a, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

export function diasEntre(de, ate) {
  const ms = (iso) => Date.UTC(...iso.split("-").map((v, i) => Number(v) - (i === 1 ? 1 : 0)));
  return Math.round((ms(ate) - ms(de)) / 86_400_000);
}

export function diaDaSemana(iso) {
  return new Date(`${iso}T12:00:00Z`).getUTCDay(); // 0 = domingo
}

/* ---------------------------------------------------------------------
   Leituras
--------------------------------------------------------------------- */
// funcionamento e faixas de preço, agrupados por dia da semana, em minutos
export async function lerHorarios(db, arenaId) {
  const [{ rows: func }, { rows: faixas }] = await Promise.all([
    db.query(
      `SELECT dia_semana, hora_inicio, hora_fim FROM funcionamento
        WHERE arena_id = $1 ORDER BY dia_semana, hora_inicio`, [arenaId]),
    db.query(
      `SELECT dia_semana, hora_inicio, hora_fim, preco_hora_centavos, nobre FROM faixas_preco
        WHERE arena_id = $1 ORDER BY dia_semana, hora_inicio`, [arenaId]),
  ]);
  const turnos = Array.from({ length: 7 }, () => []);
  const precos = Array.from({ length: 7 }, () => []);
  for (const f of func) {
    turnos[f.dia_semana].push({ ini: paraMinutos(f.hora_inicio), fim: paraMinutos(f.hora_fim) });
  }
  for (const f of faixas) {
    precos[f.dia_semana].push({
      ini: paraMinutos(f.hora_inicio), fim: paraMinutos(f.hora_fim),
      preco_hora_centavos: f.preco_hora_centavos, nobre: f.nobre,
    });
  }
  return { turnos, precos };
}

// Reservas confirmadas que encostam no intervalo, em minutos contados a partir da
// meia-noite de `dataInicio` (o Brasil não tem horário de verão: 1440 min por dia).
export async function lerOcupados(db, arena, dataInicio, dias, ignorarId = null) {
  const { rows } = await db.query(
    `WITH base AS (
       SELECT ($2::date)::timestamp AT TIME ZONE $3            AS ini,
              ($2::date + $4::int)::timestamp AT TIME ZONE $3  AS fim
     )
     SELECT floor(EXTRACT(EPOCH FROM (r.inicio - base.ini)) / 60)::int AS ini,
            ceil (EXTRACT(EPOCH FROM (r.fim    - base.ini)) / 60)::int AS fim
       FROM reservas r, base
      WHERE r.arena_id = $1 AND r.status = 'confirmada'
        AND r.inicio < base.fim AND r.fim > base.ini
        AND ($5::int IS NULL OR r.id <> $5)`,
    [arena.id, dataInicio, arena.fuso_horario, dias, ignorarId]
  );
  return rows;
}

// recorta os períodos ocupados aos turnos do dia (o site só desenha o horário aberto)
function ocupadosVisiveis(ocupados, turnos) {
  const visiveis = [];
  for (const p of unirPeriodos(ocupados)) {
    for (const t of turnos) {
      const ini = Math.max(p.ini, t.ini);
      const fim = Math.min(p.fim, t.fim);
      if (ini < fim) visiveis.push({ inicio: paraHHMM(ini), fim: paraHHMM(fim) });
    }
  }
  return visiveis;
}

/**
 * Horários livres dia a dia.
 * @param {object} opcoes
 * @param {string} opcoes.dataInicio   "AAAA-MM-DD"
 * @param {number} opcoes.dias         quantos dias a partir de dataInicio
 * @param {number} opcoes.duracao      minutos da reserva desejada
 * @param {boolean} opcoes.publico     true = regras do site (antecedência mínima e janela);
 *                                     false = painel (só não deixa reservar dia que já passou)
 * @param {number|null} [opcoes.ignorarId]  reserva que não conta como ocupada (remarcar no painel)
 */
export async function disponibilidade(db, arena, { dataInicio, dias, duracao, publico, ignorarId = null }) {
  const ultimo = somarDias(dataInicio, dias - 1);
  await garantirOcorrencias(db, arena, ultimo);

  const agora = await agoraNaArena(db, arena);
  const { turnos, precos } = await lerHorarios(db, arena.id);
  const ocupados = await lerOcupados(db, arena, dataInicio, dias, ignorarId);
  const agoraMin = agora.minuto + (publico ? arena.antecedencia_reserva_min : 0);

  const resultado = [];
  for (let i = 0; i < dias; i++) {
    const data = somarDias(dataInicio, i);
    const diaSemana = diaDaSemana(data);
    const turnosDia = turnos[diaSemana];
    const ocupadosDia = recortarDia(ocupados, i);
    const distancia = diasEntre(agora.hoje, data); // 0 = hoje
    const dia = {
      data,
      dia_semana: diaSemana,
      situacao: "aberto",
      turnos: turnosDia.map((t) => ({ inicio: paraHHMM(t.ini), fim: paraHHMM(t.fim) })),
      livres: [],
      ocupados: ocupadosVisiveis(ocupadosDia, turnosDia),
    };

    if (!turnosDia.length) dia.situacao = "fechado";
    else if (distancia < 0) dia.situacao = "passado";
    else if (publico && distancia > arena.janela_reserva_dias) dia.situacao = "fora_da_janela";
    else {
      const inicios = calcularHorariosLivres({
        turnos: turnosDia,
        ocupados: ocupadosDia,
        duracao,
        intervalo: arena.intervalo_grade_min,
        // no site, "agora + antecedência" pode cair num dia seguinte; no painel, só hoje importa
        minimoInicio: publico || distancia === 0 ? agoraMin - distancia * MINUTOS_DIA : null,
      });
      for (const ini of inicios) {
        const preco = calcularPreco(precos[diaSemana], ini, ini + duracao);
        if (!preco) continue; // trecho sem faixa de preço: não oferece (configuração incompleta)
        dia.livres.push({ horario: paraHHMM(ini), fim: paraHHMM(ini + duracao), ...preco });
      }
      if (!dia.livres.length) dia.situacao = "lotado";
    }
    resultado.push(dia);
  }
  return { hoje: agora.hoje, dias: resultado };
}

// Um horário específico está livre? Devolve { valor_centavos, nobre, fim } ou null.
export async function horarioLivre(db, arena, { data, horario, duracao, publico, ignorarId = null }) {
  const { dias: [dia] } = await disponibilidade(db, arena, { dataInicio: data, dias: 1, duracao, publico, ignorarId });
  return dia.livres.find((l) => l.horario === horario) ?? null;
}
