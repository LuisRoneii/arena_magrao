-- =====================================================================
-- ARENA DO MAGRÃO — schema do banco (PostgreSQL 14+)
-- Rodar num banco vazio:  psql -U postgres -d arena_magrao -f database/schema.sql
-- Modelagem explicada em docs/database-schema.md
-- =====================================================================

-- extensão que permite as regras "sem sobreposição" (EXCLUDE com = em colunas comuns)
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- "20:30" -> 1230 (minutos desde a meia-noite; '24:00' -> 1440).
-- IMMUTABLE para poder ser usada nas constraints EXCLUDE abaixo.
CREATE OR REPLACE FUNCTION minutos_do_dia(t TIME) RETURNS INT
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT (EXTRACT(EPOCH FROM t) / 60)::int $$;

-- ---------------------------------------------------------------------
-- arenas: o cliente do sistema e as configurações editáveis no painel
-- ---------------------------------------------------------------------
CREATE TABLE arenas (
  id                               SERIAL PRIMARY KEY,
  nome                             VARCHAR(150) NOT NULL,
  slug                             VARCHAR(100) NOT NULL UNIQUE,
  fuso_horario                     VARCHAR(50)  NOT NULL DEFAULT 'America/Sao_Paulo',
  whatsapp                         VARCHAR(11),      -- só dígitos, com DDD, sem 55
  instagram                        VARCHAR(60),      -- sem @
  endereco                         VARCHAR(255),
  link_mapa                        VARCHAR(500),     -- link do Google Maps (sem iframe no site)
  pix_chave                        VARCHAR(150),
  antecedencia_reserva_min         INT NOT NULL DEFAULT 120
                                   CHECK (antecedencia_reserva_min BETWEEN 0 AND 10080),
  antecedencia_cancelamento_horas  INT NOT NULL DEFAULT 12
                                   CHECK (antecedencia_cancelamento_horas BETWEEN 0 AND 720),
  janela_reserva_dias              INT NOT NULL DEFAULT 30
                                   CHECK (janela_reserva_dias BETWEEN 1 AND 90),
  duracoes_permitidas              INT[] NOT NULL DEFAULT '{60,90,120}'
                                   CHECK (cardinality(duracoes_permitidas) > 0
                                          AND duracoes_permitidas <@ '{30,60,90,120,150,180}'::int[]),
  intervalo_grade_min              INT NOT NULL DEFAULT 30 CHECK (intervalo_grade_min IN (15, 30, 60)),
  mensalidade_padrao_centavos      INT NOT NULL DEFAULT 0 CHECK (mensalidade_padrao_centavos >= 0),
  max_reservas_futuras             INT NOT NULL DEFAULT 3 CHECK (max_reservas_futuras BETWEEN 1 AND 20),
  criado_em                        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- funcionamento: horários de abertura por dia da semana.
-- Dia sem linha = fechado. Dois turnos no mesmo dia = pausa entre eles.
-- hora_fim pode ser '24:00' (fecha à meia-noite).
-- ---------------------------------------------------------------------
CREATE TABLE funcionamento (
  id           SERIAL PRIMARY KEY,
  arena_id     INT NOT NULL REFERENCES arenas(id),
  dia_semana   SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),  -- 0 = domingo
  hora_inicio  TIME NOT NULL,
  hora_fim     TIME NOT NULL,
  CHECK (hora_fim > hora_inicio),
  CONSTRAINT funcionamento_sem_sobreposicao EXCLUDE USING gist (
    arena_id WITH =, dia_semana WITH =,
    int4range(minutos_do_dia(hora_inicio), minutos_do_dia(hora_fim)) WITH &&
  )
);

-- ---------------------------------------------------------------------
-- faixas_preco: preço por hora conforme dia e horário (normal × nobre).
-- A API exige que as faixas cubram todo o funcionamento.
-- ---------------------------------------------------------------------
CREATE TABLE faixas_preco (
  id                   SERIAL PRIMARY KEY,
  arena_id             INT NOT NULL REFERENCES arenas(id),
  dia_semana           SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  hora_inicio          TIME NOT NULL,
  hora_fim             TIME NOT NULL,
  preco_hora_centavos  INT NOT NULL CHECK (preco_hora_centavos >= 0),
  nobre                BOOLEAN NOT NULL DEFAULT FALSE,
  CHECK (hora_fim > hora_inicio),
  CONSTRAINT faixas_preco_sem_sobreposicao EXCLUDE USING gist (
    arena_id WITH =, dia_semana WITH =,
    int4range(minutos_do_dia(hora_inicio), minutos_do_dia(hora_fim)) WITH &&
  )
);

-- ---------------------------------------------------------------------
-- clientes: identificados pelo WhatsApp (sem conta, sem senha)
-- ---------------------------------------------------------------------
CREATE TABLE clientes (
  id         SERIAL PRIMARY KEY,
  arena_id   INT NOT NULL REFERENCES arenas(id),
  nome       VARCHAR(150) NOT NULL,
  telefone   VARCHAR(20)  NOT NULL,   -- 11 dígitos; "removido-<id>" depois da anonimização (LGPD)
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (arena_id, telefone),
  UNIQUE (arena_id, id)
);

