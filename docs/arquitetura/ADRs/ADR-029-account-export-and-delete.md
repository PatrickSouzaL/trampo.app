---
tipo: adr
id: ADR-029
titulo: "Exportar e excluir a conta (F1-PORTAL-03, SR-16): exclusão por função SECURITY DEFINER do Postgres chamada por RPC com o JWT do usuário (sem service_role nem chave secret), login recente conferido no banco, exportação em JSON validado na saída, e as páginas do portal sem JS próprio"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC], sem veto, 16 condições). Contrato novo em @trampo/contracts (account). A migration no projeto real e a 1ª exclusão real são HITL."
data: 2026-11-15
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "supabase/migrations, packages/contracts (account.ts, api.ts), apps/api (rotas, casos de uso, cliente do PostgREST, limites), apps/web-portal (src/server, src/app/conta/dados, test/)"
substitui: null
relacionados: ["[ADR-018-postgres-schema-rls-and-criteria](ADR-018-postgres-schema-rls-and-criteria.md)", "[ADR-021-criteria-routes](ADR-021-criteria-routes.md)", "[ADR-026-custom-access-token-hook](ADR-026-custom-access-token-hook.md)", "[ADR-027-portal-login](ADR-027-portal-login.md)", "[ADR-028-portal-criteria](ADR-028-portal-criteria.md)", "[ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md)", "[ADR-007-api-edge](ADR-007-api-edge.md)", "[ADR-010-log-allowlist-and-telemetry](ADR-010-log-allowlist-and-telemetry.md)", "[threat-model](../threat-model.md)", "[contratos-zod](../contratos-zod.md)", "*BACKLOG §F1-PORTAL-03*"]
---

# ADR-029: Exportar e excluir a conta

## 1. Contexto

A *BACKLOG §F1-PORTAL-03* pede duas coisas que a LGPD dá ao titular e que o SR-16 do [threat-model](../threat-model.md) cobra com teste: **levar os dados** e **apagar a conta de fato**, sem resíduo. O [ADR-018-postgres-schema-rls-and-criteria](ADR-018-postgres-schema-rls-and-criteria.md) D5 previa a exclusão pela Admin API do Auth, com a chave *secret* na API. Este ADR troca esse caminho por outro, sem chave de alto privilégio, e desenha a exportação e as páginas do portal.

### 1.1 Fatos conferidos antes do desenho

Nada de memória. A coluna "Fonte" diz de onde veio cada fato. "Pilha local" é o Supabase da estação (Docker, CLI 2.120.0, Postgres 17.11, GoTrue v2.197.0, PostgREST v16.4), com o catálogo lido por `psql` e as chamadas feitas por HTTP com usuários de teste criados ali.

