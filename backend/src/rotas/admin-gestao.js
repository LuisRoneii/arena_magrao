// Painel: faturamento e configurações. Só para o papel "dono".
// Montado em /api/:slug/admin, depois do exigirLogin (ver admin.js).

import { Router } from "express";
import { pool, transacao } from "../db.js";
import { ErroHttp } from "../erros.js";
import { exigirPapel } from "../autenticacao.js";
import {
  CAMPOS_ARENA, mesValido, horarioValido, inteiroValido, diaSemanaValido, centavosValido, textoOpcional,
  agoraNaArena,
} from "../comum.js";
import { lerHorarios } from "../disponibilidade.js";
import { paraMinutos, paraHHMM, dentroDoFuncionamento } from "../agenda.js";
import { trechosSemPreco } from "../precos.js";
import { competenciaDe } from "../mensalidades.js";

export const rotasGestao = Router({ mergeParams: true });

// as rotas deste arquivo têm caminho próprio: o exigirPapel não atinge as outras
const soDono = exigirPapel("dono");
const NOME_DIA = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

/* ---------------------------------------------------------------------
   GET /admin/faturamento?mes=2026-10
   Regime de competência: avulsas pela data do jogo, mensalidades pelo mês de referência.
   -> { mes, avulso, mensalidades, total } com previsto, recebido e em aberto (centavos)
--------------------------------------------------------------------- */
rotasGestao.get("/faturamento", soDono, async (req, res) => {
  const arena = req.arena;
  const mes = mesValido(req.query.mes);
  const { hoje } = await agoraNaArena(pool, arena);

  const { rows: [avulso] } = await pool.query(
    `WITH periodo AS (
       SELECT ($2::date)::timestamp AT TIME ZONE $3                         AS ini,
              ($2::date + interval '1 month')::timestamp AT TIME ZONE $3    AS fim
     )
     SELECT count(*)                                                                  AS quantidade,
            COALESCE(sum(r.valor_centavos), 0)                                        AS previsto_centavos,
            COALESCE(sum(r.valor_centavos) FILTER (WHERE r.pago_em IS NOT NULL), 0)   AS recebido_centavos,
            COALESCE(sum(r.valor_centavos) FILTER (WHERE r.pago_em IS NULL), 0)       AS em_aberto_centavos,
            -- jogo que já aconteceu e não foi marcado como pago
            COALESCE(sum(r.valor_centavos) FILTER (WHERE r.pago_em IS NULL AND r.fim <= now()), 0)
                                                                                      AS jogado_sem_pagamento_centavos,
            COALESCE(sum(r.valor_centavos) FILTER (WHERE r.forma_pagamento = 'pix'), 0)      AS pix,
            COALESCE(sum(r.valor_centavos) FILTER (WHERE r.forma_pagamento = 'dinheiro'), 0) AS dinheiro,
            COALESCE(sum(r.valor_centavos) FILTER (WHERE r.forma_pagamento = 'cartao'), 0)   AS cartao
       FROM reservas r, periodo p
      WHERE r.arena_id = $1 AND r.origem IN ('site', 'painel') AND r.status = 'confirmada'
        AND r.inicio >= p.ini AND r.inicio < p.fim`,
    [arena.id, competenciaDe(mes), arena.fuso_horario]
  );

  const { rows: [mensal] } = await pool.query(
    `SELECT count(*)                                                                    AS quantidade,
            COALESCE(sum(valor_centavos), 0)                                            AS previsto_centavos,
            COALESCE(sum(valor_centavos) FILTER (WHERE status = 'paga'), 0)             AS recebido_centavos,
            COALESCE(sum(valor_centavos) FILTER (WHERE status = 'pendente'), 0)         AS em_aberto_centavos,
            COALESCE(sum(valor_centavos) FILTER (WHERE status = 'pendente' AND vencimento < $3::date), 0)
                                                                                        AS atrasado_centavos,
            COALESCE(sum(valor_centavos) FILTER (WHERE forma_pagamento = 'pix'), 0)      AS pix,
            COALESCE(sum(valor_centavos) FILTER (WHERE forma_pagamento = 'dinheiro'), 0) AS dinheiro,
            COALESCE(sum(valor_centavos) FILTER (WHERE forma_pagamento = 'cartao'), 0)   AS cartao
       FROM mensalidades
      WHERE arena_id = $1 AND competencia = $2::date AND status <> 'cancelada'`,
    [arena.id, competenciaDe(mes), hoje]
  );

  const separarFormas = ({ pix, dinheiro, cartao, ...resto }) => ({ ...resto, por_forma: { pix, dinheiro, cartao } });
  res.json({
    mes,
    avulso: separarFormas(avulso),
    mensalidades: separarFormas(mensal),
    total: {
      previsto_centavos: avulso.previsto_centavos + mensal.previsto_centavos,
      recebido_centavos: avulso.recebido_centavos + mensal.recebido_centavos,
      em_aberto_centavos: avulso.em_aberto_centavos + mensal.em_aberto_centavos,
    },
  });
});

