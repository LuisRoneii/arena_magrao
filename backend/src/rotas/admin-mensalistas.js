// Painel: mensalistas (contratos, exceções, solicitações do site) e mensalidades.
// Montado em /api/:slug/admin, depois do exigirLogin (ver admin.js).

import { Router } from "express";
import { pool, transacao } from "../db.js";
import { ErroHttp } from "../erros.js";
import {
  idValido, dataValida, mesValido, horarioValido, textoValido, textoOpcional, telefoneValido,
  inteiroValido, diaSemanaValido, duracaoValida, centavosValido, formaPagamentoValida, agoraNaArena,
} from "../comum.js";
import { garantirOcorrencias, removerOcorrenciasFuturas, conflitosDoContrato } from "../ocorrencias.js";
import { lerHorarios, diaDaSemana } from "../disponibilidade.js";
import { paraMinutos, paraHHMM, dentroDoFuncionamento } from "../agenda.js";
import { gerarMensalidades, competenciaDe, situacaoDe } from "../mensalidades.js";

export const rotasMensalistas = Router({ mergeParams: true });

const DIA_VENCIMENTO_PADRAO = 10;

/* ---------------------------------------------------------------------
   Contratos
--------------------------------------------------------------------- */
const SELECT_CONTRATO = `
  c.id, c.cliente_id, c.responsavel_nome, c.telefone, c.nome_grupo, c.dia_semana,
  c.hora_inicio, c.duracao_min, c.valor_mensal_centavos, c.dia_vencimento,
  c.data_inicio, c.data_fim, c.status, c.observacao`;

function formatarContrato(c) {
  const ini = paraMinutos(c.hora_inicio);
  return { ...c, hora_inicio: paraHHMM(ini), hora_fim: paraHHMM(ini + c.duracao_min) };
}

// valida os dados de um contrato (criar, editar ou aprovar uma solicitação)
async function validarContrato(db, arena, corpo) {
  const hoje = (await agoraNaArena(db, arena)).hoje;
  const dados = {
    nome: textoValido(corpo.nome, "nome", 2, 150),
    telefone: telefoneValido(corpo.telefone),
    nome_grupo: textoOpcional(corpo.nome_grupo, "nome_grupo", 100),
    dia_semana: diaSemanaValido(corpo.dia_semana),
    hora_inicio: horarioValido(corpo.hora_inicio, "hora_inicio"),
    duracao_min: duracaoValida(corpo.duracao_min, arena),
    valor_mensal_centavos: corpo.valor_mensal_centavos == null
      ? arena.mensalidade_padrao_centavos
      : centavosValido(corpo.valor_mensal_centavos, "valor_mensal_centavos"),
    dia_vencimento: corpo.dia_vencimento == null
      ? DIA_VENCIMENTO_PADRAO
      : inteiroValido(corpo.dia_vencimento, "dia_vencimento", 1, 28),
    data_inicio: corpo.data_inicio ? dataValida(corpo.data_inicio, "data_inicio") : hoje,
    data_fim: corpo.data_fim ? dataValida(corpo.data_fim, "data_fim") : null,
    observacao: textoOpcional(corpo.observacao, "observacao", 500),
  };
  if (dados.data_fim && dados.data_fim < dados.data_inicio) {
    throw new ErroHttp(400, "A data de fim precisa ser depois da data de início.");
  }
  const { turnos } = await lerHorarios(db, arena.id);
  const ini = paraMinutos(dados.hora_inicio);
  if (!dentroDoFuncionamento(turnos[dados.dia_semana], ini, ini + dados.duracao_min)) {
    throw new ErroHttp(400, "Esse dia e horário ficam fora do funcionamento da Arena.");
  }
  return dados;
}

async function upsertCliente(db, arenaId, nome, telefone) {
  const { rows: [c] } = await db.query(
    `INSERT INTO clientes (arena_id, nome, telefone) VALUES ($1, $2, $3)
     ON CONFLICT (arena_id, telefone) DO UPDATE SET nome = EXCLUDED.nome
     RETURNING id`,
    [arenaId, nome, telefone]
  );
  return c.id;
}

