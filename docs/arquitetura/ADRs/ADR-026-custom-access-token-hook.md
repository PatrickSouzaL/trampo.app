---
tipo: adr
id: ADR-026
titulo: "Custom Access Token Hook por migration (F1-DB-02): função plpgsql em schema próprio que recusa a emissão de token quando a sessão passa de 86.400 s, com grants só para supabase_auth_admin, recusa pelo objeto error (403) e falha fechada (500) no evento fora da forma"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC], sem veto) dentro do ADR-004 D5 (emenda do HITL-035), que já tinha decidido o hook. Não muda contrato público, código de produção da API nem da extensão. A aplicação no projeto real é o HITL-040."
data: 2026-11-12
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "supabase/migrations/20261112210000_custom_access_token_hook.sql, supabase/config.toml, apps/api/test/db/auth-hook.db.test.ts, apps/api/test/db/support/{local-stack,auth-stack,catalog-sql}.ts, packages/ci-policy/test/repo-workflows.test.ts"
substitui: null
relacionados: ["[ADR-004-extension-auth](ADR-004-extension-auth.md)", "[ADR-018-postgres-schema-rls-and-criteria](ADR-018-postgres-schema-rls-and-criteria.md)", "[ADR-019-ci-github-actions](ADR-019-ci-github-actions.md)", "[threat-model](../threat-model.md)", "*BACKLOG §F1-DB-02*", "*HITL-QUEUE §HITL-040*", "*supabase-hook-real*"]
---

# ADR-026: Custom Access Token Hook por migration

## 1. Contexto

O [ADR-004-extension-auth](ADR-004-extension-auth.md) D5 (emenda do HITL-035) decidiu que a idade máxima da sessão (24 h) também vale **fora do BFF**: um Custom Access Token Hook recusa a emissão quando `auth.sessions.created_at` passa de `AUTH_SESSION_MAX_AGE_SECONDS`. Sem ele seguem abertos o T48 (sessão criada direto no GoTrue pelo atacante), a sessão órfã e a chave de selagem vazada junto com o `storage.session` (ADR-004 §3). O P18 confirmou o hook no plano Free. Esta trilha (F1-DB-02) entrega a função por migration, a prova no job `db` e o HITL de aplicação.

**Por que ADR próprio, e não emenda ao D5:** o objeto é um artefato de banco com ciclo próprio (migration, grants, runbook e HITL), no molde do [ADR-018-postgres-schema-rls-and-criteria](ADR-018-postgres-schema-rls-and-criteria.md). O ADR-004 já passa de 230 KB e é o único arquivo CRLF do cofre; o D5, o §4.3 e o §4.10 ganham só uma emenda curta que aponta para cá.

### 1.1 Fatos conferidos antes do desenho

A estação não sobe a pilha local. Cada fato abaixo tem a fonte; os do GoTrue vêm do código da versão que a CLI 2.120.0 fixa (`supabase/gotrue:v2.197.0`, no `apps/cli-go/pkg/config/templates/Dockerfile` da tag `v2.120.0` do `supabase/cli`), lido pela API do GitHub na tag `v2.197.0` do `supabase/auth`.

