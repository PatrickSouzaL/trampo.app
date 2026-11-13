---
tipo: guia
atualizado: 2026-11-13
dono: "[SCRIBE]"
revisado-por: "[APPSEC]"
fonte-da-verdade: "código do trampo.app no commit 815ab06 (branch spike/s1-extraction)"
relacionados: ["[00-indice-e-visao-geral](00-indice-e-visao-geral.md)", "[01-jornada-dos-dados-ponta-a-ponta](01-jornada-dos-dados-ponta-a-ponta.md)", "[threat-model](../arquitetura/threat-model.md)", "[ADR-014-rate-limit-and-quota](../arquitetura/ADRs/ADR-014-rate-limit-and-quota.md)", "[ADR-018-postgres-schema-rls-and-criteria](../arquitetura/ADRs/ADR-018-postgres-schema-rls-and-criteria.md)", "[ADR-004-extension-auth](../arquitetura/ADRs/ADR-004-extension-auth.md)", "[ADR-026-custom-access-token-hook](../arquitetura/ADRs/ADR-026-custom-access-token-hook.md)", "[ADR-027-portal-login](../arquitetura/ADRs/ADR-027-portal-login.md)", "[ADR-025-side-panel-ui](../arquitetura/ADRs/ADR-025-side-panel-ui.md)"]
---

# 02. Infraestrutura e segurança, descomplicadas

> **Regra desta nota:** nenhum valor real aparece aqui. As variáveis de ambiente são citadas só pelo **nome**, e os valores vivem no `.env` de cada app, que nunca entra no git nem no cofre. Os exemplos de chave são falsos e óbvios.

## Os três princípios que explicam quase tudo

| Princípio | Em uma frase | Exemplo no projeto |
|---|---|---|
| **Zero Trust** | Nenhuma sala confia na anterior: cada uma revalida o que recebe. | O Service Worker valida com Zod o que o extrator devolve. O painel revalida o que o Service Worker manda. A API revalida o relatório que ela mesma montou. |
| **Fail-Closed** (falhar fechado) | Na dúvida, **nega**. Uma dependência fora do ar nunca vira "liberado". | Redis fora do ar no rate limit vira **503**, nunca "passa". JWKS fora do ar vira 503, nunca "aceito sem conferir". |
| **LGPD por desenho** | O dado pessoal não sai de onde precisa estar. | O LLM nunca recebe o seu perfil. O e-mail e o telefone da vaga são mascarados. A pretensão salarial é cifrada antes de ir ao banco. Os logs só aceitam uma lista fechada de campos. |