| # | Fato | Fonte |
|---|---|---|
| S1 | A exclusão de usuário pela Admin API (`auth.admin.deleteUser`) **exige a chave `service_role`** | documentação do Supabase (referência `auth-admin-deleteuser`), pelo MCP `search_docs` |
| S2 | Apagar a linha de `auth.users` **não encerra a sessão**: o JWT já emitido "continua válido até expirar" | documentação (guia *User Management*, "Deleting users") |
| S3 | A documentação recomenda `references auth.users on delete cascade` nas tabelas do `public`, e só referenciar **chaves primárias** das tabelas geridas pelo Supabase (as outras colunas "podem mudar a qualquer momento") | mesmo guia |
| S4 | Usuário dono de objeto no Storage não pode ser apagado. O projeto não usa Storage | mesmo guia; `supabase start -x storage-api` no CI |
| P1 | As três tabelas do `public` caem por *cascade*: `user_criteria` e `analyses` referenciam `auth.users (id)`, e `analysis_feedback` cai pela FK composta para `analyses` | migration `20261022230000` L9, L33 e L64; `pg_constraint` da pilha local |
| P2 | No `auth`, caem por *cascade* de `auth.users`: `identities`, `sessions` (e por ela `refresh_tokens` e `mfa_amr_claims`), `mfa_factors`, `one_time_tokens`, `oauth_authorizations`, `oauth_consents`, `webauthn_credentials`, `webauthn_challenges` e `mfa_recovery_code_sets` | `pg_constraint` da pilha local |
| P3 | **Dois lugares do `auth` não caem sozinhos**, porque não têm FK para `auth.users`: `auth.audit_log_entries` (o `payload` JSON traz `actor_id` e `actor_username`, que é o e-mail) e `auth.flow_state` (coluna `user_id`, com `provider_access_token` e `provider_refresh_token`) | `information_schema` e amostra da pilha local (só as chaves do `payload`) |
| P4 | O papel `postgres` (dono das migrations) tem `DELETE` em `auth.users`, `auth.flow_state` e `auth.audit_log_entries`, e tem `BYPASSRLS`; `authenticated` e `anon` não têm privilégio nenhum nessas tabelas | `information_schema.table_privileges` e `pg_roles` da pilha local |
| P5 | `auth.uid()` e `auth.jwt()` são `security invoker`, e `authenticated` pode executá-las; dentro de uma função `security definer` elas continuam lendo as claims do pedido do PostgREST | `pg_proc` e a sonda (linha D1) |
| P6 | O PostgREST só serve os schemas `public` e `graphql_public` (`[api] schemas`); `max_rows = 1000` | `supabase/config.toml` L17 e L22 |
| D1 | Um protótipo da função (em `public`, `security definer`, `search_path` vazio, `execute` só para `authenticated`), chamado por `POST /rest/v1/rpc/…` com o JWT do usuário, **apaga tudo**: 0 linhas em `auth.users`, `identities`, `sessions`, `refresh_tokens`, `audit_log_entries`, `flow_state`, `user_criteria`, `analyses` e `analysis_feedback` do usuário, e o outro usuário fica intacto | sonda `probe_delete.mjs` na pilha local (scratchpad da sessão 32) |
| D2 | Sem Bearer (`anon`): **401** com `42501`. Por `GET`: **405** com `25006` (transação só de leitura), e nada é apagado. Com um argumento a mais no corpo: **404** `PGRST202` (a função não aceita parâmetro) | mesma sonda |
| D3 | Chamada de novo com o access ainda válido do usuário apagado: 200, e a função vê que o usuário não existe (idempotente) | mesma sonda |
| D4 | **O access do usuário apagado ainda passa no PostgREST** por até 900 s (S2), mas: o `upsert` em `user_criteria` dá **409 `23503`** (a FK para `auth.users`); o `select` dá 200 com lista vazia; a renovação dá 400 e o logout dá 403 | mesma sonda |
| A1 | A API fala com o PostgREST só pelo `postgrest-user-client.ts` (chave *publishable* e o JWT do usuário; recusa `sb_secret_` e `eyJ`). Hoje ele só tem `select` e `upsert`, só para a tabela `user_criteria`, com prazo de 900 ms e teto de 32 KiB | `apps/api/src/infrastructure/supabase/postgrest-user-client.ts` |
| A2 | **Nenhum código da API lê ou grava `analyses` nem `analysis_feedback` hoje** (isso é da F1-API-06): as duas tabelas estão vazias | busca em `apps/api/src` |
| A3 | A borda aceita pedido sem `Origin` (servidor a servidor; o JWT protege). A origem da extensão só alcança as 4 rotas de `EXTENSION_ROUTES`. `CORS_ALLOWED_METHODS` é `GET, POST, PUT` (sem `DELETE`) | `apps/api/src/presentation/edge/cors.ts` |
| A4 | Classes de limite por minuto (usuário, IP): `padrao` 60 e 120, `analise` 5 e 20, `criterios` 10 e 30. Valor fora da lista cai na mais estrita | `apps/api/src/application/limits/limit-policy.ts` |
| A5 | O Redis só tem **duas** famílias de chave por usuário, as duas com o `sub` dentro de um HMAC (pseudônimo) e com TTL: `rl:<classe>:u:<pseudônimo>:<janela>` (janela de 60 s) e `quota:<pseudônimo>:<dia>` (um conjunto de `requestId`, 2 dias). O cache de análise é por hash do texto da vaga, e o *ledger* do LLM é por provedor: nenhum dos dois é por usuário | `apps/api/src/infrastructure/limits/*.ts` |
| A6 | Os erros da API saem de um catálogo fechado (`ApiErrorCodeSchema`, 10 códigos) | `packages/contracts/src/api.ts`; `apps/api/src/presentation/api-error.ts` |
| N1 | No portal, `route.ts` não convive com `page.tsx` no mesmo segmento, e a gravação segue o molde do `criteria.ts` (a DAL confere `Origin` e `Sec-Fetch-Site`, e a rota só traduz) | [ADR-028-portal-criteria](ADR-028-portal-criteria.md) D6; cuidado 37 do *TRILHAS* |
| N2 | O cookie da sessão do portal guarda o `sst` (o instante do login) | [ADR-027-portal-login](ADR-027-portal-login.md) D3 |

## 2. Decisões

### D1. Excluir: função `SECURITY DEFINER` no Postgres, chamada por RPC com o JWT do usuário (opção A)