| # | Fato | Fonte |
|---|---|---|
| F1 | O hook roda **dentro da transação** que emite o token, em toda emissão: troca PKCE, senha e renovação (`GenerateAccessToken`, chamado por `IssueRefreshToken` e por `RefreshTokenGrant`). O evento é `{ metadata, user_id, claims, authentication_method }` | `internal/tokens/service.go`; `internal/hooks/v0hooks/v0hooks.go` |
| F2 | A chamada é `set local statement_timeout TO '2000'` e `select "<schema>"."<função>"(?)`, na conexão do GoTrue (papel `supabase_auth_admin`). O nome sai da URI `pg-functions://<db>/<schema>/<função>`, e schema e função precisam casar `^[a-zA-Z_][a-zA-Z0-9_]{0,62}$` | `internal/hooks/hookspgfunc/hookspgfunc.go`; `internal/conf/configuration.go` |
| F3 | A recusa é o objeto `{ "error": { "http_code", "message" } }`. **Só conta como erro com `message` não vazia**; sem `http_code`, vale 500. Vira `HTTPError{ HTTPStatus, Message }` sem `ErrorCode` | `internal/hooks/hookserrors/hookserrors.go` |
| F4 | Sem o cabeçalho `X-Supabase-Api-Version`, o `HTTPError` sai como `{ code, error_code, msg }`; `error_code` vazio vira `unexpected_failure` no 500 e `unknown` nos demais | `internal/api/errors.go` (`handleResponseErrorHTTP`) |
| F5 | `raise exception` (SQLSTATE `P0001`) vira 500 com o corpo `{ code: "P0001", message }`, **sem `error_code`**; `raise ... using errcode = 'PT403'` vira 403 com o mesmo corpo sem `error_code` | `internal/utilities/postgres.go`; `internal/api/errors.go` |
| F6 | A saída precisa de `claims` objeto (senão 500 `output claims field is missing`) e passa por um JSON Schema que exige `aud`, `exp`, `iat`, `sub`, `email`, `phone`, `role`, `aal`, `session_id` e `is_anonymous`. As claims devolvidas viram o token inteiro (`jwt.MapClaims(output.Claims)`) | `internal/hooks/v0hooks/v0hooks.go`; `internal/tokens/service.go` (`validateTokenClaims`) |
| F7 | A recusa na renovação desfaz a transação: o refresh **não é consumido** nem rotacionado, e a sessão segue em `auth.sessions` (inútil: toda emissão seguinte é recusada) | `internal/tokens/service.go` (`RefreshTokenGrant`: o `httpErr` sai de dentro do `db.Transaction`) |
| F8 | Na troca e no login, a sessão nasce **na mesma transação** do hook (`models.NewSession` + `tx.Create`), com `created_at` do relógio do GoTrue. A recusa por idade na emissão inicial não é alcançável; só a renovação é | `internal/tokens/service.go` (`IssueRefreshToken`); `internal/models/sessions.go` |
| F9 | `auth.sessions` tem RLS ligada (não forçada) e nenhuma policy; `created_at` aceita nulo. O dono das tabelas do `auth` é o `supabase_auth_admin` (o GoTrue roda as migrations com ele), então ele lê a tabela sem grant novo | `migrations/20220811173540_add_sessions_table.up.sql`; `migrations/20240612123726_enable_rls_update_grants.up.sql` |
| F10 | O limite nativo (`[auth.sessions] timebox`) existe no GoTrue, mas no projeto hospedado é do plano Pro. Por isso o hook | `internal/models/sessions.go` (`CheckValidity`); `supabase/config.toml` (bloco comentado) |
| F11 | A CLI passa `[auth.hook.custom_access_token]` ao GoTrue como `GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED` e `_URI`; para `pg-functions`, `secrets` é proibido. O GoTrue local conecta como `supabase_auth_admin` com a senha do banco local | `apps/cli/src/commands/start/services/gotrue.service.ts`; `apps/cli-go/pkg/config/config.go` (`hookConfig.validate`) |
| F12 | Documentação oficial: o hook está no Free; a função recebe `event jsonb` e devolve `jsonb`; os grants recomendados são `execute` para `supabase_auth_admin` e `revoke` de `authenticated`, `anon` e `public`; o painel aplica esses grants ao ligar o hook | `supabase.com/docs/guides/auth/auth-hooks` e `/auth-hooks/custom-access-token-hook` (MCP `search_docs`, 2026-11-12) |

## 2. Decisões

