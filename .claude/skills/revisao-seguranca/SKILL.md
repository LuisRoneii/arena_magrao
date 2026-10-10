---
name: revisao-seguranca
description: Revisão de segurança e LGPD das mudanças atuais. Use ao terminar uma feature que mexe com login, pagamentos, reservas, mensalidades, dados de clientes, rotas de API ou banco de dados, ou quando pedirem "revisa a segurança".
---

# Revisão de segurança

Revise **apenas o que mudou** (`git diff` contra a branch principal; se não houver git, os arquivos que eu indicar). Não altere código durante a revisão: primeiro relate, depois pergunte se deve corrigir.

## Checklist

1. **Segredos**
   - Nenhuma chave, token ou senha no código, em commits ou em logs.
   - `.env*` está no `.gitignore`.
   - Segredos (`DATABASE_URL`, `JWT_SEGREDO`, Stripe `sk_`, etc.) nunca chegam ao navegador: nada secreto em `js/` nem nas respostas da API.

2. **Autenticação e autorização**
   - Toda rota privada da API (Express) verifica se o usuário está logado (JWT válido).
   - Verifica também se ele pode mexer **naquele** registro (ex.: o cliente só vê as próprias reservas; só as contas da Arena acessam o painel; faturamento e configurações só para o papel `dono`).
   - Nada de confiar em IDs ou papéis (`role`) vindos do frontend.

3. **Banco de dados (PostgreSQL)**
   - Toda query usa parâmetros (`pool.query("... WHERE id = $1", [id])`). Procure template strings ou `+` dentro de SQL; nomes de coluna/ordenação dinâmicos só a partir de uma lista fixa no código.
   - Toda query de dados filtra por `arena_id` (e pelo registro do usuário logado quando for o caso), para uma arena nunca ver dados de outra.
   - Operações que mexem em mais de uma tabela (ex.: remarcar) usam transação (`BEGIN`/`COMMIT`/`ROLLBACK`) com o mesmo client.
   - O usuário do banco na `DATABASE_URL` tem permissões mínimas: não é superusuário, não é dono das tabelas, sem `CREATE`/`DROP`. Se houver migração nova em `database/`, confira se ela concede (`GRANT`) só o necessário a esse usuário.
   - O banco não fica exposto na internet: `listen_addresses = 'localhost'` no `postgresql.conf`, `pg_hba.conf` sem `0.0.0.0/0`, porta 5432 fechada no firewall da VPS e no painel do provedor. Se não der para checar o servidor daqui, liste como "verificar manualmente".
   - Mensagens de erro do banco não vão para o cliente (o `tratarErros` em `backend/src/erros.js` devolve mensagem genérica).

4. **Entrada de dados**
   - Validação no servidor, com as funções de `backend/src/comum.js`, para todo corpo, parâmetro de rota e query string (não basta validar no formulário).
   - Texto vindo do usuário ou da API nunca vai para `innerHTML`/`insertAdjacentHTML` sem escapar; prefira `textContent`.
   - Upload: tipo e tamanho limitados.

5. **Abuso**
   - Rate limit em login, cadastro, recuperação de senha e criação de agendamento.
   - Agendamento não permite reservar horário já ocupado (checagem no servidor, não só na tela).

6. **LGPD**
   - Coleta só o necessário (nome, telefone, e-mail).
   - Dados pessoais não aparecem em logs nem em mensagens de erro.
   - Existe forma de o cliente pedir exclusão dos dados.

7. **Dependências**
   - Rode `npm audit --omit=dev` dentro de `backend/` e liste vulnerabilidades altas/críticas.

## Formato do relatório

Para cada problema: **gravidade** (crítica / alta / média / baixa), **arquivo:linha**, **o que pode acontecer** (em uma frase simples) e **como corrigir**. Termine com uma linha: "Pronto para produção" ou "Corrigir antes de publicar".