/* ---------------------------------------------------------------------
   Configurações
--------------------------------------------------------------------- */
async function lerConfiguracoes(db, arenaId) {
  const { rows: [arena] } = await db.query(`SELECT ${CAMPOS_ARENA} FROM arenas WHERE id = $1`, [arenaId]);
  const { turnos, precos } = await lerHorarios(db, arenaId);
  delete arena.id;
  delete arena.slug;
  delete arena.fuso_horario;
  return {
    arena,
    funcionamento: turnos.flatMap((lista, dia) =>
      lista.map((t) => ({ dia_semana: dia, inicio: paraHHMM(t.ini), fim: paraHHMM(t.fim) }))),
    faixas_preco: precos.flatMap((lista, dia) =>
      lista.map((f) => ({
        dia_semana: dia, inicio: paraHHMM(f.ini), fim: paraHHMM(f.fim),
        preco_hora_centavos: f.preco_hora_centavos, nobre: f.nobre,
      }))),
  };
}

// GET /admin/configuracoes
rotasGestao.get("/configuracoes", soDono, async (req, res) => {
  res.json(await lerConfiguracoes(pool, req.arena.id));
});

function validarIntervalo(item, i, lista) {
  const dia = diaSemanaValido(item?.dia_semana, `${lista}[${i}].dia_semana`);
  const inicio = horarioValido(item?.inicio, `${lista}[${i}].inicio`);
  const fim = horarioValido(item?.fim, `${lista}[${i}].fim`, { fimDoDia: true });
  if (paraMinutos(fim) <= paraMinutos(inicio)) {
    throw new ErroHttp(400, `Em ${NOME_DIA[dia]}, ${inicio}–${fim}: o fim precisa ser depois do início.`);
  }
  return { dia_semana: dia, inicio, fim };
}

// WhatsApp da Arena: pode ser fixo com WhatsApp Business (10 dígitos) ou celular (11)
function whatsappDaArena(valor) {
  if (!valor) return null;
  let d = String(valor).replace(/\D/g, "");
  if (d.length >= 12 && d.startsWith("55")) d = d.slice(2);
  if (d.length !== 10 && d.length !== 11) throw new ErroHttp(400, "WhatsApp da Arena inválido. Use DDD + número.");
  return d;
}