### D1. Objeto: `trampo_hooks.custom_access_token(event jsonb) returns jsonb`
- **Schema próprio `trampo_hooks`**, fora do `public` e fora de `[api] schemas` (`public`, `graphql_public`). O PostgREST não o enxerga: não há RPC para papel nenhum. O schema `auth` fica de fora porque é gerido pelo Supabase.
- **`language plpgsql`**, uma função só, sem tabela, sem gatilho e sem outro objeto.
- **`security invoker`** (o padrão, escrito por extenso). Quem chama é o `supabase_auth_admin`, que já é dono de `auth.sessions` (F9): não há privilégio a emprestar. Com `security definer`, a função rodaria como `postgres`, e um `execute` concedido por engano daria leitura de `auth.sessions` a quem o recebesse; com `invoker`, esse papel ainda precisaria do próprio acesso à tabela (segunda barreira).
- **`set search_path = ''`** e nomes qualificados (`auth.sessions`). O `pg_catalog` continua implícito, então operadores e funções nativas resolvem. O papel `supabase_auth_admin` tem `search_path` próprio (`auth`): o `set` da função tira qualquer dependência dele.
- **`stable`**: a função só lê. O Postgres recusa escrita em função não volátil, o que impede uma edição futura de gravar por engano dentro da transação do token.
- **Assinatura:** `(event jsonb) returns jsonb`, a que o GoTrue chama (F2).

### D2. Regra
Recusa quando `auth.sessions.created_at < now() − 86.400 s`, lendo a sessão pelo `claims.session_id` do evento. Exatamente 86.400 s **passa**; qualquer coisa acima recusa. O `now()` é o do banco, na transação do token.

| Evento | Resposta | Por quê |
|---|---|---|
| Sessão com até 86.400 s | `{ "claims": <as claims do evento, sem mexer> }` | Emissão normal |
| Sessão com mais de 86.400 s | recusa **403** | A regra do D5 |
| Sessão que não existe em `auth.sessions` (`session_id` uuid sem linha) | recusa **403** | A sessão foi apagada: é o mesmo "não" do `session_not_found`. Novo login resolve, sem laço |
| `created_at` nulo (a coluna aceita, F9) | recusa **403** | Idade impossível de provar: falha fechada para essa sessão. Novo login cria uma sessão com data |
| `event` nulo, sem `claims`, `claims` que não é objeto, sem `session_id`, `session_id` que não é uuid minúsculo canônico | falha fechada **500** | Não é um "não" a esta sessão: é desvio de formato (versão nova do GoTrue, hook ligado em função errada). Com 403, a API responderia 401 a **todos**, o SW apagaria as sessões e o novo login também falharia: laço de relogin (T30). Com 500, ninguém recebe token (falha fechada) e a API responde 503, que mantém a sessão |
| `authentication_method` desconhecido, ausente ou de outro tipo | a regra da idade, igual | A função não lê o campo: a idade vale para todo método (senha, OAuth, renovação, anônimo e os futuros) |
| `created_at` no futuro (relógio do GoTrue adiantado) | passa | Idade negativa não passa do limite |

- **"Deixar passar sem mexer" nunca é a resposta a um evento fora da forma:** seria falha aberta (token sem sessão conferida). As duas saídas são recusar (403) ou indisponível (500).
- **As claims voltam exatamente como vieram.** A função devolve `jsonb_build_object('claims', event -> 'claims')`: não acrescenta, não tira e não reordena por conta própria (o `jsonb` normaliza a ordem das chaves, que não tem significado em JSON). O resto do evento (`metadata`, `user_id`) não volta. **Única exceção (emenda da sessão 26, §6.1):** o `aud` em lista de uma string só volta como essa string.
- **O `session_id` é conferido por regex antes do cast** (`^[0-9a-f]{8}-…-[0-9a-f]{12}$`, a forma que o `uuid.String()` do GoTrue emite). Um cast direto lançaria exceção num valor hostil; a regra desta função é nunca lançar por dado de entrada.

