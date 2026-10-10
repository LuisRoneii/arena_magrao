// Rotas públicas (sem login): o que o site usa.
// Todas ficam sob /api/:slug, ex.: /api/arena-do-magrao/agenda

import { Router } from "express";
import { pool, transacao } from "../db.js";
import { ErroHttp } from "../erros.js";
import {
  idValido, dataValida, horarioValido, textoValido, textoOpcional, telefoneValido, inteiroValido,
  diaSemanaValido, duracaoValida, aceiteValido, agoraNaArena,
} from "../comum.js";
import { gerarCodigo, normalizarCodigo, formatarCodigo } from "../codigo.js";
import { disponibilidade, horarioLivre, lerHorarios } from "../disponibilidade.js";
import { paraHHMM, paraMinutos, dentroDoFuncionamento } from "../agenda.js";
import { limiteReserva, limiteConsulta, limiteSolicitacao, MAX_SOLICITACOES_PENDENTES } from "../limites.js";

export const rotasPublicas = Router({ mergeParams: true });

const DIAS_AGENDA_MAX = 14;

/* ---------------------------------------------------------------------
   Código da reserva: número + código (Nº 128 · K7QM-2XPA-9F).
   Sem os dois juntos, a API responde "não encontrada" (não entrega se o
   número existe).
--------------------------------------------------------------------- */
function codigoValido(valor) {
  const codigo = normalizarCodigo(valor);
  if (!codigo) throw new ErroHttp(404, "Reserva não encontrada. Confira o número e o código.");
  return codigo;
}

// reserva do cliente, conferindo id + código. Já diz se ainda dá para cancelar.
async function buscarDoCliente(db, arena, id, codigo, { travar = false } = {}) {
  const { rows: [r] } = await db.query(
    `SELECT r.id, r.status, r.codigo, r.cliente_nome AS nome, r.valor_centavos,
            (r.pago_em IS NOT NULL)                                  AS pago,
            to_char(r.inicio AT TIME ZONE $4, 'YYYY-MM-DD')          AS data,
            to_char(r.inicio AT TIME ZONE $4, 'HH24:MI')             AS horario,
            to_char(r.fim    AT TIME ZONE $4, 'HH24:MI')             AS fim,
            (EXTRACT(EPOCH FROM (r.fim - r.inicio)) / 60)::int       AS duracao_min,
            (r.status = 'confirmada'
              AND r.inicio - make_interval(hours => $5) > now())      AS pode_cancelar
       FROM reservas r
      WHERE r.id = $1 AND r.arena_id = $2 AND r.codigo = $3 AND r.origem IN ('site', 'painel')
      ${travar ? "FOR UPDATE" : ""}`,
    [id, arena.id, codigo, arena.fuso_horario, arena.antecedencia_cancelamento_horas]
  );
  if (!r) throw new ErroHttp(404, "Reserva não encontrada. Confira o número e o código.");
  return {
    ...r,
    codigo: formatarCodigo(r.codigo),
    antecedencia_cancelamento_horas: arena.antecedencia_cancelamento_horas,
  };
}

// cancela pelo cliente: só confirmada e até X horas antes (regra da Arena)
async function cancelarDoCliente(db, arena, id, codigo) {
  // FOR UPDATE: dois cliques em "cancelar" (ou remarcar em duas abas) esperam um pelo outro
  const r = await buscarDoCliente(db, arena, id, codigo, { travar: true });
  if (r.status !== "confirmada") {
    throw new ErroHttp(409, "Essa reserva não está mais confirmada.");
  }
  if (!r.pode_cancelar) {
    throw new ErroHttp(409,
      `Só dá para cancelar ou remarcar até ${arena.antecedencia_cancelamento_horas} horas antes. ` +
      "Chame a Arena no WhatsApp.");
  }
  await db.query(
    "UPDATE reservas SET status = 'cancelada', atualizado_em = now() WHERE id = $1",
    [r.id]
  );
  return r;
}

