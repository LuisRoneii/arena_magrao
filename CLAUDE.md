# Instruções do projeto para o Claude

## Sobre
- Projeto: Arena do Magrão (@arena_do_magrao), quadra de society, uma quadra só
- Tipo: site + sistema de agendamento (reservas avulsas e mensalistas)
- Responsáveis: Luís e Anthony
- Idioma: responda e comente o código em português do Brasil.
- Base: o projeto `../barbearia-app` (ZT Barber Club). Siga os mesmos padrões.

## Stack
- Frontend: HTML, CSS e JavaScript puros (sem build), na raiz (`index.html`, `meus-agendamentos.html`, `painel.html`, `privacidade.html`, `css/`, `js/`). Fontes em `fonts/` (nada de Google Fonts).
- Backend: Node.js 20+ com Express 5 (ES modules), em `backend/`. Login do painel com bcrypt + JWT.
- Banco: PostgreSQL 14+ (usamos o 18) com `btree_gist`, acessado com `pg` puro. Esquema em `database/schema.sql`, migrações numeradas em `database/NNN-*.sql` (idempotentes).
- Deploy: VPS, site estático + API em `/api` no mesmo domínio, Nginx na frente.

## Regras de domínio que não podem quebrar
- Dinheiro sempre em **centavos (inteiro)**: colunas `*_centavos`. Nunca float.
- Datas e horas no servidor, fuso `America/Sao_Paulo` (coluna `arenas.fuso_horario`). O front nunca decide "hoje".
- Tudo que ocupa a quadra (avulsa, ocorrência de mensalista, bloqueio) é uma linha em `reservas`. A constraint `EXCLUDE` (`reservas_sem_sobreposicao`) é a garantia final contra choque de horário.
- Contratos de mensalista não se sobrepõem (`EXCLUDE` em `contratos_mensalistas`).
- Ocorrências de mensalista são geradas por `garantirOcorrencias` (idempotente). Nunca apagar reserva avulsa sozinho: conflito vira status `conflito` para o dono resolver.

## Comandos (dentro de `backend/`)
- Instalar: `npm install`
- Rodar local: `npm run dev`
- Testes: `npm test` (unitários + integração; a integração precisa de `DATABASE_URL_TESTE` no `.env`)
- Conta do painel: `npm run criar-admin`
- Mensalidades do mês: `npm run gerar-mensalidades [AAAA-MM]`

Sempre rode `npm test` antes de dizer que uma tarefa terminou.

## Git e GitHub
- Commits locais, um por etapa, com mensagens descritivas.
- **Nunca faça `git push`, nunca crie issues nem pull requests.** Entregue título e descrição do PR.

## Design
- Tokens em `:root` de `css/style.css` (`--fundo`, `--neon`, `--amarelo`, `--azul`…). Nada de cor solta.
- Verde neon = ação; amarelo = impacto; azul = faixas e etiquetas. Texto sobre neon e amarelo é preto.
- Celular primeiro (360px), contraste AA, foco visível, `prefers-reduced-motion`.
- Não inventar depoimentos, números nem dados do cliente: use `[PREENCHER: ...]`.

## Segurança (obrigatório)
- Segredos só no `backend/.env` (fora do git).
- Toda query parametrizada (`$1, $2…`) e filtrada por `arena_id`.
- Valide toda entrada no servidor com as funções de `backend/src/comum.js`.
- Rotas do painel: `exigirLogin`; faturamento e configurações: `exigirPapel("dono")`.
- Texto vindo do usuário ou da API nunca vai para `innerHTML` sem `esc()`.
- LGPD: coletar só nome e WhatsApp, nada de dados pessoais em log, scripts em `database/lgpd/`.
- Ao terminar algo que mexe com auth, pagamentos ou dados pessoais, rode a habilidade `revisao-seguranca`.
- Antes do primeiro deploy: rodar a varredura do plugin claude-security (avise o Luís).