// cria o contrato, gera as ocorrências e devolve os conflitos com avulsas já marcadas
// (a EXCLUDE de contratos devolve 409 se outro mensalista já tem o horário)
async function criarContrato(db, arena, dados) {
  const clienteId = await upsertCliente(db, arena.id, dados.nome, dados.telefone);
  const { rows: [c] } = await db.query(
    `INSERT INTO contratos_mensalistas
       (arena_id, cliente_id, responsavel_nome, telefone, nome_grupo, dia_semana, hora_inicio,
        duracao_min, valor_mensal_centavos, dia_vencimento, data_inicio, data_fim, observacao)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING ${SELECT_CONTRATO.replaceAll("c.", "")}`,
    [arena.id, clienteId, dados.nome, dados.telefone, dados.nome_grupo, dados.dia_semana, dados.hora_inicio,
      dados.duracao_min, dados.valor_mensal_centavos, dados.dia_vencimento, dados.data_inicio,
      dados.data_fim, dados.observacao]
  );
  await garantirOcorrencias(db, arena);
  return { contrato: formatarContrato(c), conflitos: await conflitosDoContrato(db, arena, c.id) };
}

async function buscarContrato(db, arena, id, { travar = false } = {}) {
  const { rows: [c] } = await db.query(
    `SELECT ${SELECT_CONTRATO} FROM contratos_mensalistas c
      WHERE c.id = $1 AND c.arena_id = $2 ${travar ? "FOR UPDATE" : ""}`,
    [id, arena.id]
  );
  if (!c) throw new ErroHttp(404, "Mensalista não encontrado.");
  return c;
}

// GET /admin/contratos?status=ativo|pausado|encerrado  (sem status = ativos e pausados)
rotasMensalistas.get("/contratos", async (req, res) => {
  const arena = req.arena;
  const status = req.query.status ? String(req.query.status) : null;
  if (status && !["ativo", "pausado", "encerrado"].includes(status)) {
    throw new ErroHttp(400, 'Campo "status" inválido.');
  }
  await garantirOcorrencias(pool, arena);
  const { hoje } = await agoraNaArena(pool, arena);
  const { rows } = await pool.query(
    `SELECT ${SELECT_CONTRATO},
            (SELECT count(*) FROM mensalidades m
              WHERE m.contrato_id = c.id AND m.status = 'pendente' AND m.vencimento < $3::date) AS atrasadas,
            (SELECT min(o.data_ocorrencia) FROM reservas o
              WHERE o.contrato_id = c.id AND o.status = 'confirmada' AND o.inicio > now())     AS proximo_jogo,
            (SELECT count(*) FROM reservas o
              WHERE o.contrato_id = c.id AND o.status = 'conflito' AND o.inicio > now())       AS conflitos
       FROM contratos_mensalistas c
      WHERE c.arena_id = $1
        AND (($2::text IS NULL AND c.status <> 'encerrado') OR c.status = $2)
      ORDER BY c.status, c.dia_semana, c.hora_inicio`,
    [arena.id, status, hoje]
  );
  res.json(rows.map(formatarContrato));
});

// GET /admin/contratos/:id -> contrato + exceções futuras + conflitos + últimas mensalidades
rotasMensalistas.get("/contratos/:id", async (req, res) => {
  const arena = req.arena;
  const id = idValido(req.params.id, "id");
  const contrato = await buscarContrato(pool, arena, id);
  await garantirOcorrencias(pool, arena);
  const { hoje } = await agoraNaArena(pool, arena);
  const [{ rows: excecoes }, conflitos, { rows: mensalidades }] = await Promise.all([
    pool.query(
      `SELECT id, data_ocorrencia AS data, motivo FROM reservas
        WHERE contrato_id = $1 AND status = 'liberada' AND data_ocorrencia >= $2::date
        ORDER BY data_ocorrencia`,
      [id, hoje]),
    conflitosDoContrato(pool, arena, id),
    pool.query(
      `SELECT id, competencia, valor_centavos, vencimento, status, pago_em, forma_pagamento
         FROM mensalidades WHERE contrato_id = $1 ORDER BY competencia DESC LIMIT 12`,
      [id]),
  ]);
  res.json({
    ...formatarContrato(contrato),
    excecoes,
    conflitos,
    mensalidades: mensalidades.map((m) => ({ ...m, situacao: situacaoDe(m, hoje) })),
  });
});