### D3. Recusa
- **Sempre o objeto** `{ "error": { "http_code", "message" } }`, **nunca `raise exception`** (F5: o corpo de erro do Postgres não tem `error_code`; o adapter leria `nao_recebido` e a renovação daria 503 sem fim, com a sessão morta presa no cliente).
- **403** com a mensagem fixa `sessao acima da idade maxima`; **500** com a mensagem fixa `evento do hook fora do formato esperado`. Sem dado da sessão, do usuário ou do evento; ASCII. A mensagem não vazia é obrigatória (F3): com ela vazia, o GoTrue não vê erro.
- **Caminho até o cliente:** o GoTrue responde 403 `{ code: 403, error_code: "unknown", msg }` (F4). O `gotrue-token-client` exige só um `error_code` string num status de recusa: `recusado`. O `RefreshSession` responde 401 `NAO_AUTENTICADO`, e o SW apaga a sessão (ADR-004 D11.3). O `msg` e o `error_code` morrem no adapter.
- **O 500** sai como `{ code: 500, error_code: "unexpected_failure", msg }`: status fora do conjunto de recusa, `nao_recebido`, 503 `SERVICO_INDISPONIVEL`, sessão mantida.
- **A recusa não consome o refresh** (F7). A sessão recusada fica em `auth.sessions` até o logout ou a exclusão da conta; ela nunca mais emite token.

### D4. Constante
- **86.400 literal na função**, numa constante `interval` (`make_interval(secs => 86400)`). Sem função `immutable` à parte: seria mais um objeto e mais um par de grants para guardar um número.
  - `make_interval(secs => …)` guarda só segundos. `interval '1 day'` dependeria do fuso da sessão na virada do horário de verão.
- **Preso ao padrão da API por dois testes** no `test:db`:
  1. o valor lido do banco: o `secs => N` do `pg_get_functiondef` é igual a `AUTH_SESSION_LIMITS.maxAgeSeconds.fallback`;
  2. o comportamento no limite exato: numa transação só (o `now()` não anda), com `created_at = now() − fallback`, passa; com `fallback + 1` e com `fallback` mais 1 microssegundo, recusa.
- **Se o humano mudar `AUTH_SESSION_MAX_AGE_SECONDS` sem mudar a migration, os dois limites valem e o menor ganha:**
  - variável **abaixo** de 86.400: a API recusa antes, sem rede (envelope), e a sessão fica órfã no GoTrue até as 24 h do hook;
  - variável **acima** de 86.400 (a faixa do D5 vai até 604.800): o hook recusa a renovação nas 24 h, e a configuração maior não tem efeito.
- **Sem aviso no boot.** A API não tem como saber se o hook está aplicado: ela não lê o catálogo do banco (só PostgREST com o token do usuário). Um aviso seria um palpite. O desvio fica documentado no runbook *supabase-hook-real* e no `.env.example`, e a *BACKLOG §F1-API-09* propõe baixar o teto da variável para 86.400 quando o HITL-040 fechar (o boot passaria a recusar o valor que o hook anula).

### D5. Grants
```sql
revoke all on schema trampo_hooks from public, anon, authenticated, service_role;
revoke all on function trampo_hooks.custom_access_token(jsonb) from public, anon, authenticated, service_role;
grant usage on schema trampo_hooks to supabase_auth_admin;
grant execute on function trampo_hooks.custom_access_token(jsonb) to supabase_auth_admin;
```
- O `revoke` do `public` na função é o que importa (toda função nasce com `execute` para `PUBLIC`); os outros são defesa em profundidade, como no ADR-018 D3.
- **Nenhum grant em `auth.sessions`:** o `supabase_auth_admin` é o dono (F9). O `test:db` confere o dono e o privilégio pelo catálogo.
- **Nenhuma policy.** Um grant ou uma policy a mais é veto.
- A ACL do schema e a da função são conferidas por igualdade exata no catálogo (`aclexplode`): dono e `supabase_auth_admin`, mais ninguém.

### D6. Migration
`supabase/migrations/20261112210000_custom_access_token_hook.sql`, no estilo da primeira (cabeçalho com ADR e "aplicar no projeto real é HITL"). **Idempotente**: `create schema if not exists`, `create or replace function` e os `revoke`/`grant`. Rodar duas vezes dá o mesmo estado, o que serve ao teste de falha fechada (que troca a função e a restaura rodando a migration de novo) e ao runbook. Nenhuma tabela existente muda.