- **(A) Escolhida.** Uma função `public.delete_own_account()` apaga a conta de quem chama. A API a chama por `POST /rest/v1/rpc/delete_own_account`, pelo cliente de usuário de sempre (A1). A regra do [ADR-018-postgres-schema-rls-and-criteria](ADR-018-postgres-schema-rls-and-criteria.md) D5, "rotas de usuário nunca usam `service_role`", fica **mais forte**: a API continua sem nenhuma chave de alto privilégio, e a chave *secret* deixa de ter uso no projeto.
- **(B) Vetada pelo `[APPSEC]`:** a Admin API do GoTrue com a chave *secret* no processo da API (S1). A *secret* apaga **qualquer** usuário e, pelo `BYPASSRLS`, é o maior segredo do projeto. Pô-la num processo exposto à internet para servir um botão é o oposto de privilégio mínimo. Com a função, o pior que um token roubado faz é apagar a conta **do próprio token**.
- **Por que em `public`:** o PostgREST só serve `public` (P6). Um schema novo exigiria mudar `[api] schemas` no `config.toml` **e no painel** do projeto real. A função não recebe parâmetro e só é executável por `authenticated`.

### D2. A função (migration nova, idempotente)

```sql
create or replace function public.delete_own_account() returns text
language plpgsql volatile security definer set search_path = ''
```

Passos, nesta ordem, todos com nomes qualificados:
1. `v_uid := auth.uid()`. Nulo: `raise exception` com `errcode` `28000` (não deveria acontecer: `anon` não tem `execute`).
2. Usuário que não existe em `auth.users`: devolve **`ja_excluida`** (D3 do §1.1). É a idempotência.
3. **Login recente (D6):** lê o `session_id` do JWT (`auth.jwt() ->> 'session_id'`), confere a forma de UUID antes do *cast* e busca `auth.sessions.created_at` **da sessão e do usuário**. Sem sessão, sem data ou com mais de **600 s**: devolve **`login_antigo`** e não apaga nada.
4. `delete from auth.flow_state where user_id = v_uid` e `delete from auth.audit_log_entries where payload ->> 'actor_id' = v_uid::text` (P3: os dois resíduos que o *cascade* não pega).
5. `delete from auth.users where id = v_uid`. O *cascade* leva o resto (P1 e P2).
6. Devolve **`excluida`**.

- **Uma transação só:** a função roda inteira dentro da transação do pedido do PostgREST. Ou tudo some, ou nada.
- **Grants:** `revoke all … from public, anon, authenticated, service_role` e depois `grant execute … to authenticated`. O dono é o `postgres` (P4).
- **Nenhuma entrada do pedido:** sem parâmetro. O alvo é sempre o `sub` do JWT que o PostgREST já verificou.
- **Dependência do schema do `auth` (S3):** os passos 3 e 4 leem colunas que não são chave primária (`sessions.created_at`, `sessions.user_id`, `flow_state.user_id`, `audit_log_entries.payload`). Se o Supabase mudar uma delas, a função **lança**, a transação desfaz e a API responde 503: falha fechada, nunca exclusão pela metade. O job `db` prende as colunas contra a versão da CLI do CI (cuidado 26: quem subir a CLI confere de novo).
- **O que o resultado não é:** a função nunca devolve dado do usuário, só uma de três palavras.

### D3. API: `POST /v1/account/delete`

- **`POST`, não `DELETE`:** o `CORS_ALLOWED_METHODS` fica como está (A3), e a rota exige corpo.
- **Corpo** (`AccountDeleteRequestSchema`, `z.strictObject`): `{ schemaVersion: 1, confirmation: "excluir minha conta" }` (literal). Defesa em profundidade: um `POST` vazio ou de outra rota não apaga nada. Teto de corpo de 256 bytes.
- **Caso de uso `DeleteAccount`** (aplicação) sobre a porta `AccountStore` (infraestrutura: o RPC). Um `AccountGuard` dá o prazo de **2.000 ms** (o cliente HTTP da conta tem 1.800 ms) e revalida a resposta, no molde do `CriteriaGuard`.
- **Cliente do PostgREST:** ganha `rpc("delete_own_account", accessToken)`. Corpo fixo `{}`, só o status 200 vale, a resposta tem teto de 64 bytes e precisa ser **exatamente** uma das três palavras. O nome da função é uma união fechada no tipo.
- **Mapa de respostas:**

| Resultado | Resposta | Por quê |
|---|---|---|
| `excluida` ou `ja_excluida` | **204**, sem corpo | repetir é seguro |
| `login_antigo` | **403 `PROIBIDO`** | o usuário precisa entrar de novo. **Sem código novo no catálogo** (A6): um código a mais no `ApiErrorCodeSchema` obrigaria a extensão a ganhar um texto para um erro que ela nunca recebe (o mapa de textos dela é exaustivo), e esta trilha não toca na extensão. Nesta rota, para quem chama sem `Origin` (o portal), o único 403 possível é este |
| qualquer outra coisa (prazo, 5xx, corpo fora da forma, conexão) | **503 `SERVICO_INDISPONIVEL`** | **não prova que nada foi apagado** |