// POST /admin/contratos
// { nome, telefone, nome_grupo?, dia_semana, hora_inicio, duracao_min, valor_mensal_centavos?,
//   dia_vencimento?, data_inicio?, data_fim?, observacao? }
// -> 201 { contrato, conflitos } (conflitos = avulsas já marcadas nesse horário; nada é apagado)
rotasMensalistas.post("/contratos", async (req, res) => {
  const arena = req.arena;
  const resultado = await transacao(async (db) => criarContrato(db, arena, await validarContrato(db, arena, req.body ?? {})));
  res.status(201).json(resultado);
});

// PATCH /admin/contratos/:id
// { acao: "editar", ...mesmos campos do POST }  | { acao: "pausar" } | { acao: "reativar" } | { acao: "encerrar" }
rotasMensalistas.patch("/contratos/:id", async (req, res) => {
  const arena = req.arena;
  const id = idValido(req.params.id, "id");
  const corpo = req.body ?? {};
  const acao = String(corpo.acao ?? "");

  const resultado = await transacao(async (db) => {
    const atual = await buscarContrato(db, arena, id, { travar: true });
    if (atual.status === "encerrado") throw new ErroHttp(409, "Esse contrato já foi encerrado.");

    switch (acao) {
      case "editar": {
        const d = await validarContrato(db, arena, corpo);
        const clienteId = await upsertCliente(db, arena.id, d.nome, d.telefone);
        await db.query(
          `UPDATE contratos_mensalistas
              SET cliente_id = $3, responsavel_nome = $4, telefone = $5, nome_grupo = $6, dia_semana = $7,
                  hora_inicio = $8, duracao_min = $9, valor_mensal_centavos = $10, dia_vencimento = $11,
                  data_inicio = $12, data_fim = $13, observacao = $14, atualizado_em = now()
            WHERE id = $1 AND arena_id = $2`,
          [id, arena.id, clienteId, d.nome, d.telefone, d.nome_grupo, d.dia_semana, d.hora_inicio,
            d.duracao_min, d.valor_mensal_centavos, d.dia_vencimento, d.data_inicio, d.data_fim, d.observacao]
        );
        // horário pode ter mudado: refaz as ocorrências futuras (exceções ficam)
        await removerOcorrenciasFuturas(db, id);
        break;
      }
      case "pausar":
        if (atual.status !== "ativo") throw new ErroHttp(409, "Só dá para pausar um contrato ativo.");
        await db.query(
          "UPDATE contratos_mensalistas SET status = 'pausado', atualizado_em = now() WHERE id = $1", [id]);
        await removerOcorrenciasFuturas(db, id);
        break;
      case "reativar":
        if (atual.status !== "pausado") throw new ErroHttp(409, "Só dá para reativar um contrato pausado.");
        await db.query(
          "UPDATE contratos_mensalistas SET status = 'ativo', atualizado_em = now() WHERE id = $1", [id]);
        break;
      case "encerrar": {
        // termina hoje (ou no início, se ainda nem começou); libera o horário para outro contrato
        const { hoje } = await agoraNaArena(db, arena);
        await db.query(
          `UPDATE contratos_mensalistas
              SET status = 'encerrado', atualizado_em = now(),
                  data_fim = GREATEST(data_inicio, LEAST(COALESCE(data_fim, $2::date), $2::date))
            WHERE id = $1`,
          [id, hoje]
        );
        await removerOcorrenciasFuturas(db, id);
        break;
      }
      default:
        throw new ErroHttp(400, 'Campo "acao" inválido.');
    }

    await garantirOcorrencias(db, arena);
    return {
      contrato: formatarContrato(await buscarContrato(db, arena, id)),
      conflitos: await conflitosDoContrato(db, arena, id),
    };
  });

  res.json(resultado);
});

/* ---------------------------------------------------------------------
   Exceções: o mensalista não joga numa data (feriado, viagem).
   O horário fica livre para avulso só naquela data; a mensalidade não muda.
--------------------------------------------------------------------- */

