// Ocorrências semanais dos mensalistas, materializadas como linhas em `reservas`
// (origem 'mensalista'). Assim a mesma constraint EXCLUDE que separa as avulsas
// também separa avulsa × mensalista × bloqueio.
//
// garantirOcorrencias é idempotente e barata: roda antes de ler a agenda, dentro da
// transação de reservar e ao mexer num contrato. Não precisa de cron.

// quantos dias além da janela de reserva do site as ocorrências são geradas
export const FOLGA_HORIZONTE_DIAS = 14;

/**
 * Cria as ocorrências que faltam dos contratos ativos, de agora até
 * hoje + janela_reserva_dias + folga (ou até `ate`, se for mais longe).
 *  - já existe linha para (contrato, data)? não mexe: exceções ('liberada') sobrevivem;
 *  - a data já tem algo confirmado no horário? nasce como 'conflito' (nada é apagado);
 *  - 'conflito' cujo choque sumiu (a avulsa foi cancelada) volta a ser 'confirmada'.
 */
export async function garantirOcorrencias(db, arena, ate = null) {
  // 1. conflitos resolvidos sozinhos: a reserva que batia foi cancelada ou remarcada
  await db.query(
    `UPDATE reservas o
        SET status = 'confirmada', atualizado_em = now()
      WHERE o.arena_id = $1 AND o.origem = 'mensalista' AND o.status = 'conflito'
        AND o.inicio > now()
        AND NOT EXISTS (SELECT 1 FROM reservas r
                         WHERE r.arena_id = $1 AND r.status = 'confirmada'
                           AND r.inicio < o.fim AND r.fim > o.inicio)`,
    [arena.id]
  );

  // 2. ocorrências novas
  await db.query(
    `WITH limite AS (
       SELECT (now() AT TIME ZONE $2)::date AS hoje,
              GREATEST((now() AT TIME ZONE $2)::date + $3::int,
                       COALESCE($4::date, '-infinity'::date)) AS ate
     ),
     novas AS (
       SELECT c.id AS contrato_id, d::date AS data,
              (d::date + c.hora_inicio) AT TIME ZONE $2                                       AS inicio,
              (d::date + c.hora_inicio) AT TIME ZONE $2 + make_interval(mins => c.duracao_min) AS fim
         FROM contratos_mensalistas c
        CROSS JOIN limite l
        CROSS JOIN LATERAL generate_series(GREATEST(c.data_inicio, l.hoje),
                                           LEAST(COALESCE(c.data_fim, l.ate), l.ate),
                                           interval '1 day') AS d
        WHERE c.arena_id = $1 AND c.status = 'ativo'
          AND EXTRACT(DOW FROM d) = c.dia_semana
     )
     INSERT INTO reservas (arena_id, origem, status, inicio, fim, contrato_id, data_ocorrencia)
     SELECT $1, 'mensalista',
            CASE WHEN EXISTS (SELECT 1 FROM reservas r
                               WHERE r.arena_id = $1 AND r.status = 'confirmada'
                                 AND r.inicio < n.fim AND r.fim > n.inicio)
                 THEN 'conflito' ELSE 'confirmada' END,
            n.inicio, n.fim, n.contrato_id, n.data
       FROM novas n
      WHERE n.inicio > now()
     ON CONFLICT (contrato_id, data_ocorrencia) DO NOTHING`,
    [arena.id, arena.fuso_horario, arena.janela_reserva_dias + FOLGA_HORIZONTE_DIAS, ate]
  );
}

// Pausar, encerrar ou mudar o horário: apaga as ocorrências futuras que são só
// derivadas do contrato. Exceções ('liberada') ficam, porque guardam uma decisão do dono.
export async function removerOcorrenciasFuturas(db, contratoId) {
  await db.query(
    `DELETE FROM reservas
      WHERE contrato_id = $1 AND status IN ('confirmada', 'conflito') AND inicio > now()`,
    [contratoId]
  );
}

// Ocorrências futuras de um contrato que estão em conflito, com o que está no caminho.
// O dono decide no painel quem fica (POST /admin/ocorrencias/:id/resolver).
export async function conflitosDoContrato(db, arena, contratoId) {
  const { rows } = await db.query(
    `SELECT o.id AS ocorrencia_id,
            to_char(o.data_ocorrencia, 'YYYY-MM-DD')      AS data,
            to_char(o.inicio AT TIME ZONE $3, 'HH24:MI')  AS inicio,
            to_char(o.fim    AT TIME ZONE $3, 'HH24:MI')  AS fim,
            r.id AS reserva_id, r.origem, r.cliente_nome, r.cliente_telefone, r.motivo,
            to_char(r.inicio AT TIME ZONE $3, 'HH24:MI')  AS reserva_inicio,
            to_char(r.fim    AT TIME ZONE $3, 'HH24:MI')  AS reserva_fim
       FROM reservas o
       JOIN reservas r ON r.arena_id = o.arena_id AND r.status = 'confirmada'
                      AND r.inicio < o.fim AND r.fim > o.inicio
      WHERE o.arena_id = $1 AND o.contrato_id = $2 AND o.status = 'conflito' AND o.inicio > now()
      ORDER BY o.inicio`,
    [arena.id, contratoId, arena.fuso_horario]
  );
  return rows;
}