/* ---------------------------------------------------------------------
   GET /api/:slug/info
   Tudo o que o site precisa para montar as seções de preços, contato e agenda.
--------------------------------------------------------------------- */
rotasPublicas.get("/info", async (req, res) => {
  const a = req.arena;
  const [{ hoje }, { turnos, precos }] = await Promise.all([agoraNaArena(pool, a), lerHorarios(pool, a.id)]);
  res.json({
    nome: a.nome,
    whatsapp: a.whatsapp,
    instagram: a.instagram,
    endereco: a.endereco,
    link_mapa: a.link_mapa,
    pix_chave: a.pix_chave,
    hoje,
    duracoes_permitidas: a.duracoes_permitidas,
    intervalo_grade_min: a.intervalo_grade_min,
    antecedencia_reserva_min: a.antecedencia_reserva_min,
    antecedencia_cancelamento_horas: a.antecedencia_cancelamento_horas,
    janela_reserva_dias: a.janela_reserva_dias,
    mensalidade_padrao_centavos: a.mensalidade_padrao_centavos,
    funcionamento: turnos.flatMap((lista, dia) =>
      lista.map((t) => ({ dia_semana: dia, inicio: paraHHMM(t.ini), fim: paraHHMM(t.fim) }))),
    faixas_preco: precos.flatMap((lista, dia) =>
      lista.map((f) => ({
        dia_semana: dia, inicio: paraHHMM(f.ini), fim: paraHHMM(f.fim),
        preco_hora_centavos: f.preco_hora_centavos, nobre: f.nobre,
      }))),
  });
});

/* ---------------------------------------------------------------------
   GET /api/:slug/agenda?inicio=2026-10-12&dias=7&duracao=60
   -> { hoje, duracao, dias: [{ data, dia_semana, situacao, turnos, livres, ocupados }] }
   situacao: aberto | lotado | fechado | passado | fora_da_janela
   "ocupados" não diz de quem nem de que tipo (avulsa, mensalista ou bloqueio).
--------------------------------------------------------------------- */
rotasPublicas.get("/agenda", async (req, res) => {
  const arena = req.arena;
  const duracao = req.query.duracao === undefined
    ? arena.duracoes_permitidas[0]
    : duracaoValida(req.query.duracao, arena);
  const dias = req.query.dias === undefined ? 7 : inteiroValido(req.query.dias, "dias", 1, DIAS_AGENDA_MAX);
  const dataInicio = req.query.inicio === undefined
    ? (await agoraNaArena(pool, arena)).hoje
    : dataValida(req.query.inicio, "inicio");

  const agenda = await disponibilidade(pool, arena, { dataInicio, dias, duracao, publico: true });
  res.json({ ...agenda, duracao });
});

/* ---------------------------------------------------------------------
   POST /api/:slug/reservas
   { data, horario, duracao_min, nome, telefone, aceite_privacidade: true,
     remarcar?: { id, codigo } }
   -> 201 { id, codigo, data, horario, fim, duracao_min, valor_centavos, nobre, status }
--------------------------------------------------------------------- */
rotasPublicas.post("/reservas", limiteReserva, async (req, res) => {
  const arena = req.arena;
  const corpo = req.body ?? {};
  const data = dataValida(corpo.data);
  const horario = horarioValido(corpo.horario);
  const duracao = duracaoValida(corpo.duracao_min, arena);
  const nome = textoValido(corpo.nome, "nome", 2, 150);
  const telefone = telefoneValido(corpo.telefone);
  aceiteValido(corpo.aceite_privacidade);
  // remarcar (opcional): número e código da reserva antiga
  const remarcar = corpo.remarcar
    ? { id: idValido(corpo.remarcar.id, "remarcar.id"), codigo: codigoValido(corpo.remarcar.codigo) }
    : null;
  const codigo = gerarCodigo();

  const reserva = await transacao(async (db) => {
    // remarcar: cancela a antiga dentro da MESMA transação.
    // Se a nova der errado, o ROLLBACK desfaz o cancelamento.
    if (remarcar) await cancelarDoCliente(db, arena, remarcar.id, remarcar.codigo);

    // confere funcionamento, antecedência, janela, mensalistas, bloqueios e reservas.
    // A corrida entre duas pessoas no mesmo instante é barrada pela EXCLUDE do banco.
    const livre = await horarioLivre(db, arena, { data, horario, duracao, publico: true });
    if (!livre) throw new ErroHttp(409, "Horário indisponível. Escolha outro.");

    // o mesmo WhatsApp não acumula reservas: evita lotarem a agenda com reservas falsas
    const { rows: [{ futuras }] } = await db.query(
      `SELECT count(*) AS futuras FROM reservas
        WHERE arena_id = $1 AND cliente_telefone = $2 AND origem IN ('site', 'painel')
          AND status = 'confirmada' AND inicio > now()`,
      [arena.id, telefone]
    );
    if (futuras >= arena.max_reservas_futuras) {
      throw new ErroHttp(409,
        `Este WhatsApp já tem ${futuras} reservas marcadas. Para marcar outra, chame a Arena no WhatsApp.`);
    }

    // cliente identificado pelo WhatsApp: cria ou atualiza o nome
    const { rows: [cliente] } = await db.query(
      `INSERT INTO clientes (arena_id, nome, telefone) VALUES ($1, $2, $3)
       ON CONFLICT (arena_id, telefone) DO UPDATE SET nome = EXCLUDED.nome
       RETURNING id`,
      [arena.id, nome, telefone]
    );

    const { rows: [nova] } = await db.query(
      `INSERT INTO reservas
         (arena_id, origem, inicio, fim, cliente_id, cliente_nome, cliente_telefone,
          valor_centavos, codigo, aceite_privacidade_em)
       VALUES ($1, 'site',
               ($2::date + $3::time) AT TIME ZONE $4,
               ($2::date + $3::time) AT TIME ZONE $4 + make_interval(mins => $5),
               $6, $7, $8, $9, $10, now())
       RETURNING id, status`,
      [arena.id, data, horario, arena.fuso_horario, duracao, cliente.id, nome, telefone,
        livre.valor_centavos, codigo]
    );
    return { ...nova, ...livre };
  });

  res.status(201).json({
    id: reserva.id,
    codigo: formatarCodigo(codigo),
    status: reserva.status,
    data,
    horario,
    fim: reserva.fim,
    duracao_min: duracao,
    valor_centavos: reserva.valor_centavos,
    nobre: reserva.nobre,
    remarcada: !!remarcar,
  });
});