// POST /admin/contratos/:id/excecoes  { data, motivo? }
rotasMensalistas.post("/contratos/:id/excecoes", async (req, res) => {
  const arena = req.arena;
  const id = idValido(req.params.id, "id");
  const data = dataValida(req.body?.data);
  const motivo = textoOpcional(req.body?.motivo, "motivo", 150) ?? "Não vai jogar";

  const excecao = await transacao(async (db) => {
    const c = await buscarContrato(db, arena, id, { travar: true });
    const { hoje } = await agoraNaArena(db, arena);
    if (c.status !== "ativo") throw new ErroHttp(409, "Só dá para lançar exceção em contrato ativo.");
    if (diaDaSemana(data) !== c.dia_semana) throw new ErroHttp(400, "Essa data não cai no dia do mensalista.");
    if (data < hoje) throw new ErroHttp(400, "Essa data já passou.");
    if (data < c.data_inicio || (c.data_fim && data > c.data_fim)) {
      throw new ErroHttp(400, "Essa data fica fora do período do contrato.");
    }
    // cria já como 'liberada' (mesmo além do horizonte) ou troca a ocorrência existente
    const { rows: [r] } = await db.query(
      `INSERT INTO reservas (arena_id, origem, status, inicio, fim, contrato_id, data_ocorrencia, motivo, criado_por)
       VALUES ($1, 'mensalista', 'liberada',
               ($2::date + $3::time) AT TIME ZONE $4,
               ($2::date + $3::time) AT TIME ZONE $4 + make_interval(mins => $5),
               $6, $2, $7, $8)
       ON CONFLICT (contrato_id, data_ocorrencia)
       DO UPDATE SET status = 'liberada', motivo = EXCLUDED.motivo, atualizado_em = now()
       RETURNING id`,
      [arena.id, data, c.hora_inicio, arena.fuso_horario, c.duracao_min, id, motivo, req.conta.sub]
    );
    return { id: r.id, data, motivo, status: "liberada" };
  });

  res.status(201).json(excecao);
});

// DELETE /admin/contratos/:id/excecoes/:data -> o mensalista volta a jogar nessa data
// (se ninguém reservou o horário nesse meio-tempo)
rotasMensalistas.delete("/contratos/:id/excecoes/:data", async (req, res) => {
  const arena = req.arena;
  const id = idValido(req.params.id, "id");
  const data = dataValida(req.params.data);
  const { rowCount } = await pool.query(
    `UPDATE reservas SET status = 'confirmada', motivo = NULL, atualizado_em = now()
      WHERE contrato_id = $1 AND arena_id = $2 AND data_ocorrencia = $3 AND status = 'liberada'
        AND inicio > now()`,
    [id, arena.id, data]
  ).catch((err) => {
    if (err.code === "23P01") {
      throw new ErroHttp(409, "Esse horário já foi reservado por outra pessoa nessa data.");
    }
    throw err;
  });
  if (!rowCount) throw new ErroHttp(404, "Exceção não encontrada (ou a data já passou).");
  res.status(204).end();
});

/* ---------------------------------------------------------------------
   Solicitações "Quero ser mensalista" (vindas do site)
--------------------------------------------------------------------- */

// GET /admin/solicitacoes?status=pendente|aprovada|recusada  (padrão: pendente)
rotasMensalistas.get("/solicitacoes", async (req, res) => {
  const status = String(req.query.status ?? "pendente");
  if (!["pendente", "aprovada", "recusada"].includes(status)) throw new ErroHttp(400, 'Campo "status" inválido.');
  const { rows } = await pool.query(
    `SELECT s.id, s.nome, s.telefone, s.dia_semana, s.hora_inicio, s.duracao_min, s.observacao, s.status,
            s.contrato_id, to_char(s.criado_em AT TIME ZONE $3, 'YYYY-MM-DD HH24:MI') AS criado_em,
            -- já existe mensalista (não encerrado) que bate com o horário pedido?
            EXISTS (SELECT 1 FROM contratos_mensalistas c
                     WHERE c.arena_id = s.arena_id AND c.status <> 'encerrado' AND c.dia_semana = s.dia_semana
                       AND minutos_do_dia(c.hora_inicio) < minutos_do_dia(s.hora_inicio) + s.duracao_min
                       AND minutos_do_dia(s.hora_inicio) < minutos_do_dia(c.hora_inicio) + c.duracao_min
                  ) AS horario_ocupado
       FROM solicitacoes_mensalista s
      WHERE s.arena_id = $1 AND s.status = $2
      ORDER BY s.criado_em`,
    [req.arena.id, status, req.arena.fuso_horario]
  );
  res.json(rows.map((s) => {
    const ini = paraMinutos(s.hora_inicio);
    return { ...s, hora_inicio: paraHHMM(ini), hora_fim: paraHHMM(ini + s.duracao_min) };
  }));
});