- **Sem nova tentativa** na API. `Cache-Control: no-store` em toda resposta.
- **Registro mínimo (LGPD):** uma linha de log `conta_excluida`, sem campo nenhum (nem `sub`, nem pseudônimo), e o evento de telemetria `account` com operação e resultado. É o registro de que o pedido foi atendido, sem dado pessoal.

### D4. API: `GET /v1/account/export`

- **Resposta** (`AccountExportSchema`, `z.strictObject`, validada na saída pelo serializador):
  - `schemaVersion: 1` e `exportedAt` (data e hora ISO, UTC);
  - `criteria`: o `UserCriteria` com a **pretensão decifrada**, ou `null` para quem nunca salvou;
  - `analyses`: lista de `{ id, createdAt, decisionPath, verdict, score }`, até **500**, da mais nova para a mais velha, e `analysesTruncated`;
  - `feedback`: lista de `{ analysisId, agreement, reason, updatedAt }`, até **500**, e `feedbackTruncated`.
- **Leitura:** os critérios pelo `CriteriaGuard` que já existe; as duas listas pelo `select` do cliente de usuário, com `limit=501` (o 501º só liga o `…Truncated`), colunas explícitas e `user_id=eq.<sub>`. A RLS é a segunda barreira. O cliente da conta lê até 128 KiB.
- **Corte declarado:** 500 linhas por lista. A retenção das análises será de 90 dias (F1-API-06); quem passar de 500 vê o `…Truncated: true`, e a paginação vira item do *BACKLOG* junto com a F1-API-06. Hoje as duas listas saem vazias (A2).
- **Falha fechada:** se **qualquer** leitura falhar, 503. A exportação nunca sai pela metade parecendo completa.
- **O que NÃO entra:** log, chave, token, o cifrado da pretensão, o `kid`, o `user_id`, o e-mail e o provedor de login (ficam no serviço de autenticação; a API só conhece o `sub`), e os contadores do Redis (A5). O texto da página diz isso.
- `Cache-Control: no-store`. A pretensão em claro sai aqui, como no `GET /v1/criteria`: a rota **não** entra em `EXTENSION_ROUTES`.

### D5. Borda e limites

- **Classe nova `conta`:** 3 por minuto por usuário e 10 por IP, para as duas rotas. A exportação decifra e faz três leituras; a exclusão é destrutiva. `conta` passa a ser a classe mais estrita (`STRICTEST_RATE_LIMIT_CLASS`).
- **CORS:** nada muda. As duas rotas ficam fora de `EXTENSION_ROUTES`: a origem da extensão leva 403 na borda, antes do JWT. Um teste prende isso.
- **Nenhuma das duas gasta cota diária** (nenhuma chama LLM).

### D6. Login recente antes de excluir (decisão com o `[APPSEC]`)

- **O risco (T49):** quem copiou o cookie do portal (ou tem um access roubado) apagaria a conta da vítima, sem volta.
- **Decisão:** a exclusão exige que **a sessão do token tenha nascido há no máximo 600 s**. A conferência é **no banco** (D2 passo 3), o único lugar por onde toda exclusão passa: a função é alcançável direto pelo PostgREST com a chave *publishable*, que é pública, então uma regra só na API ou só no portal seria contornável.
- **Por que `auth.sessions.created_at`, e não o `iat` do access:** o access é renovado a cada 15 minutos, então o `iat` não prova login. A data da sessão só nasce num login de verdade, pelo IdP.
- **O portal espelha a regra** só para a experiência (N2): com `agora − sst > 600`, ele nem chama a API e mostra o aviso "saia, entre de novo e volte em até 10 minutos". A decisão continua sendo do banco.
- **Residual:** um cookie roubado nos primeiros 10 minutos da sessão ainda apaga a conta. A frase digitada não protege contra isso (o ladrão digita). Vai para a §9 do [threat-model](../threat-model.md).

### D7. O usuário apagado com o access ainda válido (até 900 s)

A API não confere revogação ([ADR-028-portal-criteria](ADR-028-portal-criteria.md) A7), e o PostgREST aceita o JWT até o `exp` (S2 e D4 do §1.1).
- **Regravar critérios:** recusado pela FK (409 `23503`); a API responde 503, e nada fica gravado. O job `db` prova.
- **Ler:** lista vazia. **Analisar uma vaga:** a leitura dos critérios vem antes da cota e do LLM e dá `CRITERIOS_NAO_CONFIGURADOS`. Nada é gasto nem gravado.
- **Renovar:** recusado pelo GoTrue. A extensão e o portal caem no "entre de novo" na renovação seguinte.
- **Entrar de novo com o mesmo provedor cria uma conta nova e vazia.** É o comportamento esperado, e o texto da confirmação avisa.