/* ---------------------------------------------------------------------
   GET /api/:slug/reservas/:id?codigo=K7QM-2XPA-9F
   -> a reserva, com o status atual e se ainda dá para cancelar
--------------------------------------------------------------------- */
rotasPublicas.get("/reservas/:id", limiteConsulta, async (req, res) => {
  const id = idValido(req.params.id, "id");
  const codigo = codigoValido(req.query.codigo);
  res.json(await buscarDoCliente(pool, req.arena, id, codigo));
});

/* ---------------------------------------------------------------------
   POST /api/:slug/reservas/:id/cancelar   { codigo }
--------------------------------------------------------------------- */
rotasPublicas.post("/reservas/:id/cancelar", limiteConsulta, async (req, res) => {
  const id = idValido(req.params.id, "id");
  const codigo = codigoValido(req.body?.codigo);
  await transacao((db) => cancelarDoCliente(db, req.arena, id, codigo));
  res.json({ id, status: "cancelada" });
});

/* ---------------------------------------------------------------------
   POST /api/:slug/solicitacoes-mensalista
   { nome, telefone, dia_semana, hora_inicio, duracao_min, observacao?, aceite_privacidade: true }
   Não reserva nada: vira um pedido no painel para o dono aprovar ou recusar.
--------------------------------------------------------------------- */
rotasPublicas.post("/solicitacoes-mensalista", limiteSolicitacao, async (req, res) => {
  const arena = req.arena;
  const corpo = req.body ?? {};
  const nome = textoValido(corpo.nome, "nome", 2, 150);
  const telefone = telefoneValido(corpo.telefone);
  const diaSemana = diaSemanaValido(corpo.dia_semana);
  const horaInicio = horarioValido(corpo.hora_inicio, "hora_inicio");
  const duracao = duracaoValida(corpo.duracao_min, arena);
  const observacao = textoOpcional(corpo.observacao, "observacao", 500);
  aceiteValido(corpo.aceite_privacidade);

  const { turnos } = await lerHorarios(pool, arena.id);
  const ini = paraMinutos(horaInicio);
  if (!dentroDoFuncionamento(turnos[diaSemana], ini, ini + duracao)) {
    throw new ErroHttp(400, "Esse dia e horário ficam fora do funcionamento da Arena.");
  }

  const { rows: [{ pendentes }] } = await pool.query(
    `SELECT count(*) AS pendentes FROM solicitacoes_mensalista
      WHERE arena_id = $1 AND telefone = $2 AND status = 'pendente'`,
    [arena.id, telefone]
  );
  if (pendentes >= MAX_SOLICITACOES_PENDENTES) {
    throw new ErroHttp(409, "Já recebemos seus pedidos. A Arena vai te chamar no WhatsApp.");
  }

  const { rows: [nova] } = await pool.query(
    `INSERT INTO solicitacoes_mensalista
       (arena_id, nome, telefone, dia_semana, hora_inicio, duracao_min, observacao, aceite_privacidade_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     RETURNING id`,
    [arena.id, nome, telefone, diaSemana, horaInicio, duracao, observacao]
  );
  res.status(201).json({ id: nova.id, status: "pendente" });
});