Existe uma exceção consciente ao Fail-Closed: o **cache de fatos**. Se o Redis falhar ali, a análise segue para o LLM (vira "não achei"), porque o cache é só uma otimização, não uma barreira de segurança ([01-jornada-dos-dados-ponta-a-ponta §D.1 Cache de fatos (`JobFactsCache`)](01-jornada-dos-dados-ponta-a-ponta.md#d1-cache-de-fatos-jobfactscache)).

## 1. Upstash Redis: as quatro funções

O Upstash é um Redis acessado por HTTP (REST). No trampo.app ele tem quatro funções, cada uma num adaptador próprio em `apps/api/src/infrastructure/`:

| # | Função | Arquivo | O que grava (padrão da chave) | Se o Redis cair |
|---|---|---|---|---|
| 1 | **Rate limit** por usuário e por endereço | `limits/redis-rate-limiter.ts` | `rl:<classe>:u:<HMAC do usuário>:<janela>` e `rl:<classe>:ip:<HMAC do IP>:<janela>` | **503** (falha fechado) |
| 2 | **Cota diária** de 50 análises | `limits/redis-daily-quota.ts` | `quota:<HMAC do usuário>:<dia de Brasília>`, um *set* de `requestId` | **503** (falha fechado) |
| 3 | **`QuotaLedger`**, o orçamento de LLM | `limits/redis-quota-ledger.ts` | `llm:global:<dia>`, `llm:rpm:…`, `llm:rpd:…`, `llm:tpm:…`, `llm:tpd:…`, `llm:block:<provedor>` | sem LLM: análise determinística com `analise_degradada` |
| 4 | **Cache de fatos** da vaga | `cache/redis-job-facts-store.ts` | `jobfacts:v1:{extractorVersion}:{sha256}` | cache miss: segue para o LLM |

### 1.1 Rate limit

- Janela de 60 s, deslizante aproximada (`application/limits/windows.ts:25-31`). Os limites ficam em `RATE_LIMIT_POLICY` (`application/limits/limit-policy.ts:7-16`):

  | Classe | Por usuário | Por endereço |
  |---|---|---|
  | `padrao` | 60 | 120 |
  | `analise` | 5 | 20 |
  | `criterios` | 10 | 30 |

- Uma classe desconhecida usa a mais estrita (`analise`). Os pedidos negados também contam.
- **Privacidade:** o identificador do usuário e o IP **nunca** entram no Redis em claro. Entram como `HMAC-SHA256(RATE_KEY_PEPPER, …)`, truncado em 128 bits (`crypto/hmac-key-pseudonymizer.ts`). O IPv6 conta pelo prefixo /64, porque um usuário controla o bloco inteiro.
- Antes do JWT, há um limite **em memória**, só nas rotas públicas de login: 10 trocas e 30 renovações por minuto por IP (`presentation/edge/pre-auth-limit.ts`).

### 1.2 Cota diária

- São **50 análises por usuário por dia**, no **dia de Brasília** (UTC−3) (`limit-policy.ts:29-32`).
- **Idempotente:** a chave é um *set* de `requestId`. Repetir o mesmo pedido (`SADD` devolve 0) não cobra de novo.
- Esgotou: 429 até a meia-noite de Brasília.

### 1.3 `QuotaLedger`: não estourar os limites dos provedores

Os provedores gratuitos publicam limites. O ledger os respeita com **15% de folga** (`headroom: 0.85`, `limit-policy.ts:108-131`):

| Provedor | Limites publicados que o ledger protege |
|---|---|
| Groq | 30 pedidos/min, 1.000 pedidos/dia, 8.000 tokens/min e 200.000 tokens/dia |
| Workers AI | 60 pedidos/min e cerca de 99 chamadas/dia, calculadas pelos 10.000 *neurons* diários divididos pelo custo medido de uma chamada; 84 com a folga |
| Global | **400 chamadas de LLM por dia**, somando os provedores (um disjuntor do projeto) |

**A reserva pessimista de 3.000 tokens (só no Groq):**
- Antes de chamar o Groq, o ledger **reserva** 3.000 tokens no contador por minuto e no contador do dia. O número vem de medida real: 2.509 tokens de entrada + 331 de saída = 2.840, arredondado para cima em passos de 500 (`limit-policy.ts:79-106`).
- Depois da resposta, o `recordUsage` **acerta a conta** com o uso real.
- Uma chamada que não volta 200 fica com a reserva cheia: na dúvida, o ledger presume que gastou.
- Por que reservar antes: se dez análises chegam juntas, cada uma "segura" a sua fatia **antes** de chamar. Ninguém descobre o estouro depois do fato.

**Quando o provedor responde 429**, o ledger grava `llm:block:<provedor>` pelo tempo do `Retry-After` (60 s se não vier, entre 1 s e 1 h), e todos os processos da API respeitam o bloqueio.

### 1.4 Por que um cliente HTTP próprio e não o SDK oficial

O arquivo é `apps/api/src/infrastructure/redis/upstash-rest-client.ts`. O motivo está no [ADR-014-rate-limit-and-quota](../arquitetura/ADRs/ADR-014-rate-limit-and-quota.md) (linhas 59 e 60):

- O `@upstash/ratelimit` **libera o pedido quando dá timeout** (falha aberta, a ameaça T39), traz *analytics* e faz a lógica em scripts **Lua** (`EVALSHA`), que nenhum Redis simulado de teste executa. A regra ficaria sem teste.
- O `@upstash/redis` faz **nova tentativa com backoff** por padrão, o que estoura o prazo da borda.

O cliente próprio faz uma coisa só: um `POST {url}/multi-exec` (uma transação `MULTI/EXEC`, atômica no servidor). A regra de negócio fica em TypeScript, testável. As garantias:

- **Prazo de 200 ms** (`UPSTASH_CLIENT_POLICY.timeoutMs`, `:20`), e acima dele o guarda da aplicação, com 250 ms (`LIMIT_GUARD_POLICY`).
- **Falha fechado em qualquer desvio**, não só em queda ou lentidão (`:4-6`): status diferente de 200, redirecionamento, corpo grande demais, JSON ou UTF-8 inválido, tamanho de array errado, um comando com `error` ou um tipo inesperado. Todos viram `null`, e quem recebe o `null` decide pela negação (503).
- **O token vai só no cabeçalho** `authorization: Bearer …`, nunca na URL, e com `redirect: "error"`, para o token nunca seguir para outro host.
- Tetos de 16 comandos por transação e 16 KiB por resposta. O cache usa outra instância, com teto de 128 KiB.

## 2. Supabase: Postgres com RLS e o GoTrue (login)

### 2.1 O banco

As tabelas estão em `supabase/migrations/20261022230000_criterios_analises_feedback.sql`:

| Tabela | Guarda |
|---|---|
| `public.user_criteria` | os seus critérios. A pretensão salarial fica só cifrada, na coluna `salary_ciphertext`, e o JSON `criteria` é **proibido** de conter `salary` |
| `public.analyses` | o registro das análises |
| `public.analysis_feedback` | o retorno do usuário sobre cada análise (FK composta: o dono da análise e o do feedback são o mesmo) |

**RLS (*Row Level Security*) forçada.** RLS é o banco filtrar **cada linha** pelo dono, dentro do próprio Postgres. As três tabelas têm `enable` **e** `force row level security` (`:68-74`). O `force` vale até para o dono da tabela: ninguém "esquece" a regra.

- As 8 políticas são todas `to authenticated` e `(select auth.uid()) = user_id`.
- Os privilégios começam do zero: `revoke all … from public, anon, authenticated, service_role`. Depois, só o `authenticated` ganha `select`, `insert` e `update`. **Nenhum `delete`** (só por cascata, quando a conta some) e **nada para `anon`**.

### 2.2 Por que a API nunca usa a `service_role`

A `service_role` é a "chave mestra": ela **ignora a RLS**. Uma API que a usasse em rota de usuário bastaria errar um `WHERE` para mostrar os dados de todo mundo.

O trampo.app faz o contrário (`infrastructure/supabase/postgrest-user-client.ts`):
- manda a chave **publishable** (pública, sem poder especial) no `apikey`;
- manda o **JWT do próprio usuário** no `authorization`, um token por chamada, nunca guardado.

O Postgres então vê "é o usuário X" e aplica a RLS. Fica uma defesa em camadas:
1. **Na API:** o filtro pelo `sub` do token verificado.
2. **No banco:** a RLS.
3. **Na cifra:** o AAD da pretensão salarial (ver §3), que impede abrir a linha de outro dono.

**Os clientes recusam qualquer outra chave já no construtor.** Só aceitam o prefixo `sb_publishable_` e recusam `sb_secret_` e as chaves legadas `eyJ…` (`postgrest-user-client.ts:85-87`, `gotrue-token-client.ts:64-65`). A conferência de `service_role` no `apps/api/src` só achou o comentário dessa recusa. O `.env.example` da API já prevê uma `SUPABASE_SECRET_KEY` para o futuro "apagar conta" (F1-PORTAL-03), mas **nenhum código a lê** hoje.

### 2.3 GoTrue: o login

O GoTrue é o serviço de autenticação do Supabase. Os dois apps conversam com ele **sem SDK**, por clientes próprios:
- `apps/api/src/infrastructure/supabase/gotrue-token-client.ts`, o BFF da extensão;
- `apps/web-portal/src/server/gotrue.ts`, o portal.

Os dois têm prazo de 5 s, resposta de até 32 KiB, `redirect: "error"` e uma lista fechada de cabeçalhos. Nenhum cabeçalho do cliente, como `X-Forwarded-For`, chega ao GoTrue.

**Verificação do token (JWT):**
- O algoritmo é **ES256 fixo**. `none` e `HS256` nunca chegam à busca de chave.
- A chave pública vem do **JWKS** do Supabase, com prazo de 3 s e cache de 10 min.
- As *claims* conferidas são `iss`, `exp` e idade máxima de **900 s**, além de `aud` **exatamente** `"authenticated"` (uma lista é recusada), `role`, `is_anonymous` falso, `sub` UUID e `amr` numa lista permitida (`AUTH_ALLOWED_AMR`, padrão só `oauth`).
- Os arquivos são `infrastructure/auth/jose-access-token-verifier.ts` (API) e `apps/web-portal/src/server/verifier.ts` (portal).

**Proteções do login da extensão (o BFF):** o `GotrueEgress` (`application/auth/gotrue-egress.ts`) controla o volume de chamadas ao GoTrue:
- **orçamento por janela de 5 min** abaixo do limite por IP do Supabase;
- **bulkhead** de no máximo 4 chamadas simultâneas, em que a troca de código nunca ocupa a última vaga;
- **balde de rajada.**

Assim, um pico de logins não queima o limite do projeto real.

### 2.4 O *Custom Access Token Hook* (F1-DB-02): a sessão expira em 24 h

O hook está na migration `supabase/migrations/20261112210000_custom_access_token_hook.sql` e no [ADR-026-custom-access-token-hook](../arquitetura/ADRs/ADR-026-custom-access-token-hook.md).

**O que é:** uma função do Postgres (`trampo_hooks.custom_access_token`) que o GoTrue chama **toda vez que vai emitir um token**: no login, na troca de código e em cada renovação.

**O que faz:**
1. Lê o `session_id` do token e busca a criação da sessão em `auth.sessions.created_at`.
2. Se a sessão **não existe** ou tem **mais de 86.400 s (24 h)**, recusa com `{"error": {"http_code": 403, "message": "sessao acima da idade maxima"}}` (`:39-49`).
3. Se o evento chegar fora da forma esperada, recusa com 500.
4. Se a `aud` vier numa lista de um item só, devolve só a string. Isso corrige um comportamento do GoTrue no 1º token depois da partida, visto no PR #24 (ADR-026 §6.1).

**Na prática:** mesmo com um refresh token roubado, ninguém renova uma sessão além de 24 h. Um access já emitido vale até o próprio `exp`, no máximo 15 min.

**Proteção da função:** fica num schema próprio, fora da API REST. O `execute` foi revogado de todos e dado só ao `supabase_auth_admin`. Ela usa `security invoker` e `search_path = ''`.

**Estado:** ligado só na pilha local de testes (`supabase/config.toml:296-298`). No projeto real, ligar o hook é o *HITL-QUEUE §HITL-040* (runbook *supabase-hook-real*).

## 3. Criptografia de dupla camada (AEAD AES-256-GCM)

**AEAD** quer dizer "cifra autenticada com dados associados". O AES-256-GCM faz duas coisas ao mesmo tempo:
1. **Esconde** o conteúdo (cifra).
2. **Lacra** o envelope: qualquer bit alterado faz a abertura falhar. Ele não abre "um pouco errado"; simplesmente não abre.

O **AAD** ("dados associados") é um rótulo que entra no lacre sem ser cifrado. Se você tentar abrir o envelope com outro rótulo, ele não abre. É o que impede **copiar e colar** um envelope válido de um contexto para outro.

O formato comum é `<versão>.<kid>.<iv>.<cifrado>.<tag>` em base64url. O IV (*nonce*) tem 96 bits, aleatório a cada selagem, e a tag, 128 bits (`infrastructure/crypto/aead-envelope.ts`).

Cada finalidade tem o **próprio anel de chaves**: de 1 a 4 chaves, e a ativa sela. Duas finalidades **não podem** repetir o material da chave (`assertDisjointKeyrings`). A troca de chave é sem quebra: adicione a nova, mude a ativa, e as antigas continuam abrindo.

| Envelope | O que guarda | AAD (o rótulo) | Quem consegue abrir | Variáveis (só os nomes) |
|---|---|---|---|---|
| **`s1`**, `SalaryCipher` (`crypto/salary-cipher.ts`) | a **pretensão salarial** dos seus critérios, **sempre**, até quando é `null`, para a coluna não revelar quem informou | `trampo:user_criteria.salary:s1:<userId>` | só o processo da API | `CRITERIA_SALARY_KEYS`, `CRITERIA_SALARY_ACTIVE_KEY` |
| **`r1`**, `RefreshSealer` (`crypto/aead-refresh-sealer.ts`) | `{ rt, sid, sst, iat }`: o refresh token, o id, o início da sessão e a emissão | `trampo:auth.refresh:r1:<Origin>` | só o processo da API. **A extensão guarda e devolve o envelope sem conseguir abri-lo** | `AUTH_REFRESH_SEAL_KEYS`, `AUTH_REFRESH_SEAL_ACTIVE_KEY` |
| **Portal `s1`**, sessão (`apps/web-portal/src/server/seal.ts`) | `{ at, rt, sid, sst, iat, ate }`: os tokens da sessão do portal | `trampo:portal.sessao:s1:<PORTAL_ORIGIN>` | só o servidor do portal. **O navegador vê um cookie opaco** | `PORTAL_SEAL_KEYS`, `PORTAL_SEAL_ACTIVE_KEY` |
| **Portal `f1`**, fluxo de login | `{ v, st, p, iat }`: o verifier do PKCE e o `state` | `trampo:portal.fluxo:f1:<PORTAL_ORIGIN>` | só o servidor do portal, por 300 s | idem |

**Por que cifrar o salário se o banco já tem RLS?** Por defesa em profundidade. Um backup vazado, um dump, um erro de política ou um acesso administrativo ao banco **não revela** a pretensão de ninguém, porque as chaves vivem só no `.env` da API, longe do banco. E o AAD com o `userId` faz o envelope do usuário B, colado na linha do usuário A, simplesmente não abrir.

**Por que selar o refresh token da extensão?** O `storage.session` da extensão é memória do navegador. Se algo o ler, leva um envelope que **só a API abre**, e a API ainda confere a idade máxima e a inatividade da sessão **antes** de chamar o GoTrue (`application/auth/refresh-session.ts`). Uma ressalva honesta, escrita no próprio código: o `Origin` no AAD é **higiene, não autenticação**, porque um script fora do navegador consegue forjar o `Origin` (`aead-refresh-sealer.ts:2-4`).

**O portal (ADR-027):** os tokens **nunca** vão para o JavaScript da página.
- O PKCE roda no servidor, e o verifier fica no cookie de fluxo selado.
- Os cookies `__Host-trampo-sessao` e `__Host-trampo-fluxo` são `Path=/; HttpOnly; Secure; SameSite=Lax`, sem `Domain`. O prefixo `__Host-` obriga o navegador a recusar o cookie se esses atributos faltarem.
- A sessão vive no máximo 24 h, com 4 h de inatividade.
- O logout é só por `POST`, com `Origin` exato.
- A CSP leva um **nonce novo a cada pedido** (`proxy.ts`): `script-src 'self' 'nonce-…' 'strict-dynamic'`, `frame-ancestors 'none'`, `object-src 'none'` e `base-uri 'none'`.
- O `next.config.ts` acrescenta `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS e COOP/CORP `same-origin`.

## 4. Isolamento do Side Panel na extensão

### 4.1 O modelo mental

A extensão tem dois "cômodos":

| Cômodo | Confiança | Pode |
|---|---|---|
| **Service Worker** (`src/entrypoints/background.ts`) | o "cofre" | guardar tokens no `storage.session`, chamar a API, fazer o login (PKCE e `launchWebAuthFlow`) e injetar o extrator |
| **Side Panel** (React, `src/entrypoints/sidepanel/` e `src/panel/`) | **não confiável** | só desenhar texto e conversar com o Service Worker por **uma** porta |

**Por que o painel é "não confiável"?** Porque é a parte que **mostra** conteúdo que veio de fora: o relatório, que veio da API, que leu a vaga, que veio de um site qualquer. Se um dia houver um bug de renderização, o estrago fica preso num cômodo **sem tokens e sem rede**.

### 4.2 As travas (e o que cada uma de fato cobre)

O próprio código admite: o navegador **deixaria** o painel ler o `storage.session`, porque ele é uma página da extensão. A barreira é nossa, em quatro camadas (`apps/extension/eslint.config.js:132-134`):

| Camada | Trava | Cobre |
|---|---|---|
| **B1 · ESLint** | bloco `@trampo/extension/panel`: proíbe `storage`, `indexedDB`, `caches`, `localStorage`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `BroadcastChannel`, `location`, `open`, `import()` dinâmico e importar `auth/`, `api/` ou `session-store` | armazenamento **e** rede, no código-fonte |
| **B2 · ESLint por módulo do Service Worker** | cada capacidade sensível mora num arquivo só: `fetch` só no `src/api/api-client.ts`, `browser.identity` só no `src/auth/web-auth-flow-source.ts`, `executeScript` só no `src/capture/capture.ts` (sem a opção `files:`), `storage.onChanged` só em `src/auth` | o Service Worker inteiro, não só o painel |
| **B3 · dependency-cruiser** | regra `extension-panel-no-auth` (`packages/config/dependency-cruiser.cjs:58-66`): o painel não importa `src/auth`, `src/api`, `messaging/session-store.ts` nem os contratos de auth | impede o painel de **alcançar o código** que lê a sessão |
| **B4 · CSP do painel** | meta CSP só no painel (`panel-csp.ts:7`): `connect-src 'none'; form-action 'none'; base-uri 'none'; require-trusted-types-for 'script'; trusted-types 'none'` | **toda** a rede do painel, inclusive para a própria API. Nenhum *sink* de HTML aceita string. Não cobre armazenamento |
| **B5 · teste do artefato** | `test/manifest.test.ts` procura `storage.session`, `launchWebAuthFlow`, `.identity.`, `/v1/auth/` e a origem do Supabase em **todo arquivo** gerado do painel, e confere que a meta CSP é única e vem antes de qualquer script | o que o **build** de fato gerou |

E mais:
- O `fetch` é proibido em **todo** o `src/`, menos no `src/api/api-client.ts`.
- O painel renderiza **só texto pelo React**: o preset de segurança proíbe `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `dangerouslySetInnerHTML`, `document.write` e elementos que navegam ou carregam recurso (`a`, `img`, `iframe`…).
- A mensagem de erro que vem do servidor **não é exibida** (`src/panel/texts.ts`).
- **A porta única:** `runtime.connect` com o nome `trampo/sidepanel/v1`. O Service Worker aceita só essa porta, do mesmo `runtime.id` e da página do painel. Cada mensagem passa pelo `PanelToWorkerSchema` (7 tipos), e qualquer falha **desconecta** (`src/messaging/worker-port.ts`). Não há `onMessage`, `onMessageExternal` nem `onConnectExternal`.

## 5. Onde cada segredo mora (sem os valores)

| App | Arquivo local (fora do git) | Nomes das variáveis sensíveis |
|---|---|---|
| API | `apps/api/.env` | `UPSTASH_REDIS_REST_TOKEN`, `RATE_KEY_PEPPER`, `CRITERIA_SALARY_KEYS`, `AUTH_REFRESH_SEAL_KEYS`, `GROQ_API_KEY`, `CLOUDFLARE_API_TOKEN` |
| Extensão (build) | `apps/extension/.env` | nenhuma sensível: só origens (`TRAMPO_API_ORIGIN`, `TRAMPO_SUPABASE_ORIGIN`) e a chave **pública** `TRAMPO_EXTENSION_KEY`. Lido por lista fechada, com teto de 16 KiB |
| Portal | `apps/web-portal/.env.local` | `PORTAL_SEAL_KEYS` |

**Defesas contra vazamento:**
- O **gitleaks 8.30.1** roda no CI sobre todo o histórico, com três regras próprias (`trampo-auth-seal-keys`, `trampo-portal-seal-keys` e `trampo-auth-seal-keys-files`).
- O pacote `@trampo/ci-policy` prova por teste que a allowlist só tem valores exatos (`^…$`).
- Uma fixture de teste com cara de chave **nasce em tempo de execução**, nunca escrita no arquivo.

Próximo: [03-mapa-completo-de-arquivos](03-mapa-completo-de-arquivos.md).