### D8. O que fica no Redis (decisão: deixar expirar)

As duas famílias de chave por usuário (A5) **não são apagadas** na exclusão:
- a chave leva um **pseudônimo** (HMAC do `sub` com segredo do servidor), não o `sub`;
- o valor é um contador, ou um conjunto de `requestId` aleatórios do cliente: nenhum dado de perfil, vaga ou critério;
- a do limite de taxa vive cerca de 2 minutos; a da cota, 2 dias;
- apagar a cota na hora daria a quem cria e apaga contas em laço uma cota nova a cada volta (T7).
Fica como residual com prazo (§9 do [threat-model](../threat-model.md)): 2 dias depois da exclusão não resta nada.

### D9. Portal: `/conta/dados` (Server Components, sem JS próprio)

- **`/conta/dados`** (página; DAL em `leitura`): explica o que a exportação traz e o que não traz, e tem:
  - o formulário **"Baixar meus dados"**, que posta em `POST /conta/dados/exportar`;
  - o link **"Excluir minha conta"** para a página de confirmação.
- **`POST /conta/dados/exportar`** (Route Handler): `Origin` exato e `Sec-Fetch-Site: same-origin`; a sessão em `gravacao` (renova antes, se preciso); um `GET /v1/account/export`; a resposta é o JSON revalidado pelo `AccountExportSchema`, com `Content-Type: application/json; charset=utf-8`, `Content-Disposition: attachment; filename="trampo-meus-dados.json"`, `Cache-Control: no-store` e `X-Content-Type-Options: nosniff`.
  - **Por `POST`:** um `GET` com o cookie `Lax` seria disparável por um link de outro site. Não vazaria nada para o atacante, mas gastaria o balde `conta` da vítima.
  - Os dados nunca passam por URL, cookie nem cache. Falha: 303 para `/conta/dados?aviso=exportacao_indisponivel`. O 401 da API segue a regra do [ADR-028-portal-criteria](ADR-028-portal-criteria.md) D4 (renovação forçada; só a recusa do GoTrue vira "entre de novo"), e a leitura **não** se repete.
- **`/conta/dados/excluir`** (página de confirmação): diz o que some (critérios, análises, avaliações, a conta e as sessões), que **não há volta**, que entrar de novo cria uma conta vazia, e que a extensão sai em até 15 minutos. Tem **o próprio formulário**, com um campo de texto, que posta em `POST /conta/dados/excluir/confirmar`. Com a sessão mais velha que 600 s, a página mostra o aviso do login recente **no lugar** do formulário.
- **`POST /conta/dados/excluir/confirmar`** (Route Handler; a DAL `account.ts`), nesta ordem:
  1. `Origin` exato e `Sec-Fetch-Site: same-origin`; senão 403, sem cookie nem rede;
  2. corpo `application/x-www-form-urlencoded` de até 1 KiB, com **exatamente** o campo `confirmacao`, uma vez; senão `exclusao_frase_errada`;
  3. a frase, depois de `trim` e em minúsculas, igual a **`excluir minha conta`**; senão `exclusao_frase_errada`, sem rede;
  4. a sessão em `gravacao`; sem sessão, a página inicial;
  5. `agora − sst > 600`: `exclusao_pede_login`, sem chamar a API (D6);
  6. **um** `POST /v1/account/delete`;
  7. 204: **o cookie da sessão é apagado** e o destino é `/?aviso=conta_excluida`.
- **Mapa de erros da exclusão** (cada um com texto próprio no catálogo; destino `/conta/dados?aviso=…`):

| O que a API disse | Aviso | Sessão |
|---|---|---|
| 204 | `conta_excluida` (na página inicial) | apagada |
| 403 `PROIBIDO` | `exclusao_pede_login` | mantida |
| 401 `NAO_AUTENTICADO` | renovação forçada: recusa do GoTrue vira a página inicial com `sessao_expirada`; senão `exclusao_indisponivel`. O `POST` não se repete | conforme a renovação |
| não chegou à API (conexão recusada, redirecionamento), 429 | `exclusao_indisponivel` ("nada foi excluído") | mantida |
| 503, 5xx, prazo, resposta cortada, status fora da tabela | **`exclusao_nao_confirmada`** | mantida |