// POST /admin/solicitacoes/:id/aprovar  { valor_mensal_centavos?, dia_vencimento?, data_inicio?, ... }
// Vira contrato com os dados do pedido (o dono pode ajustar qualquer campo no corpo).
rotasMensalistas.post("/solicitacoes/:id/aprovar", async (req, res) => {
  const arena = req.arena;
  const id = idValido(req.params.id, "id");

  const resultado = await transacao(async (db) => {
    const { rows: [s] } = await db.query(
      `SELECT nome, telefone, dia_semana, hora_inicio, duracao_min, observacao
         FROM solicitacoes_mensalista
        WHERE id = $1 AND arena_id = $2 AND status = 'pendente'
        FOR UPDATE`,
      [id, arena.id]
    );
    if (!s) throw new ErroHttp(404, "Solicitação não encontrada ou já respondida.");
    const dados = await validarContrato(db, arena, { ...s, ...(req.body ?? {}) });
    const criado = await criarContrato(db, arena, dados);
    await db.query(
      `UPDATE solicitacoes_mensalista
          SET status = 'aprovada', contrato_id = $2, respondido_em = now()
        WHERE id = $1`,
      [id, criado.contrato.id]
    );
    return criado;
  });

  res.status(201).json(resultado);
});

// POST /admin/solicitacoes/:id/recusar
rotasMensalistas.post("/solicitacoes/:id/recusar", async (req, res) => {
  const id = idValido(req.params.id, "id");
  const { rowCount } = await pool.query(
    `UPDATE solicitacoes_mensalista SET status = 'recusada', respondido_em = now()
      WHERE id = $1 AND arena_id = $2 AND status = 'pendente'`,
    [id, req.arena.id]
  );
  if (!rowCount) throw new ErroHttp(404, "Solicitação não encontrada ou já respondida.");
  res.json({ id, status: "recusada" });
});

/* ---------------------------------------------------------------------
   Mensalidades
--------------------------------------------------------------------- */
const SITUACOES = ["pendente", "atrasada", "paga", "cancelada"];

// GET /admin/mensalidades?mes=2026-10&situacao=atrasada
// -> { mes, hoje, totais, atrasadas_outros_meses, mensalidades: [...] }
rotasMensalistas.get("/mensalidades", async (req, res) => {
  const arena = req.arena;
  const { hoje } = await agoraNaArena(pool, arena);
  const mes = req.query.mes ? mesValido(req.query.mes) : hoje.slice(0, 7);
  const situacao = req.query.situacao ? String(req.query.situacao) : null;
  if (situacao && !SITUACOES.includes(situacao)) throw new ErroHttp(400, 'Campo "situacao" inválido.');

  const { rows } = await pool.query(
    `SELECT m.id, m.contrato_id, m.competencia, m.valor_centavos, m.vencimento, m.status,
            m.pago_em, m.forma_pagamento,
            c.responsavel_nome, c.nome_grupo, c.telefone, c.dia_semana, c.hora_inicio,
            c.status AS contrato_status
       FROM mensalidades m
       JOIN contratos_mensalistas c ON c.id = m.contrato_id
      WHERE m.arena_id = $1 AND m.competencia = $2::date
      ORDER BY m.vencimento, c.responsavel_nome`,
    [arena.id, competenciaDe(mes)]
  );
  const todas = rows.map((m) => ({ ...m, hora_inicio: m.hora_inicio.slice(0, 5), situacao: situacaoDe(m, hoje) }));

  const soma = (lista) => lista.reduce((t, m) => t + m.valor_centavos, 0);
  const validas = todas.filter((m) => m.status !== "cancelada");
  const totais = {
    previsto_centavos: soma(validas),
    recebido_centavos: soma(validas.filter((m) => m.status === "paga")),
    em_aberto_centavos: soma(validas.filter((m) => m.status === "pendente")),
    atrasado_centavos: soma(validas.filter((m) => m.situacao === "atrasada")),
    quantidade: Object.fromEntries(SITUACOES.map((s) => [s, todas.filter((m) => m.situacao === s).length])),
  };

  // dívida de meses anteriores, para o dono não esquecer
  const { rows: [antigas] } = await pool.query(
    `SELECT count(*) AS quantidade, COALESCE(sum(valor_centavos), 0) AS total_centavos
       FROM mensalidades
      WHERE arena_id = $1 AND status = 'pendente' AND vencimento < $3::date AND competencia < $2::date`,
    [arena.id, competenciaDe(mes), hoje]
  );

  res.json({
    mes,
    hoje,
    totais,
    atrasadas_outros_meses: antigas,
    mensalidades: situacao ? todas.filter((m) => m.situacao === situacao) : todas,
  });
});