-- ---------------------------------------------------------------------
-- contas_admin: quem entra no painel. "funcionario" não vê faturamento
-- nem configurações.
-- ---------------------------------------------------------------------
CREATE TABLE contas_admin (
  id          SERIAL PRIMARY KEY,
  arena_id    INT NOT NULL REFERENCES arenas(id),
  nome        VARCHAR(150) NOT NULL,
  email       VARCHAR(150) NOT NULL,
  senha_hash  VARCHAR(255) NOT NULL,
  papel       VARCHAR(20)  NOT NULL CHECK (papel IN ('dono', 'funcionario')),
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (arena_id, email),
  UNIQUE (arena_id, id)
);

-- ---------------------------------------------------------------------
-- contratos_mensalistas: horário fixo toda semana, com mensalidade.
-- Dois contratos não encerrados nunca ocupam o mesmo dia e horário
-- em períodos que se cruzam (pausado continua segurando a vaga).
-- ---------------------------------------------------------------------
CREATE TABLE contratos_mensalistas (
  id                     SERIAL PRIMARY KEY,
  arena_id               INT NOT NULL REFERENCES arenas(id),
  cliente_id             INT NOT NULL,
  responsavel_nome       VARCHAR(150) NOT NULL,   -- copiado do cliente na hora (como na barbearia)
  telefone               VARCHAR(20)  NOT NULL,
  nome_grupo             VARCHAR(100),            -- ex.: "Turma da quarta" (opcional)
  dia_semana             SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  hora_inicio            TIME NOT NULL,
  duracao_min            INT  NOT NULL CHECK (duracao_min BETWEEN 30 AND 240),
  valor_mensal_centavos  INT  NOT NULL CHECK (valor_mensal_centavos >= 0),
  dia_vencimento         SMALLINT NOT NULL CHECK (dia_vencimento BETWEEN 1 AND 28),
  data_inicio            DATE NOT NULL,
  data_fim               DATE,                    -- NULL = sem data para acabar
  status                 VARCHAR(20) NOT NULL DEFAULT 'ativo'
                         CHECK (status IN ('ativo', 'pausado', 'encerrado')),
  observacao             VARCHAR(500),
  criado_em              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (data_fim IS NULL OR data_fim >= data_inicio),
  CHECK (minutos_do_dia(hora_inicio) + duracao_min <= 1440),   -- não atravessa a meia-noite
  UNIQUE (arena_id, id),
  FOREIGN KEY (arena_id, cliente_id) REFERENCES clientes (arena_id, id),
  CONSTRAINT contratos_sem_sobreposicao EXCLUDE USING gist (
    arena_id WITH =, dia_semana WITH =,
    int4range(minutos_do_dia(hora_inicio), minutos_do_dia(hora_inicio) + duracao_min) WITH &&,
    daterange(data_inicio, data_fim, '[]') WITH &&
  ) WHERE (status <> 'encerrado')
);

-- ---------------------------------------------------------------------
-- solicitacoes_mensalista: pedidos "Quero ser mensalista" do site.
-- Não reservam nada: o dono aprova (vira contrato) ou recusa.
-- ---------------------------------------------------------------------
CREATE TABLE solicitacoes_mensalista (
  id                     SERIAL PRIMARY KEY,
  arena_id               INT NOT NULL REFERENCES arenas(id),
  nome                   VARCHAR(150) NOT NULL,
  telefone               VARCHAR(20)  NOT NULL,
  dia_semana             SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  hora_inicio            TIME NOT NULL,
  duracao_min            INT  NOT NULL CHECK (duracao_min BETWEEN 30 AND 240),
  observacao             VARCHAR(500),
  status                 VARCHAR(20) NOT NULL DEFAULT 'pendente'
                         CHECK (status IN ('pendente', 'aprovada', 'recusada')),
  contrato_id            INT,
  aceite_privacidade_em  TIMESTAMPTZ NOT NULL,
  criado_em              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  respondido_em          TIMESTAMPTZ,
  CHECK ((status = 'aprovada') = (contrato_id IS NOT NULL)),
  FOREIGN KEY (arena_id, contrato_id) REFERENCES contratos_mensalistas (arena_id, id)
);