- **O texto do "não confirmada" nunca promete:** "Não conseguimos confirmar a exclusão. Abra Seus critérios: se eles sumiram e você foi desconectado em alguns minutos, a conta foi excluída. Se continuam lá, tente de novo." (T30: nem "excluída", nem "nada foi excluído".)
- **Nenhum destino sai do pedido**, nenhum `"use client"`, e os avisos ficam num catálogo próprio (`ACCOUNT_NOTICES`).

### D10. Contrato (`packages/contracts/src/account.ts`)

`ACCOUNT_SCHEMA_VERSION = 1`, `ACCOUNT_ROUTES` (`/v1/account/export` e `/v1/account/delete`), `ACCOUNT_DELETE_CONFIRMATION`, `AccountDeleteRequestSchema`, `AccountExportSchema` (com `ExportedAnalysisSchema` e `ExportedFeedbackSchema`) e os limites em `limits.ts` (`ACCOUNT_EXPORT_MAX_ROWS = 500`, `ACCOUNT_DELETE_BODY_MAX_BYTES = 256`, `ACCOUNT_RECENT_LOGIN_SECONDS = 600`). O `ApiErrorCodeSchema` **não muda** (D3). O `AccountDeleteResultSchema` fecha as três palavras da função. Subpath novo `@trampo/contracts/account`, que o portal importa (regra `portal-contracts-subpaths`). O [contratos-zod](../contratos-zod.md) é regerado (DOC-01).

### D11. O que NÃO entra nesta trilha

A gravação de `analyses` e de `analysis_feedback` (F1-API-06), a paginação da exportação, a exportação do e-mail e do provedor, a exclusão pela extensão, o "desfazer" e qualquer prazo de carência.

## 3. Auditoria do `[APPSEC]` (sem veto, 16 condições)

**Fronteiras:** TB5 (portal → API), TB12 (navegador ↔ portal) e a do banco (API → PostgREST, RLS). **Ameaças:** T33 (CSRF: um `POST` forjado apagaria a conta), T49 e T44 (sessão roubada), T30 (falha que vira promessa), T51 (*confused deputy*), T7 (abuso de recurso) e a ficha nova **T52** (exclusão forjada ou por sessão roubada). **Requisitos:** SR-16, detalhado, e o **SR-28** novo (exportação).

**Condições (cada uma com teste):**
1. **Só a própria conta:** a função não recebe parâmetro; com dois usuários, o RPC de um não toca em nenhuma linha do outro (job `db`).
2. **`anon` e `service_role` não executam** a função; `authenticated` sim. A ACL é conferida no catálogo (job `db`).
3. **Sem resíduo (SR-16):** depois do RPC, 0 linhas do usuário em `auth.users`, `identities`, `sessions`, `refresh_tokens`, `flow_state`, `audit_log_entries`, `user_criteria`, `analyses` e `analysis_feedback` (job `db`, com uma linha plantada em cada uma).
4. **Login recente no banco:** sessão de 601 s devolve `login_antigo` e nada some; de 599 s, apaga. Token sem `session_id` na forma: `login_antigo` (job `db`).
5. **O apagado não regrava:** o `upsert` de critérios com o access do usuário apagado é recusado, e a linha não existe depois (job `db`).
6. **Idempotência:** o 2º RPC devolve `ja_excluida`; a API responde 204 nos dois.
7. **Definição presa:** `security definer`, `search_path` vazio, `volatile`, dono `postgres`, a constante de 600 s igual à do contrato (job `db`, pelo catálogo).
8. **A API nunca manda nada além do Bearer e do corpo fixo** ao RPC; a resposta fora das três palavras é 503; o `GET` na rota é 404 ou 405; corpo sem a confirmação é 400, sem tocar no banco.
9. **A extensão não alcança** nenhuma das duas rotas (403 na borda, pelo caminho cru e pelo padrão casado).
10. **Exportação validada na saída** e em falha fechada: qualquer leitura que falhe dá 503; nenhuma chave fora do schema sai; `no-store`.
11. **Classe `conta`** nas duas rotas, com os números presos por teste.
12. **SR-12:** nenhum `sub`, token, pretensão ou linha exportada em log; a linha `conta_excluida` não tem campo.
13. **Portal, CSRF:** a tabela de `Origin` e `Sec-Fetch-Site` nas duas rotas de `POST`; `GET` 405; nenhuma chamada à API.
14. **Portal, intenção:** frase errada, vazia, campo repetido ou campo a mais não chegam à API; a página de confirmação é a única que posta na rota; sessão velha não mostra o formulário.
15. **Portal, T30:** cada linha do mapa de erros do D9, com o texto certo; só o 204 apaga o cookie; um `POST` por clique.
16. **Mutação dirigida** por camada antes do push, e **a 1ª exclusão real só por HITL**, numa conta de teste.

