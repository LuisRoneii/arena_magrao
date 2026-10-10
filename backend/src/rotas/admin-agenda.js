// Painel: agenda da semana, reservas manuais, pagamentos, bloqueios e conflitos.
// Montado em /api/:slug/admin, depois do exigirLogin (ver admin.js).

import { Router } from "express";
import { pool, transacao } from "../db.js";
import { ErroHttp } from "../erros.js";
import {
  idValido, dataValida, horarioValido, textoValido, textoOpcional, telefoneValido, inteiroValido,
  duracaoValida, centavosValido, formaPagamentoValida, agoraNaArena,
} from "../comum.js";
import { gerarCodigo, formatarCodigo } from "../codigo.js";
import { garantirOcorrencias } from "../ocorrencias.js";
import { horarioLivre, lerHorarios, somarDias, diaDaSemana } from "../disponibilidade.js";
import { paraHHMM } from "../agenda.js";

export const rotasAgenda = Router({ mergeParams: true });

const DIAS_AGENDA_MAX = 14;

// campos de uma reserva como o painel mostra
const SELECT_RESERVA = `
  r.id, r.origem, r.status, r.contrato_id, r.motivo, r.observacao, r.valor_centavos,
  to_char(r.pago_em, 'YYYY-MM-DD') AS pago_em, r.forma_pagamento, r.codigo,
  to_char(r.inicio AT TIME ZONE $FUSO, 'YYYY-MM-DD') AS data,
  to_char(r.inicio AT TIME ZONE $FUSO, 'HH24:MI')    AS inicio,
  to_char(r.fim    AT TIME ZONE $FUSO, 'YYYY-MM-DD') AS data_fim,
  to_char(r.fim    AT TIME ZONE $FUSO, 'HH24:MI')    AS fim,
  COALESCE(r.cliente_nome, c.nome_grupo, c.responsavel_nome) AS nome,
  COALESCE(r.cliente_telefone, c.telefone)                   AS telefone`;

const selectReserva = (paramFuso) => SELECT_RESERVA.replaceAll("$FUSO", paramFuso);

function formatarReserva(r) {
  return { ...r, codigo: formatarCodigo(r.codigo), pago: !!r.pago_em };
}

/* ---------------------------------------------------------------------
   GET /admin/agenda?inicio=2026-10-12&dias=7
   -> { hoje, dias: [{ data, dia_semana, turnos }], reservas: [...] }
   reservas inclui avulsas, mensalistas (com 'conflito' e 'liberada') e bloqueios
--------------------------------------------------------------------- */
rotasAgenda.get("/agenda", async (req, res) => {
  const arena = req.arena;
  const agora = await agoraNaArena(pool, arena);
  const dataInicio = req.query.inicio === undefined ? agora.hoje : dataValida(req.query.inicio, "inicio");
  const dias = req.query.dias === undefined ? 7 : inteiroValido(req.query.dias, "dias", 1, DIAS_AGENDA_MAX);

  await garantirOcorrencias(pool, arena, somarDias(dataInicio, dias - 1));
  const { turnos } = await lerHorarios(pool, arena.id);

  const { rows } = await pool.query(
    `SELECT ${selectReserva("$3")}
       FROM reservas r
       LEFT JOIN contratos_mensalistas c ON c.id = r.contrato_id
      WHERE r.arena_id = $1
        AND r.status IN ('confirmada', 'conflito', 'liberada')
        AND r.inicio < ($2::date + $4::int)::timestamp AT TIME ZONE $3
        AND r.fim    > ($2::date)::timestamp AT TIME ZONE $3
      ORDER BY r.inicio, r.id`,
    [arena.id, dataInicio, arena.fuso_horario, dias]
  );

  res.json({
    hoje: agora.hoje,
    dias: Array.from({ length: dias }, (_, i) => {
      const data = somarDias(dataInicio, i);
      const diaSemana = diaDaSemana(data);
      return {
        data,
        dia_semana: diaSemana,
        turnos: turnos[diaSemana].map((t) => ({ inicio: paraHHMM(t.ini), fim: paraHHMM(t.fim) })),
      };
    }),
    reservas: rows.map(formatarReserva),
  });
});