// POST /admin/mensalidades/gerar  { mes: "2026-10" }  (idempotente)
rotasMensalistas.post("/mensalidades/gerar", async (req, res) => {
  const mes = mesValido(req.body?.mes);
  res.json(await gerarMensalidades(pool, req.arena.id, mes));
});

// PATCH /admin/mensalidades/:id
// { acao: "pagar", forma_pagamento, pago_em? } | "desfazer" | "cancelar" | "reabrir"
// | { acao: "valor", valor_centavos }  (só pendente)
const TRANSICOES_MENSALIDADE = {
  pagar: { de: "pendente", texto: "Só dá para pagar uma mensalidade pendente." },
  desfazer: { de: "paga", texto: "Só dá para desfazer uma mensalidade paga." },
  cancelar: { de: "pendente", texto: "Só dá para cancelar uma mensalidade pendente." },
  reabrir: { de: "cancelada", texto: "Só dá para reabrir uma mensalidade cancelada." },
  valor: { de: "pendente", texto: "Só dá para mudar o valor de uma mensalidade pendente." },
};

rotasMensalistas.patch("/mensalidades/:id", async (req, res) => {
  const arena = req.arena;
  const id = idValido(req.params.id, "id");
  const corpo = req.body ?? {};
  const acao = String(corpo.acao ?? "");
  const regra = TRANSICOES_MENSALIDADE[acao];
  if (!regra) throw new ErroHttp(400, 'Campo "acao" inválido.');

  // valida antes de tocar no banco
  const forma = acao === "pagar" ? formaPagamentoValida(corpo.forma_pagamento) : null;
  const valor = acao === "valor" ? centavosValido(corpo.valor_centavos, "valor_centavos") : null;
  const pagoEmInformado = acao === "pagar" && corpo.pago_em ? dataValida(corpo.pago_em, "pago_em") : null;
  const { hoje } = await agoraNaArena(pool, arena);

  const { rows: [m] } = await pool.query(
    `UPDATE mensalidades
        SET status = CASE $3::text WHEN 'pagar' THEN 'paga' WHEN 'cancelar' THEN 'cancelada'
                                   WHEN 'valor' THEN status ELSE 'pendente' END,
            pago_em = CASE WHEN $3::text = 'pagar' THEN $4::date
                           WHEN $3::text = 'valor' THEN pago_em ELSE NULL END,
            forma_pagamento = CASE WHEN $3::text = 'pagar' THEN $5::text
                                   WHEN $3::text = 'valor' THEN forma_pagamento ELSE NULL END,
            valor_centavos = COALESCE($6::int, valor_centavos)
      WHERE id = $1 AND arena_id = $2 AND status = $7
      RETURNING id, contrato_id, competencia, valor_centavos, vencimento, status, pago_em, forma_pagamento`,
    [id, arena.id, acao, pagoEmInformado ?? hoje, forma, valor, regra.de]
  );
  if (!m) {
    const { rowCount } = await pool.query("SELECT 1 FROM mensalidades WHERE id = $1 AND arena_id = $2", [id, arena.id]);
    throw rowCount ? new ErroHttp(409, regra.texto) : new ErroHttp(404, "Mensalidade não encontrada.");
  }
  res.json({ ...m, situacao: situacaoDe(m, hoje) });
});