**Residuais (§9 do [threat-model](../threat-model.md)):** o access do apagado por até 900 s (D7); o cookie roubado nos 10 primeiros minutos (D6); os contadores do Redis por até 2 dias (D8); os *logs* da plataforma do Supabase (fora do banco, com a retenção do plano); a dependência das colunas do `auth` (D2); e o e-mail fora da exportação (D4).

## 4. Plano de testes (`[QA_EVALS]`)

- **Contrato:** 100% nas 4 métricas; cada schema com os casos de chave a mais, tipo errado e limite.
- **Job `db`** (`account.db.test.ts`, só se prova no PR): as condições 1 a 7.
- **API, unidade e rota:** 100% nas 4 métricas; o cliente `rpc` contra um PostgREST simulado em socket real; o guarda (prazo, revalidação); as rotas pelo `buildApp` (condições 8 a 12).
- **Portal:** unidade 100% em `src/server` (`account.ts`, o cliente, os avisos); integração contra o `next start` com a API simulada (condições 13 a 15, cabeçalhos uma vez cada, tabela de open redirect); E2E no Edge pelo botão real, 3 rodadas (baixar o arquivo; excluir com a frase; a frase errada; o login velho; o "não confirmada").
- **Mutação:** `mut_account_api.py` (contrato, cliente, guarda, rotas), `mut_account_db.py` (a migration, contra a pilha local) e `mut_portal03.py` e `mut_portal03_edge.py` (U-, I- e Q-).

## 5. Partição em commits

1. `feat(contracts)`: `account.ts` e os limites.
2. `feat(db)`: a migration da função e o `account.db.test.ts`.
3. `feat(api)`: o `rpc` e as leituras do cliente, o `AccountStore`, o guarda, a classe `conta` e as duas rotas.
4. `feat(web-portal)`: o cliente, a DAL `account.ts`, os avisos e a unidade.
5. `feat(web-portal)`: as páginas, as rotas, a integração e o E2E.
6. `docs`.

## 6. Emendas da implementação

### 6.1 Sessão 32 (2026-11-15): o código inteiro, do contrato ao E2E

Commits: `26958d9` (contrato), `60d49a8` (banco), `045ba83` (API), `87ede4b` (núcleo do portal) e `bfda751` (páginas, rotas, integração e E2E).

**O que mudou em relação ao desenho:**
- **Sem código de erro novo (D3 e D10, emendado antes do código):** o login antigo responde 403 `PROIBIDO`. Um código a mais no `ApiErrorCodeSchema` obrigaria a extensão a ganhar um texto (o mapa `ERROR_TEXTS` dela é exaustivo), e a trilha não toca na extensão. O E2E da extensão rodou inteiro, sem mudança (146/146).
- **Sem evento de telemetria (D3):** o registro mínimo ficou só na linha de log `conta_excluida`, sem campo. O evento `account` vai para o *BACKLOG* junto com o exportador de métricas (S-5).
- **O `AccountGuard` virou o `AccountService`** (`application/account/account-service.ts`): os dois casos de uso e o guarda (prazo de 2 s e revalidação) num arquivo só, no molde do `CriteriaGuard`.
- **A classe `conta` passou a ser a mais estrita** (`STRICTEST_RATE_LIMIT_CLASS`): uma rota com classe desconhecida cai nela (3 e 10 por minuto), não mais em `analise`. Emenda no [ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md).
- **Portal, a ordem do D9:** a frase é conferida **antes** de abrir a sessão. Frase errada não renova, não grava cookie e não chama a API (um teste e um mutante prendem a ordem).
- **Portal, o sucesso também apaga o cookie do rascunho** dos critérios, além do da sessão.
- **Portal, a sessão renovada não fica recente:** o `apiAccess` devolve o `startedAt` (o `sst` do cookie, o instante do login), nunca o `iat` da última selagem. Emenda no [ADR-027-portal-login](ADR-027-portal-login.md) D3.
- **Portal, o `nosniff` do arquivo** vem dos cabeçalhos fixos do `next.config` (uma vez só, como manda o [ADR-027-portal-login](ADR-027-portal-login.md) D8); a resposta do anexo não o repete.
- **O teto do corpo da confirmação** é de 1.024 bytes (`readFormBody` ganhou o parâmetro `limit`).

**Fatos novos, medidos com o código de verdade:**
- O PostgREST v16.4 devolve o `timestamptz` com fuso e 6 casas (`2026-11-15T12:00:00.123456+00:00`). O adapter valida com `z.iso.datetime({ offset: true })` e converte para o ISO em UTC do contrato; o caso roda no job `db` contra o PostgREST real.
- Na pilha local, o filtro com o `user_id` de outro dono e o token deste devolve listas vazias (a RLS).