-- ---------------------------------------------------------------------
-- reservas: TUDO o que ocupa a quadra, numa tabela só
--   origem 'site' | 'painel'  -> reserva avulsa
--   origem 'mensalista'       -> ocorrência semanal de um contrato (gerada pela API)
--   origem 'bloqueio'         -> manutenção, evento, torneio
-- status
--   'confirmada' ocupa a quadra (só ela entra na regra de sobreposição)
--   'cancelada'  liberou o horário
--   'liberada'   exceção do mensalista: não joga nesta data (mensalidade não muda)
--   'conflito'   ocorrência de mensalista que bateu com uma avulsa já marcada;
--                fica esperando o dono decidir (nada é apagado sozinho)
-- ---------------------------------------------------------------------
CREATE TABLE reservas (
  id                     SERIAL PRIMARY KEY,
  arena_id               INT NOT NULL REFERENCES arenas(id),
  origem                 VARCHAR(20) NOT NULL
                         CHECK (origem IN ('site', 'painel', 'mensalista', 'bloqueio')),
  status                 VARCHAR(20) NOT NULL DEFAULT 'confirmada'
                         CHECK (status IN ('confirmada', 'cancelada', 'liberada', 'conflito')),
  inicio                 TIMESTAMPTZ NOT NULL,
  fim                    TIMESTAMPTZ NOT NULL,
  cliente_id             INT,
  cliente_nome           VARCHAR(150),
  cliente_telefone       VARCHAR(20),
  contrato_id            INT,
  data_ocorrencia        DATE,                   -- só mensalista: a data (local) daquela semana
  motivo                 VARCHAR(150),           -- bloqueio; ou motivo da exceção do mensalista
  valor_centavos         INT NOT NULL DEFAULT 0 CHECK (valor_centavos >= 0),
  pago_em                DATE,
  forma_pagamento        VARCHAR(20) CHECK (forma_pagamento IN ('pix', 'dinheiro', 'cartao')),
  codigo                 CHAR(10) UNIQUE,        -- código da reserva (Crockford base32), só avulsa
  aceite_privacidade_em  TIMESTAMPTZ,            -- quando o cliente aceitou a política (site)
  observacao             VARCHAR(255),
  criado_por             INT,                    -- conta do painel que lançou (NULL = site/sistema)
  criado_em              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  atualizado_em          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (fim > inicio),
  -- cada origem com os campos que fazem sentido para ela
  CHECK (CASE origem
           WHEN 'mensalista' THEN contrato_id IS NOT NULL AND data_ocorrencia IS NOT NULL
                                  AND codigo IS NULL AND cliente_id IS NULL
           WHEN 'bloqueio'   THEN contrato_id IS NULL AND data_ocorrencia IS NULL
                                  AND motivo IS NOT NULL AND codigo IS NULL AND cliente_id IS NULL
           ELSE                   contrato_id IS NULL AND data_ocorrencia IS NULL
                                  AND cliente_nome IS NOT NULL
         END),
  CHECK (status NOT IN ('liberada', 'conflito') OR origem = 'mensalista'),
  -- pagamento: só reserva avulsa, e data e forma andam juntas
  CHECK ((pago_em IS NULL) = (forma_pagamento IS NULL)),
  CHECK (pago_em IS NULL OR origem IN ('site', 'painel')),

  FOREIGN KEY (arena_id, cliente_id)  REFERENCES clientes (arena_id, id),
  FOREIGN KEY (arena_id, contrato_id) REFERENCES contratos_mensalistas (arena_id, id),
  FOREIGN KEY (arena_id, criado_por)  REFERENCES contas_admin (arena_id, id),

  -- uma ocorrência por contrato por data: gerar de novo não duplica, e a exceção
  -- (status 'liberada') sobrevive às regerações
  CONSTRAINT reservas_ocorrencia_unica UNIQUE (contrato_id, data_ocorrencia),

  -- A REGRA PRINCIPAL: nada confirmado se sobrepõe na quadra
  -- (avulsa × avulsa, avulsa × mensalista, qualquer coisa × bloqueio)
  CONSTRAINT reservas_sem_sobreposicao
    EXCLUDE USING gist (arena_id WITH =, tstzrange(inicio, fim) WITH &&)
    WHERE (status = 'confirmada')
);

CREATE INDEX idx_reservas_arena_inicio   ON reservas (arena_id, inicio);
CREATE INDEX idx_reservas_telefone       ON reservas (arena_id, cliente_telefone);
CREATE INDEX idx_reservas_cliente        ON reservas (cliente_id);

-- ---------------------------------------------------------------------
-- mensalidades: uma por contrato por mês (competencia = dia 1 do mês).
-- "atrasada" não é gravada: é pendente com vencimento já passado
-- (calculado na API, no fuso da Arena).
-- ---------------------------------------------------------------------
CREATE TABLE mensalidades (
  id               SERIAL PRIMARY KEY,
  arena_id         INT NOT NULL REFERENCES arenas(id),
  contrato_id      INT NOT NULL,
  competencia      DATE NOT NULL CHECK (EXTRACT(DAY FROM competencia) = 1),
  valor_centavos   INT  NOT NULL CHECK (valor_centavos >= 0),
  vencimento       DATE NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'pendente'
                   CHECK (status IN ('pendente', 'paga', 'cancelada')),
  pago_em          DATE,
  forma_pagamento  VARCHAR(20) CHECK (forma_pagamento IN ('pix', 'dinheiro', 'cartao')),
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'paga') = (pago_em IS NOT NULL)),
  CHECK ((pago_em IS NULL) = (forma_pagamento IS NULL)),
  CONSTRAINT mensalidades_uma_por_mes UNIQUE (contrato_id, competencia),
  FOREIGN KEY (arena_id, contrato_id) REFERENCES contratos_mensalistas (arena_id, id)
);

CREATE INDEX idx_mensalidades_arena_competencia ON mensalidades (arena_id, competencia);
CREATE INDEX idx_contratos_cliente              ON contratos_mensalistas (cliente_id);