### D7. `config.toml` local e política do CI
```toml
[auth.hook.custom_access_token]
enabled = true
uri = "pg-functions://postgres/trampo_hooks/custom_access_token"
```
- Toda emissão do job `db` passa a rodar o hook, então os 82 testes de hoje também o exercitam.
- **`@trampo/ci-policy`** (`repo-workflows.test.ts`, o bloco "pilha local do Supabase"): regra nova, por seção do TOML, que exige o hook ligado, a URI exata e nenhum outro hook de auth ligado. O leitor de hoje (`setting`) ignora seções; a regra nova lê a seção.

### D8. O que não muda
- Nenhum arquivo de `apps/api/src`, de `apps/extension` nem de `packages/contracts`. O `gotrue-token-client` já lê a recusa do hook como `recusado` (emenda da F1-API-08).
- Nenhuma variável de ambiente nova.

## 3. Auditoria do `[APPSEC]` (sem veto, 7 condições)

**Ameaças cobertas quando o hook estiver aplicado no projeto real (HITL-040):**
- **T48** (fluxo PKCE do atacante, sessão sem envelope): a sessão criada direto no GoTrue deixa de renovar depois de 24 h. O access já emitido ainda vale até o `exp` (900 s).
- **Sessão órfã** e **chave de selagem vazada junto com o `storage.session`**: o refresh cru para de servir em 24 h, com ou sem a API.
- **T9 fora do BFF** (P18, CA-15) e **SR-21** (a linha "hook do D5").

**Condições (cada uma com teste):**
1. **Fora do alcance de `anon`, `authenticated` e `service_role`:** prova por RPC (`POST /rest/v1/rpc/custom_access_token`, com e sem `Content-Profile: trampo_hooks`, como `anon` e como usuário) e por SQL (`set local role` e a chamada, que precisa dar `42501`), mais o catálogo. O RPC como `service_role` não roda: o job nunca entrega a chave *secret* ao processo (ADR-019 D8). A prova dele é o SQL e o fato de o schema não estar exposto a papel nenhum.
2. **Nenhum dado de sessão na mensagem nem em log:** as duas mensagens são literais fixos; um teste confere que nenhuma resposta de recusa traz o `session_id`, o `user_id` nem o e-mail. A função não tem `raise notice` nem `raise log`. O GoTrue registra a recusa no log dele com a mensagem fixa (fora do nosso alcance, sem PII nossa).
3. **Falha fechada provada:** com a função trocada por uma que lança, nenhuma emissão sai, e o adapter diz `nao_recebido` (503), nunca `recusado`. O teste restaura a função certa num `finally` e confere o `md5` do `pg_get_functiondef` antes e depois.
4. **A recusa nunca vira 503 e o defeito nunca vira 401:** o 403 do hook dá `recusado` e 401 pela borda real do BFF; o `raise exception` (inclusive com `PT403`) dá `nao_recebido`.
5. **Limite exato e constante presa** (D4).
6. **Mutação dirigida da migration** antes do push (catálogo no §4.2).
7. **Aplicação no projeto real só por HITL** (*HITL-QUEUE §HITL-040*), pelo SQL Editor, com hash conferido. A equipe não toca no projeto real. Rollback: desligar o hook no painel **antes** de qualquer `drop` (com o hook apontando para função inexistente, toda emissão falha).

**Efeito no portal (*BACKLOG §F1-PORTAL-01*):** o hook vale para **toda** sessão do projeto. A sessão do portal também morre em 24 h contadas do login, com qualquer atividade: o portal precisa tratar a recusa da renovação como "entre de novo", e não pode prometer "manter conectado" acima disso. Registrado no BACKLOG.