**Provas (`[QA_EVALS]`):**
- **Contrato:** 703 casos, 100% nas 4 métricas; mutação C- 11/11.
- **Banco:** `account.db.test.ts` com 34 casos (condições 1 a 7, e o adapter da API contra o PostgREST real), **rodado na estação contra a pilha local** (Docker, CLI 2.120.0): 34/34. Mutação `mut_account_db.py` **D- 20/20**. **A prova que vale é o job `db` do PR do 12º ciclo.**
- **API:** 3.951 casos, 100% nas 4 métricas; mutação 57/59, com 2 equivalentes (S-08: a leitura que falha cai no schema das linhas logo abaixo; R-10: o `sub` posto na linha de log é cortado pela lista fechada do log, que é a defesa de verdade).
- **Portal:** 564 casos de unidade e 100% em `src/server`; integração com 72 casos contra o `next start` (26 da conta, com as condições 13 a 15 no nome); **E2E no Edge 30/30 em 3 rodadas** (10 da conta: o arquivo baixado é lido do disco e conferido pelo contrato; a exclusão pela frase digitada; a frase errada; o login antigo; o "não confirmada"; o `GET` com 405).
- **Mutação do portal:** U- 64/64 pela unidade, I- **20/20** pela integração e Q- **8/8** pelo E2E, com rebuild. Os grupos anteriores (`mut_portal02.py` e `mut_portal04.py`) rodados de novo, sem sobrevivente novo.
- **Portão:** turbo `build typecheck lint test` em série e sem cache 22/22; depcruise sem violações (616 módulos); E2E da extensão 146/146.

**`[APPSEC]`:** as condições 1 a 15 estão cumpridas no código; a 16 (mutação antes do push) também. **A 1ª exclusão real e a migration no projeto real são o *HITL-QUEUE §HITL-045*** (runbook *conta-exportar-excluir*). A F1-PORTAL-03 fecha com o job `db` verde no PR.

**Achado do portão:** o gitleaks 8.30.1 pegou um token de teste escrito por extenso num commit ainda local (`generic-api-key`). A fixture passou a ser montada em tempo de execução e o commit foi refeito antes do push; nada foi publicado com o achado.

### 6.2 Sessão 33 (2026-11-16): o job `db` do PR #30 e o HITL-045

- **Job `db` (a prova que valia):** o PR #30 (12º ciclo do *HITL-QUEUE §HITL-037*) foi mergeado em `bc238aa` com os 4 checks verdes (run `43768876891`). O `account.db.test.ts` rodou **34 de 34** contra a pilha da CLI 2.120.0 do runner (181 casos no job). As colunas do `auth` que a função lê (cuidado 38), o `timestamptz` do PostgREST e a trilha de auditoria passaram sem ajuste.
- ***HITL-QUEUE §HITL-045* (declarado pelo humano):** o id do arquivo confere; a conferência prévia (§2) achou as 5 colunas, o `postgres` com `DELETE` nas 3 tabelas e a função ainda inexistente; a migration foi aplicada; §4.1 a §4.4 conforme (função, grants, janela do login recente e nenhum achado novo do Security Advisor além do esperado). Pelo portal, com uma conta de teste: o arquivo `trampo-meus-dados.json` com as chaves de primeiro nível certas e a pretensão; a frase errada deu `exclusao_frase_errada` sem derrubar a sessão; a exclusão deu `conta_excluida`; o usuário sumiu do Auth e a linha da `user_criteria`; ao entrar de novo, nasceu uma conta vazia, e a 2ª exclusão também deu `conta_excluida`. A loopback foi removida e conferida.
- **A condição 16 está cumprida.** Nenhum "diverge", então nada volta ao `[ARCHITECT]` nem ao `[APPSEC]`. **A *BACKLOG §F1-PORTAL-03* fica fechada no código e no projeto real.**
- **Latência (relato sem número):** o processamento da exclusão pareceu lento ao humano, dentro do aceite. O caminho tem, em série: a renovação da sessão no portal (GoTrue), o pedido do portal à API local, o RPC da API ao PostgREST do projeto (`us-east-1`, saindo do Brasil) e, dentro da função, a conferência da sessão e os `DELETE` em cascata (`auth.users` e as tabelas filhas, a auditoria e o fluxo). Com uma conta de teste quase vazia, a cascata deveria custar pouco. A hipótese da equipe é a soma das viagens de ida e volta, a medir no spike S-3 (o tempo do `POST` de confirmação pela aba Rede e, no SQL Editor, o `explain analyze` da função numa conta de teste nova, só números). O S-5 decide a região da API e do portal perto do banco (*ADR-030-hosting*).