function validarArena(a = {}) {
  const instagram = textoOpcional(String(a.instagram ?? "").replace(/^@/, ""), "instagram", 30);
  if (instagram && !/^[A-Za-z0-9._]+$/.test(instagram)) throw new ErroHttp(400, "Instagram inválido.");
  const linkMapa = textoOpcional(a.link_mapa, "link_mapa", 500);
  if (linkMapa && !/^https:\/\//.test(linkMapa)) throw new ErroHttp(400, "O link do mapa precisa começar com https://");
  const duracoes = Array.isArray(a.duracoes_permitidas)
    ? [...new Set(a.duracoes_permitidas.map((d) => inteiroValido(d, "duracoes_permitidas", 30, 180)))].sort((x, y) => x - y)
    : null;
  if (!duracoes?.length || duracoes.some((d) => d % 30)) {
    throw new ErroHttp(400, "Escolha ao menos uma duração (de 30 em 30 minutos, até 3h).");
  }
  const intervalo = inteiroValido(a.intervalo_grade_min, "intervalo_grade_min", 15, 60);
  if (![15, 30, 60].includes(intervalo)) throw new ErroHttp(400, "Os horários começam de 15, 30 ou 60 em 60 minutos.");
  return {
    nome: textoOpcional(a.nome, "nome", 150) ?? "Arena do Magrão",
    whatsapp: whatsappDaArena(a.whatsapp),
    instagram,
    endereco: textoOpcional(a.endereco, "endereco", 255),
    link_mapa: linkMapa,
    pix_chave: textoOpcional(a.pix_chave, "pix_chave", 150),
    antecedencia_reserva_min: inteiroValido(a.antecedencia_reserva_min, "antecedencia_reserva_min", 0, 10080),
    antecedencia_cancelamento_horas: inteiroValido(a.antecedencia_cancelamento_horas, "antecedencia_cancelamento_horas", 0, 720),
    janela_reserva_dias: inteiroValido(a.janela_reserva_dias, "janela_reserva_dias", 1, 90),
    duracoes_permitidas: duracoes,
    intervalo_grade_min: intervalo,
    mensalidade_padrao_centavos: centavosValido(a.mensalidade_padrao_centavos, "mensalidade_padrao_centavos"),
    max_reservas_futuras: inteiroValido(a.max_reservas_futuras, "max_reservas_futuras", 1, 20),
  };
}

// PUT /admin/configuracoes
// { arena: {...}, funcionamento: [{ dia_semana, inicio, fim }],
//   faixas_preco: [{ dia_semana, inicio, fim, preco_hora_centavos, nobre }] }
// Substitui tudo de uma vez, numa transação. As faixas precisam cobrir todo o funcionamento.
// -> configurações salvas + avisos (mensalistas que ficaram fora do novo funcionamento)
rotasGestao.put("/configuracoes", soDono, async (req, res) => {
  const corpo = req.body ?? {};
  const arena = validarArena(corpo.arena);
  if (!Array.isArray(corpo.funcionamento) || !Array.isArray(corpo.faixas_preco)) {
    throw new ErroHttp(400, 'Envie "funcionamento" e "faixas_preco" como listas.');
  }
  if (corpo.funcionamento.length > 50 || corpo.faixas_preco.length > 100) {
    throw new ErroHttp(400, "Turnos ou faixas demais.");
  }
  const funcionamento = corpo.funcionamento.map((f, i) => validarIntervalo(f, i, "funcionamento"));
  const faixas = corpo.faixas_preco.map((f, i) => ({
    ...validarIntervalo(f, i, "faixas_preco"),
    preco_hora_centavos: centavosValido(f.preco_hora_centavos, `faixas_preco[${i}].preco_hora_centavos`),
    nobre: f.nobre === true,
  }));

  // todo minuto aberto precisa ter preço (senão o site não saberia quanto cobrar)
  const minutos = (l) => l.map((x) => ({ ...x, ini: paraMinutos(x.inicio), fim: paraMinutos(x.fim) }));
  for (let dia = 0; dia < 7; dia++) {
    const faltando = trechosSemPreco(
      minutos(funcionamento.filter((f) => f.dia_semana === dia)),
      minutos(faixas.filter((f) => f.dia_semana === dia))
    );
    if (faltando.length) {
      const trechos = faltando.map((t) => `${paraHHMM(t.ini)}–${paraHHMM(t.fim)}`).join(", ");
      throw new ErroHttp(400, `Em ${NOME_DIA[dia]}, falta faixa de preço para ${trechos}.`);
    }
  }

  const resultado = await transacao(async (db) => {
    await db.query(
      `UPDATE arenas SET nome = $2, whatsapp = $3, instagram = $4, endereco = $5, link_mapa = $6, pix_chave = $7,
              antecedencia_reserva_min = $8, antecedencia_cancelamento_horas = $9, janela_reserva_dias = $10,
              duracoes_permitidas = $11, intervalo_grade_min = $12, mensalidade_padrao_centavos = $13,
              max_reservas_futuras = $14
        WHERE id = $1`,
      [req.arena.id, arena.nome, arena.whatsapp, arena.instagram, arena.endereco, arena.link_mapa, arena.pix_chave,
        arena.antecedencia_reserva_min, arena.antecedencia_cancelamento_horas, arena.janela_reserva_dias,
        arena.duracoes_permitidas, arena.intervalo_grade_min, arena.mensalidade_padrao_centavos,
        arena.max_reservas_futuras]
    );
    // turnos ou faixas sobrepostos: a EXCLUDE recusa e o tratarErros responde 400
    await db.query("DELETE FROM funcionamento WHERE arena_id = $1", [req.arena.id]);
    await db.query("DELETE FROM faixas_preco WHERE arena_id = $1", [req.arena.id]);
    for (const f of funcionamento) {
      await db.query(
        "INSERT INTO funcionamento (arena_id, dia_semana, hora_inicio, hora_fim) VALUES ($1, $2, $3, $4)",
        [req.arena.id, f.dia_semana, f.inicio, f.fim]
      );
    }
    for (const f of faixas) {
      await db.query(
        `INSERT INTO faixas_preco (arena_id, dia_semana, hora_inicio, hora_fim, preco_hora_centavos, nobre)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [req.arena.id, f.dia_semana, f.inicio, f.fim, f.preco_hora_centavos, f.nobre]
      );
    }

    // mensalistas fora do novo funcionamento: só avisa (o dono decide o que fazer)
    const { rows: contratos } = await db.query(
      `SELECT id, responsavel_nome, nome_grupo, dia_semana, hora_inicio, duracao_min
         FROM contratos_mensalistas WHERE arena_id = $1 AND status <> 'encerrado'`,
      [req.arena.id]
    );
    const { turnos } = await lerHorarios(db, req.arena.id);
    const avisos = contratos
      .filter((c) => {
        const ini = paraMinutos(c.hora_inicio);
        return !dentroDoFuncionamento(turnos[c.dia_semana], ini, ini + c.duracao_min);
      })
      .map((c) => `${c.nome_grupo || c.responsavel_nome} (${NOME_DIA[c.dia_semana]} ${c.hora_inicio.slice(0, 5)}) ficou fora do funcionamento.`);

    return { ...(await lerConfiguracoes(db, req.arena.id)), avisos };
  });

  res.json(resultado);
});