**Residuais (vão para a §9 do [threat-model](../threat-model.md)):**
- **Até o HITL-040**, nada muda no projeto real: T48, sessão órfã e chave de selagem vazada seguem residuais. A migration no `master` não aplica nada sozinha.
- **Hook desligado ou apontado para outra função no painel:** a idade fora do BFF some em silêncio (as sessões do BFF seguem cobertas pelo envelope). Sem detecção automática; o runbook manda conferir depois de qualquer mudança em Authentication > Hooks, e o spike S-3 (P18) confere contra o projeto real.
- **Access já emitido:** vale até o `exp` (até 900 s depois das 24 h).
- **Disponibilidade:** todo login e toda renovação passam a depender desta função (prazo de 2 s do GoTrue, F2). Um erro nela derruba a emissão do projeto inteiro. É uma leitura por chave primária, sem laço e sem bloqueio.
- **Usuário com `raw_app_meta_data` ou `raw_user_meta_data` nulo** (só por inserção manual em `auth.users`): com qualquer hook ligado, o GoTrue recusa as claims dele no próprio JSON Schema (F6), antes de assinar. Usuário criado pelo GoTrue (OAuth, senha) sempre tem os dois.
- **Relógios:** o `created_at` é do relógio do GoTrue e o `now()` é do banco. Um desvio de segundos desloca o corte na mesma medida.

## 4. Plano de testes (`[QA_EVALS]`)

### 4.1 `apps/api/test/db/auth-hook.db.test.ts` (grupo `db`; não esvazia balde)
- **Catálogo:** a função existe com `prosecdef = false`, `provolatile = 's'`, `proconfig = {search_path=""}`, `plpgsql`, `(jsonb) → jsonb`; ACL exata do schema e da função; `has_schema_privilege` e `has_function_privilege` falsos para `anon`, `authenticated` e `service_role`; dono e `select` de `auth.sessions`; a constante lida do banco.
- **Função direta, como `supabase_auth_admin`** (a mesma conexão do GoTrue, F11): limite exato numa transação; cada evento hostil do D2; saída igual às claims de entrada; mensagens fixas.
- **Grants por SQL e por RPC** (condição 1).
- **GoTrue de verdade:**
  - emissão normal: o token passa no verificador real (ES256, `amr`, `exp − iat = 900`) e tem exatamente as chaves do `AccessTokenClaims` do GoTrue sem hook (`aal`, `amr`, `app_metadata`, `aud`, `email`, `exp`, `iat`, `is_anonymous`, `iss`, `phone`, `role`, `session_id`, `sub`, `user_metadata`). É a comparação "antes e depois": o "antes" é a struct do GoTrue v2.197.0 e os 82 testes que já passavam sem o hook; ligar e desligar o hook dentro do job exigiria reiniciar a pilha;
  - renovação recusada: sessão envelhecida por `update` em `auth.sessions.created_at` (como `supabase_auth_admin`, o dono); `POST /token?grant_type=refresh_token` dá 403 `{ code: 403, error_code: "unknown", msg }`; o adapter diz `recusado`; a recusa não consome o refresh (com a data devolvida, o mesmo refresh renova);
  - borda real: o `composeApp` de pé contra a pilha local, sessão criada pela troca PKCE (`insertPkceFlow`) em `POST /v1/auth/exchange`; `POST /v1/auth/refresh` dá 200 com a sessão nova e **401 `NAO_AUTENTICADO`** com a sessão envelhecida, nunca 503;
  - **recusa na emissão inicial: não alcançável** (F8). O limite exato fica provado na função direta;
  - falha fechada (condições 3 e 4).

### 4.2 Mutação dirigida (`mut_db02.py`)
Cada mutante troca um trecho da migration e precisa derrubar o `test:db`: `<` por `<=` no limite; a recusa por `raise exception`; `http_code` 500 no lugar do 403; mensagem vazia; grant a mais para `authenticated`; `security definer`; sem `search_path`; `session_id` sem a conferência; a função que devolve o evento sem conferir; 86.400 trocado; o `revoke` do `public` retirado; `created_at` nulo que passa; sessão inexistente que passa.