/* ---------------------------------------------------------------------
   POST /admin/reservas
   { data, horario, duracao_min, nome, telefone?, valor_centavos?, observacao? }
   Reserva lançada pelo painel: sem antecedência mínima, mas dentro do funcionamento
   e sem choque. Valor padrão = preço da faixa; o dono pode mudar.
--------------------------------------------------------------------- */
rotasAgenda.post("/reservas", async (req, res) => {
  const arena = req.arena;
  const corpo = req.body ?? {};
  const data = dataValida(corpo.data);
  const horario = horarioValido(corpo.horario);
  const duracao = duracaoValida(corpo.duracao_min, arena);
  const nome = textoValido(corpo.nome, "nome", 2, 150);
  const telefone = corpo.telefone ? telefoneValido(corpo.telefone) : null;
  const valorInformado = corpo.valor_centavos == null ? null : centavosValido(corpo.valor_centavos, "valor_centavos");
  const observacao = textoOpcional(corpo.observacao, "observacao", 255);

  const nova = await transacao(async (db) => {
    const livre = await horarioLivre(db, arena, { data, horario, duracao, publico: false });
    if (!livre) {
      throw new ErroHttp(409, "Horário indisponível: está ocupado, já passou ou fica fora do funcionamento.");
    }

    let clienteId = null;
    if (telefone) {
      const { rows: [c] } = await db.query(
        `INSERT INTO clientes (arena_id, nome, telefone) VALUES ($1, $2, $3)
         ON CONFLICT (arena_id, telefone) DO UPDATE SET nome = EXCLUDED.nome
         RETURNING id`,
        [arena.id, nome, telefone]
      );
      clienteId = c.id;
    }
    // com WhatsApp, a reserva ganha código para o cliente consultar/cancelar pelo site
    const codigo = telefone ? gerarCodigo() : null;
    const valor = valorInformado ?? livre.valor_centavos;

    const { rows: [r] } = await db.query(
      `INSERT INTO reservas
         (arena_id, origem, inicio, fim, cliente_id, cliente_nome, cliente_telefone,
          valor_centavos, codigo, observacao, criado_por)
       VALUES ($1, 'painel',
               ($2::date + $3::time) AT TIME ZONE $4,
               ($2::date + $3::time) AT TIME ZONE $4 + make_interval(mins => $5),
               $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [arena.id, data, horario, arena.fuso_horario, duracao, clienteId, nome, telefone,
        valor, codigo, observacao, req.conta.sub]
    );
    return { id: r.id, codigo: formatarCodigo(codigo), valor_centavos: valor };
  });

  res.status(201).json({ ...nova, data, horario, duracao_min: duracao });
});

/* ---------------------------------------------------------------------
   PATCH /admin/reservas/:id   (só reservas avulsas)
   { acao: "pagar", forma_pagamento, pago_em? }   pago_em padrão = hoje
   { acao: "desfazer_pagamento" }
   { acao: "cancelar" } | { acao: "reabrir" }
   { acao: "remarcar", data, horario, duracao_min }
   { acao: "valor", valor_centavos }
   Ocorrência de mensalista muda pelas exceções; bloqueio, pelo DELETE /bloqueios/:id.
--------------------------------------------------------------------- */
rotasAgenda.patch("/reservas/:id", async (req, res) => {
  const arena = req.arena;
  const id = idValido(req.params.id, "id");
  const corpo = req.body ?? {};
  const acao = String(corpo.acao ?? "");

  const resultado = await transacao(async (db) => {
    const { rows: [atual] } = await db.query(
      `SELECT id, origem, status, pago_em FROM reservas
        WHERE id = $1 AND arena_id = $2 AND origem IN ('site', 'painel')
        FOR UPDATE`,
      [id, arena.id]
    );
    if (!atual) throw new ErroHttp(404, "Reserva não encontrada.");

    const exigirStatus = (status, texto) => {
      if (atual.status !== status) throw new ErroHttp(409, texto);
    };

    switch (acao) {
      case "pagar": {
        exigirStatus("confirmada", "Só dá para marcar como paga uma reserva confirmada.");
        const forma = formaPagamentoValida(corpo.forma_pagamento);
        const pagoEm = corpo.pago_em ? dataValida(corpo.pago_em, "pago_em") : (await agoraNaArena(db, arena)).hoje;
        await db.query(
          "UPDATE reservas SET pago_em = $2, forma_pagamento = $3, atualizado_em = now() WHERE id = $1",
          [id, pagoEm, forma]
        );
        break;
      }
      case "desfazer_pagamento":
        await db.query(
          "UPDATE reservas SET pago_em = NULL, forma_pagamento = NULL, atualizado_em = now() WHERE id = $1",
          [id]
        );
        break;
      case "cancelar":
        exigirStatus("confirmada", "Essa reserva não está confirmada.");
        await db.query("UPDATE reservas SET status = 'cancelada', atualizado_em = now() WHERE id = $1", [id]);
        break;
      case "reabrir":
        // pode bater com quem pegou o horário depois: a EXCLUDE recusa e vira 409
        exigirStatus("cancelada", "Só dá para reabrir uma reserva cancelada.");
        await garantirOcorrencias(db, arena);
        await db.query("UPDATE reservas SET status = 'confirmada', atualizado_em = now() WHERE id = $1", [id]);
        break;
      case "remarcar": {
        exigirStatus("confirmada", "Só dá para remarcar uma reserva confirmada.");
        const data = dataValida(corpo.data);
        const horario = horarioValido(corpo.horario);
        const duracao = duracaoValida(corpo.duracao_min, arena);
        const livre = await horarioLivre(db, arena, { data, horario, duracao, publico: false, ignorarId: id });
        if (!livre) {
          throw new ErroHttp(409, "Horário indisponível: está ocupado, já passou ou fica fora do funcionamento.");
        }
        // se já foi paga, o valor combinado fica; senão, vai para o preço do novo horário
        await db.query(
          `UPDATE reservas
              SET inicio = ($2::date + $3::time) AT TIME ZONE $4,
                  fim    = ($2::date + $3::time) AT TIME ZONE $4 + make_interval(mins => $5),
                  valor_centavos = CASE WHEN pago_em IS NULL THEN $6 ELSE valor_centavos END,
                  atualizado_em = now()
            WHERE id = $1`,
          [id, data, horario, arena.fuso_horario, duracao, livre.valor_centavos]
        );
        break;
      }
      case "valor":
        await db.query(
          "UPDATE reservas SET valor_centavos = $2, atualizado_em = now() WHERE id = $1",
          [id, centavosValido(corpo.valor_centavos, "valor_centavos")]
        );
        break;
      default:
        throw new ErroHttp(400, 'Campo "acao" inválido.');
    }

    const { rows: [r] } = await db.query(
      `SELECT ${selectReserva("$2")} FROM reservas r
         LEFT JOIN contratos_mensalistas c ON c.id = r.contrato_id
        WHERE r.id = $1`,
      [id, arena.fuso_horario]
    );
    return formatarReserva(r);
  });

  res.json(resultado);
});

/* ---------------------------------------------------------------------
   Bloqueios (manutenção, evento, torneio): linhas origem 'bloqueio' em reservas
--------------------------------------------------------------------- */

// GET /admin/bloqueios -> bloqueios que ainda não terminaram
rotasAgenda.get("/bloqueios", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.id, r.motivo,
            to_char(r.inicio AT TIME ZONE $2, 'YYYY-MM-DD') AS data_inicio,
            to_char(r.inicio AT TIME ZONE $2, 'HH24:MI')    AS hora_inicio,
            to_char(r.fim    AT TIME ZONE $2, 'YYYY-MM-DD') AS data_fim,
            to_char(r.fim    AT TIME ZONE $2, 'HH24:MI')    AS hora_fim
       FROM reservas r
      WHERE r.arena_id = $1 AND r.origem = 'bloqueio' AND r.status = 'confirmada' AND r.fim > now()
      ORDER BY r.inicio`,
    [req.arena.id, req.arena.fuso_horario]
  );
  res.json(rows);
});

// POST /admin/bloqueios
// { data_inicio, data_fim?, hora_inicio?, hora_fim?, motivo, liberar_mensalistas? }
// Sem horas = dia(s) inteiro(s). Se houver reserva no período, responde 409 com a
// lista (nada é cancelado sozinho). Com liberar_mensalistas, as ocorrências de
// mensalista do período viram exceção na mesma transação.
rotasAgenda.post("/bloqueios", async (req, res) => {
  const arena = req.arena;
  const corpo = req.body ?? {};
  const dataInicio = dataValida(corpo.data_inicio, "data_inicio");
  const dataFim = corpo.data_fim ? dataValida(corpo.data_fim, "data_fim") : dataInicio;
  const motivo = textoValido(corpo.motivo, "motivo", 2, 150);
  const diaInteiro = !corpo.hora_inicio && !corpo.hora_fim;
  const horaInicio = diaInteiro ? "00:00" : horarioValido(corpo.hora_inicio, "hora_inicio");
  const horaFim = diaInteiro ? null : horarioValido(corpo.hora_fim, "hora_fim", { fimDoDia: true });
  const liberarMensalistas = corpo.liberar_mensalistas === true;

  const novo = await transacao(async (db) => {
    const { rows: [periodo] } = await db.query(
      `SELECT ($1::date + $2::time) AT TIME ZONE $5 AS inicio,
              CASE WHEN $3::time IS NULL THEN ($4::date + 1)::timestamp AT TIME ZONE $5
                   ELSE ($4::date + $3::time) AT TIME ZONE $5 END AS fim`,
      [dataInicio, horaInicio, horaFim, dataFim, arena.fuso_horario]
    );
    if (periodo.fim <= periodo.inicio) throw new ErroHttp(400, "O fim do bloqueio precisa ser depois do início.");

    // as ocorrências de mensalista do período precisam existir para aparecer nos conflitos
    await garantirOcorrencias(db, arena, dataFim);

    if (liberarMensalistas) {
      await db.query(
        `UPDATE reservas SET status = 'liberada', motivo = $4, atualizado_em = now()
          WHERE arena_id = $1 AND origem = 'mensalista' AND status IN ('confirmada', 'conflito')
            AND inicio < $3 AND fim > $2`,
        [arena.id, periodo.inicio, periodo.fim, `Bloqueio: ${motivo}`.slice(0, 150)]
      );
    }

    const { rows: conflitos } = await db.query(
      `SELECT ${selectReserva("$4")}
         FROM reservas r
         LEFT JOIN contratos_mensalistas c ON c.id = r.contrato_id
        WHERE r.arena_id = $1 AND r.status = 'confirmada' AND r.inicio < $3 AND r.fim > $2
        ORDER BY r.inicio`,
      [arena.id, periodo.inicio, periodo.fim, arena.fuso_horario]
    );
    if (conflitos.length) {
      throw new ErroHttp(409,
        "Já existem horários marcados nesse período. Cancele ou remarque antes de bloquear.",
        { conflitos: conflitos.map(formatarReserva) });
    }

    const { rows: [r] } = await db.query(
      `INSERT INTO reservas (arena_id, origem, inicio, fim, motivo, criado_por)
       VALUES ($1, 'bloqueio', $2, $3, $4, $5) RETURNING id`,
      [arena.id, periodo.inicio, periodo.fim, motivo, req.conta.sub]
    );
    return r;
  });

  res.status(201).json({ id: novo.id });
});

// DELETE /admin/bloqueios/:id -> os horários voltam a ficar livres
// (exceções de mensalista criadas pelo bloqueio continuam: o dono desfaz se quiser)
rotasAgenda.delete("/bloqueios/:id", async (req, res) => {
  const id = idValido(req.params.id, "id");
  const { rowCount } = await pool.query(
    `UPDATE reservas SET status = 'cancelada', atualizado_em = now()
      WHERE id = $1 AND arena_id = $2 AND origem = 'bloqueio' AND status = 'confirmada'`,
    [id, req.arena.id]
  );
  if (!rowCount) throw new ErroHttp(404, "Bloqueio não encontrado.");
  res.status(204).end();
});

/* ---------------------------------------------------------------------
   POST /admin/ocorrencias/:id/resolver   { manter: "mensalista" | "avulsa" }
   Ocorrência de mensalista em 'conflito' com uma reserva avulsa:
   - mensalista: cancela a(s) avulsa(s) e confirma o mensalista (devolve quem avisar)
   - avulsa: o mensalista não joga nessa data (vira exceção)
--------------------------------------------------------------------- */
rotasAgenda.post("/ocorrencias/:id/resolver", async (req, res) => {
  const arena = req.arena;
  const id = idValido(req.params.id, "id");
  const manter = String(req.body?.manter ?? "");
  if (!["mensalista", "avulsa"].includes(manter)) {
    throw new ErroHttp(400, 'Campo "manter" deve ser "mensalista" ou "avulsa".');
  }

  const resultado = await transacao(async (db) => {
    const { rows: [oc] } = await db.query(
      `SELECT id, inicio, fim FROM reservas
        WHERE id = $1 AND arena_id = $2 AND origem = 'mensalista' AND status = 'conflito'
        FOR UPDATE`,
      [id, arena.id]
    );
    if (!oc) throw new ErroHttp(404, "Conflito não encontrado (talvez já tenha sido resolvido).");

    if (manter === "avulsa") {
      await db.query(
        `UPDATE reservas SET status = 'liberada', motivo = 'Horário ficou com uma reserva avulsa',
                atualizado_em = now() WHERE id = $1`,
        [id]
      );
      return { id, status: "liberada", canceladas: [] };
    }

    const { rows: noCaminho } = await db.query(
      `SELECT id, origem, cliente_nome, cliente_telefone,
              to_char(inicio AT TIME ZONE $4, 'YYYY-MM-DD') AS data,
              to_char(inicio AT TIME ZONE $4, 'HH24:MI')    AS inicio
         FROM reservas
        WHERE arena_id = $1 AND status = 'confirmada' AND inicio < $3 AND fim > $2
        FOR UPDATE`,
      [arena.id, oc.inicio, oc.fim, arena.fuso_horario]
    );
    if (noCaminho.some((r) => r.origem === "bloqueio" || r.origem === "mensalista")) {
      throw new ErroHttp(409, "Há um bloqueio nesse horário. Remova o bloqueio antes.");
    }
    await db.query(
      "UPDATE reservas SET status = 'cancelada', atualizado_em = now() WHERE id = ANY($1::int[])",
      [noCaminho.map((r) => r.id)]
    );
    await db.query("UPDATE reservas SET status = 'confirmada', atualizado_em = now() WHERE id = $1", [id]);
    return { id, status: "confirmada", canceladas: noCaminho };
  });

  res.json(resultado);
});