### 4.3 Onde roda
- **A prova que vale é o job `db` do PR** (GoTrue, Kong e Postgres do Supabase de verdade).
- **Prova auxiliar na estação:** Postgres 17.11 e PostgREST 16.4 nativos (os mesmos binários da sessão do F1-API-05), com um esboço dos papéis do Supabase e um GoTrue simulado que chama o hook como o código do F2 a F7 descreve. Ela confere a migration, o SQL dos testes, a cobertura do apoio e a mutação; não confere o GoTrue.

## 5. Partição em commits
1. `feat(db)`: a migration, o `config.toml`, o `test:db` e a regra do `@trampo/ci-policy` (Etapa 2).
2. `docs(next-step)`: no fim da sessão.

## 6. Emendas

### 6.1 Sessão 26 (2026-11-13): o `aud` do 1º token depois da partida do GoTrue
**Achado:** a 1ª execução do `auth-hook.db.test.ts` contra o GoTrue de verdade (PR #24, runs 43430600482 e 43431103773) derrubou um caso só: "emissão normal", com o verificador real dizendo `token_invalido`. Reproduzido na pilha local da estação (CLI 2.120.0, `gotrue:v2.197.0`): **o 1º token emitido depois de cada partida do processo do GoTrue sai com `"aud": ["authenticated"]`**; do 2º em diante, `"aud": "authenticated"`. A partir do 2º, cadastro, login por senha e renovação saem iguais.

**Causa (código do `supabase/auth`, `internal/tokens/service.go`, igual na v2.197.0 e no `master` de 2026-11-13):** o GoTrue só liga a flag global `jwt.MarshalSingleStringAsArray = false` dentro do `SignJWT`. Com o hook ligado, o `GenerateAccessToken` serializa as claims para o evento **antes** da 1ª assinatura, e o `aud` (`jwt.ClaimStrings`) sai como lista. A função devolvia as claims sem mexer, e o GoTrue assinava o `jwt.MapClaims` com a lista. Sem o hook, a serialização acontece depois da flag, e o problema não aparece. Por isso o `auth-contract` passava no `master`.

**Impacto sem a correção:** no projeto real, cada partida de cada instância do GoTrue derrubaria um login ou uma renovação. O verificador da API ([ADR-013-jwt-verification](ADR-013-jwt-verification.md) D4) e o do portal ([ADR-027-portal-login](ADR-027-portal-login.md)) exigem o `aud` string e recusariam o token (401).

**Decisão (humano no chat, entre duas opções; [ARCHITECT] + [APPSEC], sem veto):** a função normaliza o `aud` na origem. Ele só muda quando é lista com exatamente um item string, e então volta como esse item. Lista vazia, com mais de um item, com item que não é string, ou `aud` de outro tipo ou ausente voltam como vieram. Os `if` são aninhados, para o `jsonb_array_length` só rodar numa lista, e a função continua sem lançar por dado de entrada. A recusa por idade vem antes e não muda. **Rejeitado:** afrouxar os verificadores para aceitar `["authenticated"]`. Isso mexeria no ADR-013 D4 e em todo consumidor futuro, e a correção na origem vale para a API e para o portal ao mesmo tempo.

**Testes:** 11 casos novos no grupo "função chamada direto" do `auth-hook.db.test.ts` (65 no arquivo), e a "emissão normal" passa a exigir `aud` string no token do cadastro. A ordem dos arquivos no CI não é garantida, então o caso real (1º token da partida) não é provado de forma determinística no job. Ele foi provado na estação com `docker restart` do contêiner do Auth seguido de um cadastro. Antes da correção, o token saiu com `aud` em lista, que o `jwtVerify` aceita e o `ClaimsSchema` do verificador recusa. Depois, saiu com `aud` string. Os 10 formatos de `aud` foram conferidos direto na função, pelo `psql` do contêiner.

**Efeito no HITL-040:** a migration mudou antes de ser aplicada em qualquer lugar (nada foi aplicado no projeto real). O hash do §1 do *supabase-hook-real* foi trocado.
