---
tipo: adr
id: ADR-004
titulo: "Autenticação da extensão (S-3 itens 3 e 4, F1-EXT-05): Authorization Code com PKCE S256 do Supabase Auth aberto pelo Service Worker com chrome.identity.launchWebAuthFlow, troca e renovação por um BFF sem estado na API com o refresh do Supabase selado num envelope AES-256-GCM que impõe idade máxima e inatividade às sessões do BFF, tokens só em storage.session atrás de barreiras de código, de build e de CSP no painel, painel só com um booleano e códigos do catálogo, e manifesto com só identity e key a mais"
status: aceito
aprovacao: "Desenho aprovado pelo humano no *HITL-QUEUE §HITL-034* em 2026-11-04, com as 14 recomendações do §7. O aceite segue o §6.2: HITL-035, pré-spike manual e spike. HITL-035 fechado com ressalvas em 2026-11-06 (Site URL A, P18 disponível, P19 anotado, P4/P7/P8 aprovados, P6 inconclusivo → HITL-036). HITL-036 fechado em 2026-11-07 (declarado pelo humano): P6 aprovado, Q9 aplicada, P19 fixado em 150 e 30 por 5 min, risco do `.pem` no Drive aceito no MVP. O humano declarou o ADR aceito; o status formal seguiu proposto até o P3 (F1-EXT-05a), o P18 (F1-DB-02) e os CAs do §4.10 (veto do §3, registro no HITL-036). Em 2026-11-07, o humano sobrepôs o veto do §3 e marcou o ADR como aceito antes do P3 e do P18 (registro no §3): P3, P18 e os CAs do §4.10 seguem obrigatórios para fechar a F1-EXT-05a, a F1-DB-02 e o F1-EXT-05."
data: 2026-10-31
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)", "[QA_EVALS] (plano de testes)", "[SCRIBE] (redação)"]
escopo: "S-3 itens 3 e 4 e F1-EXT-05. Extensão (apps/extension): src/auth/**, src/api/**, src/messaging/protocol.ts, src/entrypoints/background.ts, src/entrypoints/sidepanel/**, src/panel/**, wxt.config.ts, eslint.config.js, vitest.config.ts, test/** (inclusive test/e2e/csp.e2e.test.ts). API (apps/api/src): application/auth/**, application/ports/{auth-token-gateway,refresh-sealer,access-token-verifier}.ts, application/criteria/criteria-guard.ts, infrastructure/auth/jose-access-token-verifier.ts, infrastructure/supabase/{gotrue-token-client,postgrest-user-client}.ts, infrastructure/crypto/**, presentation/edge/{auth,cors,edge-env,pre-auth-limit}.ts, presentation/routes/auth.ts e apps/api/.env.example. Contratos: packages/contracts/src/{auth,limits}.ts e packages/contracts/package.json. Repositório: packages/config/dependency-cruiser.cjs, supabase/config.toml, .github/workflows/ci.yml (job db), .gitleaks.toml e packages/ci-policy. Fora: gatilho por atalho e menu (S-3 itens 1 e 2) e login do portal (F1-PORTAL-01)."
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-007-api-edge](ADR-007-api-edge.md)", "[ADR-010-log-allowlist-and-telemetry](ADR-010-log-allowlist-and-telemetry.md)", "[ADR-013-jwt-verification](ADR-013-jwt-verification.md)", "[ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md)", "[ADR-018-postgres-schema-rls-and-criteria](ADR-018-postgres-schema-rls-and-criteria.md)", "[ADR-019-ci-github-actions](ADR-019-ci-github-actions.md)", "[ADR-021-criteria-routes](ADR-021-criteria-routes.md)", "[ADR-024-capture-in-service-worker](ADR-024-capture-in-service-worker.md)", "[ADR-025-side-panel-ui](ADR-025-side-panel-ui.md)", "[threat-model](../threat-model.md)", "[contratos-zod](../contratos-zod.md)", "*spike-metrics*", "*BACKLOG §S-3*", "*BACKLOG §F1-EXT-05*", "*HITL-QUEUE §HITL-004*", "*HITL-QUEUE §HITL-034*", "*HITL-QUEUE §HITL-035*", "*HITL-QUEUE §HITL-036*"]
---

# ADR-004: autenticação da extensão

> [!warning] Status: aceito por decisão do humano, com o veto do §3 sobreposto (2026-11-07); P3 e P18 seguem pendentes
> - Este ADR fecha o desenho do S-3 (itens 3 e 4) e do F1-EXT-05. Ele vira **aceito** só depois do *HITL-QUEUE §HITL-034*, do *HITL-QUEUE §HITL-035*, do pré-spike manual e do spike S-3 (pontos P1 a P20 do §1.4), registrados no *spike-metrics* §4. A ordem está no §6.2.
> - Há precedente de ADR proposto com aprovação em HITL próprio: HITL-015 e HITL-016 [J:cofre-requisitos].
> - **Emenda do HITL-035 (2026-11-06):** o HITL-035 fechou com ressalvas (§1.4). O aceite agora também espera o *HITL-QUEUE §HITL-036* (P6, novos cadastros e anotações do pré-spike) e a F1-DB-02 (hook do D5).
> - **Emenda do HITL-036 (2026-11-07):** o HITL-036 fechou (declarado pelo humano) e deixou de bloquear o spike S-3. O humano declarou o ADR aceito; o `[APPSEC]` mantém o veto do §3 para o status formal em duas condições que o HITL-036 não cobre, o P3 (manifesto da F1-EXT-05a) e o P18 (hook, F1-DB-02). A partição da F1-API-07 está no §6.3.
> - **Sobreposição do veto (2026-11-07, decisão do humano):** o humano sobrepôs o veto do §3 e marcou o ADR como `aceito` antes do P3 e do P18. O `[APPSEC]` registra a sobreposição no §3: o status deixa de esperar as duas condições, mas elas não somem. O P3 segue como critério de fechamento da F1-EXT-05a (CA-01), o P18 da F1-DB-02 (CA-15), e os CAs do §4.10 seguem para o F1-EXT-05. Se o P3 ou o P18 falharem, o `[APPSEC]` abre HITL para decidir o status e a contingência (D14).
> - Emendas do §6.1 já aplicadas: a do [contratos-zod](../contratos-zod.md) (seção `auth`, export `./auth` e reexport na raiz), na F1-AUTH-00 (`47abd8c`), que também pôs o `ACCESS_TOKEN_MAX_CHARS` no `limits.ts`; e o registro do P4 a P8, do P18 e do P19 no *spike-metrics* §4. Na F1-API-07: a do ADR-013 D3 (07a, `c51b809`), a do ADR-018 D4 (07b, `905d85f`) e a do ADR-018 D5 (07c). As demais entram com a implementação, uma por trilha.

## 1. Contexto

O [ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md) §5.0.1 (linha "Autenticação", l.122) deixou a estratégia de login da extensão para o S-3, com duas opções:
- (a) `launchWebAuthFlow` com PKCE, com a troca e o refresh intermediados pela API (padrão BFF);
- (b) login no portal e *handoff* da sessão via `externally_connectable` com origem exata.

Em qualquer opção valem: `state` aleatório, URL de retorno exata de `identity.getRedirectURL()` registrada sem curinga e nenhum segredo de cliente na extensão. O impasse nasce da CSP: `connect-src` só para a API impede rodar o `supabase-js` dentro da extensão (threat-model §6, l.578-580) [J:cofre-requisitos; J:cofre-ameacas].

Como ler as fontes:
- `[J:<leitor>]` aponta para o journal `wf_d01bde7e-6de` (uma linha por leitor: `cofre-requisitos`, `cofre-ameacas`, `api`, `extensao`, `portal` e `docs-oficiais`).
- `arquivo L<n>` foi conferido também por leitura direta em 2026-10-31, no branch `spike/s1-extraction`.
- Nada aqui foi medido em navegador nem contra o Supabase real. O que depende disso está marcado como **a verificar no S-3/F1-EXT-05** e consolidado no §1.4.
- **Nomes novos** (definidos no §6.3): as tarefas F1-AUTH-00, F1-API-07, F1-EXT-05a, F1-EXT-05b, F1-EXT-05c e F1-SEC-01. As variáveis `TRAMPO_E2E` e `TRAMPO_E2E_FAKE_IDENTITY` também são novas: hoje só existem `TRAMPO_E2E_BROWSER` e `TRAMPO_E2E_API_PORT`.

### 1.1 Fatos da documentação oficial (consultada em 2026-10-31)

Todos vêm do leitor `docs-oficiais` [J:docs-oficiais].

**Navegador (Chrome e Edge)**
- `launchWebAuthFlow` abre uma janela para provedores que não são o Google. A janela fecha quando o provedor redireciona para `https://<app-id>.chromiumapp.org/*`, e a Promise (Chrome 106+) resolve com a URL de retorno. Fonte: https://developer.chrome.com/docs/extensions/reference/api/identity
- `getRedirectURL(path)` gera `https://<app-id>.chromiumapp.org/<path>`. Mesma fonte.
- O Chrome pede para não abrir fluxo interativo na primeira execução. Mesma fonte.
- A página da API `identity` não menciona `host_permissions` nem o Edge. É silêncio, não negação. Mesma fonte.
- A permissão `identity` não gera aviso ao usuário. `identity.email` gera "Know your email address". Fonte: https://developer.chrome.com/docs/extensions/reference/permissions-list
- O Edge **não** suporta `identity.getAuthToken` nem `getAccounts` e indica `launchWebAuthFlow` como alternativa. Fonte: https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support
- Na distribuição alternativa do Edge, o ID do pacote "is generated automatically, and it cannot be customized". O ID na loja do Edge fica a verificar no HITL da Fase 2. Fonte: https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/alternate-distribution-options
- O campo `key` do manifesto mantém o ID fixo durante o desenvolvimento. Fonte: https://developer.chrome.com/docs/extensions/reference/manifest/key
- `storage.session` fica em memória, não vai para o disco e é apagado quando a extensão é desabilitada, recarregada ou atualizada e quando o navegador reinicia. O limite é 10 MB. Fonte: https://developer.chrome.com/docs/extensions/reference/api/storage
- Por padrão, `storage.session` fica restrito a contextos confiáveis, "extension pages and service workers". Content scripts não leem. **O painel, como página da extensão, lê.** Fonte: https://developer.chrome.com/docs/extensions/reference/api/storage/StorageArea
- `externally_connectable` com `matches` vazio impede qualquer página web de conectar. `MessageSender.origin` existe desde o Chrome 80. A extensão não consegue mandar mensagem para uma página web. Fontes: https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable e https://developer.chrome.com/docs/extensions/develop/concepts/messaging
- "Always validate that the sender matches a trusted source"; operações sensíveis ficam no Service Worker; segredos não vão a content scripts. Fonte: https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure

**Supabase Auth**
- PKCE: o verifier é guardado localmente; o código vale 5 min, é de uso único e a troca "must be initiated on the same browser". No `supabase-js`, fluxos sobrepostos sobrescrevem o verifier guardado no cliente. Fonte: https://supabase.com/docs/guides/auth/sessions/pkce-flow
- O vínculo do PKCE é o verifier, não o navegador. No guia de SSR, o verifier vai num cookie e o código é trocado no servidor. O "mesmo navegador" é limite da biblioteca cliente (a confirmar no P7). Fonte: https://supabase.com/docs/guides/auth/social-sign-in/auth-keycloak (mesmo texto em auth-apple e auth-bitbucket)
- O endpoint `POST /auth/v1/token?grant_type=pkce` e o nome dos campos **não aparecem** em supabase.com/docs. O README do GoTrue só documenta `password` e `refresh_token`. Fontes: a página acima e https://github.com/supabase/auth/blob/master/README.md (repositório oficial, como complemento).
- Refresh tokens "never expire but can only be used once". Reuso fora das exceções revoga a sessão inteira. As exceções são duas: reuso dentro do *reuse interval* (padrão 10 s, "we do not recommend changing"); e "Reuse of the parent of the currently active refresh token", em que "the active token will be returned". Time-box e inatividade são só do plano Pro. Fonte: https://supabase.com/docs/guides/auth/sessions
- `signOut`: `global` encerra todas as sessões; o JS usa `global` por padrão. Os access tokens das sessões revogadas "remain valid until their expiry time". Fonte: https://supabase.com/docs/guides/auth/signout
- Chaves de assinatura: ES256 recomendado, HS256 "Not recommended". JWKS em `/auth/v1/.well-known/jwks.json`, com cache de 10 min na borda. O JWKS vem vazio com HS256. Fontes: https://supabase.com/docs/guides/auth/signing-keys e https://supabase.com/docs/guides/auth/jwts
- Redirect URLs aceitam curingas (`*`, `**`, `?`), mas a recomendação para produção é URL exata. O Site URL é o redirect padrão quando não há `redirectTo`. Fonte: https://supabase.com/docs/guides/auth/redirect-urls
- O único fluxo oficial do Supabase para extensão é Google por `response_type=id_token` e `signInWithIdToken`. Fonte: https://supabase.com/docs/guides/auth/social-sign-in/auth-google
- O OAuth 2.1 Server do Supabase está "in beta". Fonte: https://supabase.com/docs/guides/auth/oauth-server/getting-started

**RFCs**
- RFC 7636: S256 obrigatório quando possível (§4.2); verifier de 43 a 128 caracteres com pelo menos 256 bits (§4.1, §7.1); nunca *downgrade* para `plain` (§7.2). Fonte: https://datatracker.ietf.org/doc/html/rfc7636
- RFC 9700 (BCP 240): comparação exata do redirect (§2.1); PKCE obrigatório para cliente público (§2.1.1); nada de *implicit* (§2.1.2); refresh de cliente público com rotação ou vinculado ao remetente (§2.2.2); refresh SHOULD expirar por inatividade (§4.14.2); PKCE só substitui o `state` contra CSRF se o servidor o impuser (§4.7.1). Fonte: https://datatracker.ietf.org/doc/html/rfc9700
- RFC 8252 (BCP 212): PKCE obrigatório para cliente público (§6) e `state` de alta entropia recomendado (§8.9). Fonte: https://datatracker.ietf.org/doc/html/rfc8252
- RFC 10017, "OAuth 2.0 for Browser-Based Applications" (BCP 212, junto com o RFC 8252; agosto de 2026): o servidor MUST impor o PKCE (§6.3.2.1) e definir tempo de vida máximo ou expiração por inatividade do refresh (§6.3.2.3). Fonte: https://datatracker.ietf.org/doc/html/rfc10017
- Nenhum dos quatro RFCs fala de extensão de navegador. Classificar a extensão como app nativo ou app no navegador é leitura nossa. O Chrome descreve a janela como "web view", em tensão com o RFC 8252 §8.12.

### 1.2 Fatos do cofre e do código

**Extensão** [J:extensao]
- Permissões exatas `activeTab`, `scripting`, `sidePanel` e `storage`, com o comentário "identity e contextMenus entram só se o S-3 decidir" (`wxt.config.ts` L25-27). Sem `key`. `externally_connectable: { ids: [], matches: [] }` (L32). CSP de produção com `connect-src` igual a `TRAMPO_API_ORIGIN` ou `'none'` (L7-14, L34-40). Essa CSP só tem `script-src`, `object-src`, `default-src` e `connect-src` (L37), e `form-action` não herda de `default-src`.
- O `manifest.test.ts` trava a lista de permissões (L18-20), o `externally_connectable` (L34-36) e o `connect-src` (L38-46).
- O Service Worker registra só `runtime.onConnect` para mensageria. Não há `onMessage`, `onMessageExternal` nem `onConnectExternal` (`background.ts` L3-4). Porta única `trampo/sidepanel/v1`, validada por `checkPanelPort` (`worker-port.ts` L15-52).
- Único armazenamento: `storage.session` via `sessionStore` com Zod. O lint barra `local`, `sync`, `managed` e `setAccessLevel` (`eslint.config.js` L8-27). **Nenhuma regra impede o painel de ler `storage.session` ou de importar código de auth.**
- O painel hoje não importa storage nem faz `fetch`. O `index.html` do painel não tem meta CSP (`src/entrypoints/sidepanel/index.html`). O texto de `ERRO_INTERNO` pede o código do pedido (`src/panel/texts.ts` L124), que a `SessaoView` não terá.
- O `csp.e2e.test.ts` prova hoje que o painel **alcança** a API no build com origem (L105-122) e que o bloqueio vem da CSP pelo evento `securitypolicyviolation` (L91-103).
- O E2E carrega builds de produção via CDP `Extensions.loadUnpacked`, com o ID devolvido pela chamada. Sem `key`, o ID muda a cada execução. O `global-setup.ts` usa a porta fixa 47443 e já roda `openssl`. O E2E roda só local: o `ci.yml` não tem job de E2E.
- A cobertura de 100% vale só para `src/capture`, `src/consent`, `src/messaging` e `src/panel` (`vitest.config.ts`).
- A extensão só importa os subpaths `limits|primitives|api|analysis-report` (`eslint.config.js` L6).

**API** [J:api]
- `PUBLIC_ROUTES = new Set(["GET /health"])` (`apps/api/src/presentation/edge/auth.ts` L17). `ACCESS_TOKEN_MAX_CHARS = 8_192` (L20). O mesmo valor está em `application/criteria/criteria-guard.ts` L23 (`accessTokenMaxChars: 8_192`) e em `infrastructure/supabase/postgrest-user-client.ts` L25.
- `EXTENSION_ROUTES = [POST /v1/analyze]`, 403 antes do JWT (`cors.ts` L17-19). Preflight só com GET, POST e PUT e os headers `authorization` e `content-type` (L9-11). Sem `Origin`, a requisição segue e "o JWT protege" (L63-64).
- O Chrome sempre põe `Origin` no `fetch` do Service Worker, e a extensão não pode removê-lo (ADR-021 D8.3, l.141).
- Verificação local: ES256 fixo, `kid` obrigatório, `typ` JWT, `iss` do projeto, `maxTokenAge` de 900 s, `clockTolerance` de 10 s, `is_anonymous === false` presente, `aud` string, `session_id` opcional (ADR-013 D4). JWKS fora dá 503 e "o cliente não deve refazer login" (ADR-013 D5).
- O verificador mede a idade pelo `iat` e só exige `exp`. Não confere `exp − iat` nem `amr` (`jose-access-token-verifier.ts` L24-25, L57-63, L137-139).
- `TRUST_PROXY` é `false` por padrão (`edge-env.ts` L27-42). Sem ele, o `request.ip` é o do proxy (`client-address.ts` L1-2).
- O rate limit roda só depois do JWT, e rota pública não conta (`rate-limit.ts` L23). Decisão do humano de 2026-10-21: requisição anônima não gasta Redis (*Denial of Wallet*), e a inundação fica com a Cloudflare do S-5 (ADR-014 §3).
- O mesmo Bearer é repassado ao PostgREST para a RLS valer (ADR-018 D5/D6). Um token próprio da API quebraria isso.
- Não existe rota de troca, refresh ou logout, nem variável de OAuth.
- O envelope `s1.<kid>.<iv>.<cifrado>.<tag>` da pretensão usa AES-256-GCM, IV de 96 bits, tag de 128 bits, anel de 1 a 4 chaves e boot que falha fechado (`salary-cipher.ts` L1-27; ADR-018 D4).
- Catálogo de erros fechado com 10 códigos (`packages/contracts/src/api.ts` L52-63). O evento `error` do stream leva um `ApiError` (L85-88).

**Portal e Supabase** [J:portal]
- `apps/web-portal` é o scaffold do `create-next-app`, sem login, sem CSP e sem `@supabase/*` no lock. F1-PORTAL-01 está pendente.
- O `supabase/config.toml` é só da pilha local do `test:db`: `jwt_expiry = 3600`, chave de assinatura comentada, signup por e-mail e senha ligado, nenhum provedor GitHub ou Google, `[auth.sessions]` e hooks comentados, limites locais de `token_refresh` 150 a cada 5 min por IP.
- A configuração real só existe como declaração do HITL-004: Google e GitHub, ES256 como current, JWT de 900 s, anônimo desligado e "Redirect URLs exatas de cada build, definidas no S-3".

**Cofre** [J:cofre-requisitos; J:cofre-ameacas]
- T9 exige access de 15 min, tokens só em `storage.session`, refresh com rotação feito só no SW e nunca em paralelo, e logout `global`. Gap declarado: no Free o refresh não expira, e a idade máxima própria ficou "se necessário" (threat-model l.289-298).
- Nenhum SR do §7 cobre T9 ou T22. O §9 não lista o residual M do T9. A revisão adversarial M1.6 não cobriu auth.
- O diagrama do §3 vai até **TB9** (Dev/CI → registries e loja). O catálogo vai até **T40**, e os SRs até **SR-17**. O último HITL é o HITL-033.
  - Nota de 2026-11-06: o "último HITL" é histórico, da redação de 2026-10-31. Depois vieram o HITL-034, o HITL-035 e o *HITL-QUEUE §HITL-036*.
- **Inconsistência do cofre:** o HITL-004 diz que o runbook `supabase-setup` foi "mantido" (HITL-QUEUE l.24 e l.243), mas o arquivo não existe. `base/03-infra-runbook` só tem `fixtures-dom.md` e `llm.md`. O HITL-035 pergunta se ele foi movido ou apagado.
  - **Emenda do HITL-035 (2026-11-06): resolvida.** O humano apagou de propósito os runbooks `supabase-setup`, `upstash-redis` e `regiao-custo-zero`. Eles não foram movidos e não serão reescritos. Hoje o `base/03-infra-runbook` tem `auth-extensao.md`, `fixtures-dom.md` e `llm.md`.
  - Também faltam no cofre, fora da pergunta do HITL-035: `supabase-migration-real`, `supabase-local`, `github-actions` e `mcp-supabase-upstash` (pergunta não bloqueante no *HITL-QUEUE §HITL-036*).
  - As instruções do `RATE_KEY_PEPPER` (HITL-021, que apontava para o §8 do `upstash-redis`) ficaram sem fonte, e a mitigação 2 do T30 (runbooks de restauração) ficou sem alvo. Decidir na F1-SEC-01, com o humano.
- O status do S-3 no BACKLOG (l.169) já aponta este ADR, o HITL-034 e o HITL-035. As dependências antigas fecharam (HITL-004 em 2026-10-21, F1-EXT-00 em 2026-10-18).

### 1.3 Pedido do humano e onde cada item é respondido

| Item do pedido | Decisões | Testes |
|---|---|---|
| 1. Obtenção do JWT: `launchWebAuthFlow` com PKCE ou *handoff* pelo portal | D1, D2, D3, D4, D14 (contingências) | §4.1, §4.4 |
| 2. Isolamento: token só em `storage.session`, só no SW, nunca no extrator nem em claro no painel | D9, D10, D12 | §4.5, §4.6 |
| 3. Ciclo de vida e contrato do estado de sessão no painel | D5, D6, D11, D12 | §4.1, §4.2, §4.4 |
| 4. Privilégio mínimo no manifesto | D13 | §4.6 |
| 5. Critérios de aceite e plano de testes | §3, §4 | §4.9, §4.10 |

### 1.4 O que não tem prova (a verificar no S-3/F1-EXT-05)

O pré-spike manual (P4 a P8) roda depois do HITL-035 e antes de qualquer código de produto (§6.2).

| Ponto | Pergunta | Onde se prova | Aprovado se | Se falhar |
|---|---|---|---|---|
| P1 | O `launchWebAuthFlow` interativo abre a partir do SW, disparado por mensagem de porta (sem gesto no SW), no Chrome e no Edge 155? | spike manual e E2E local | abre nos dois navegadores | C1 (D14), por HITL |
| P2 | No Edge, `getRedirectURL("auth")` devolve `https://<id>.chromiumapp.org/auth`, e a janela fecha e devolve a URL como no Chrome? | spike manual e E2E local | URL exata e retorno igual ao do Chrome | C2 (D14), por HITL |
| P3 | O fluxo dispensa `host_permissions`, e a janela não passa pelo `connect-src` da extensão? | E2E local | login completo com o manifesto do D13 | veto do §3; o ADR volta a desenho |
| P4 | O `/auth/v1/authorize` aceita `code_challenge` com `code_challenge_method=s256` e um `redirect_to` chromiumapp exato, e devolve `?code=` na query? Onde vêm `error` e `error_code` quando o usuário nega? | pré-spike manual | `?code=` na query; negação só com `error`, `error_code` e `error_description` | recuo do D14 |
| P5 | Um `redirect_to` com `?st=<state>` passa na allow-list com a URL exata, sem curinga? | pré-spike manual | o `st` volta intacto | Q6: tirar o `state`, só se o P8 passar |
| P6 | O que acontece com um `redirect_to` fora da lista, ou com o host do Site URL e caminho arbitrário? Hipótese **não verificada e fora do journal**: o GoTrue aceitaria qualquer redirect com o mesmo host do Site URL | pré-spike manual e HITL-035 | cai na página estática do Site URL (D15), sem código para o destino pedido. Emenda do HITL-035 (2026-11-06), opção A até o S-5: sem código, ou no nosso host com caminho `/`; nunca no host pedido (D15, *HITL-QUEUE §HITL-036*) | Site URL vira só a página estática; residual T48 (§3) |
| P7 | `grant_type=pkce`: nomes dos campos (`auth_code` ou `code`; o PR #2843 do journal pode mudar isso), aceitação da *publishable*, formato do código, `provider_token`, `user` e `expires_in`. A troca feita pela API, fora do navegador que abriu o fluxo, é aceita pelo GoTrue? | pré-spike manual; CI opcional | a troca pela API devolve sessão; campos anotados | recuo do D14 |
| P8 | O servidor impõe o PKCE: sem verifier ou com verifier errado falha; o código é de uso único e vale 5 min | pré-spike manual; CI opcional | os 4 casos (sem verifier, verifier errado, segundo uso, código com mais de 5 min) falham | veto do §3; recuo do D14 |
| P9 | Token real: `typ`, `kid`, `alg`, `session_id`, `is_anonymous`, `aud` string, formato do `amr`, `exp − iat` e tamanho até 8.192 com metadados do GitHub e do Google | relatório de conformidade (D15) | todos os booleanos verdadeiros | ajuste do D7 e do ADR-013 por HITL, nunca afrouxado sem HITL |
| P10 | Rotação: dentro de 10 s, o reuso devolve um token válido? O reuso do pai do token ativo devolve o ativo também depois de 10 s? O reuso de um ancestral mais velho revoga a sessão? | CI (contrato, §4.3) | as duas exceções do §1.1 confirmadas | a nova tentativa do D4 perde a base; residual do §3 revisto por HITL |
| P11 | `logout?scope=global` revoga os refresh de todas as sessões, e o access segue válido até o `exp`? | CI (contrato) | refresh revogado; access aceito até o `exp` | logout volta a desenho, por HITL |
| P12 | O SW sobrevive a um login de mais de 30 s? Mensagens na porta renovam o prazo do SW? | spike manual, sem DevTools aberto | um login de 60 s conclui | `pulso`; depois C2 com o login pendente (D11.8) |
| P13 | `storage.session` some ao reiniciar o navegador e ao atualizar ou recarregar a extensão, no Edge 155 e no Chrome? A extensão do `loadUnpacked` persiste no perfil relançado (a verificar)? | E2E local | storage vazio nos três casos | residual do §3 revisto por HITL |
| P14 | A janela de login compartilha os cookies do perfil? Ela mostra a origem do site? Com o app OAuth já autorizado, GitHub e Google reautorizam sem tela? Numa aba normal, outra extensão com `tabs` vê o `code` no `tab.url` do chromiumapp (T48)? | spike manual | respostas registradas (medição, não portão) | residuais do §3 (*phishing* visual, conta trocada) |
| P15 | O `createRemoteJWKSet` do `jose` 6.2.12 permite conferir se há chaves prontas sem um token (pré-checagem do D6)? | F1-API-07 | `keysReady()` sem token | pré-checagem própria no adapter |
| P16 | A meta CSP do painel (D10 B4) não quebra o bundle de produção (React, *modulepreload* do Vite) e fica fora do HMR do dev? `innerHTML` lança por Trusted Types e um `submit` dispara `securitypolicyviolation` com `form-action`? | E2E local | painel renderiza e as duas violações ocorrem | sai só a diretiva que quebra, por HITL |
| P17 | O ID que o `loadUnpacked` devolve é igual ao ID derivado da `key`? | E2E local | IDs iguais | o E2E usa o ID devolvido |
| P18 | O Custom Access Token Hook existe no plano Free e consegue recusar a emissão? | HITL-035 | sim: o hook vira condição de aceite do T9 (D5) | T9 com residual aceito no HITL-034 (Q10) |
| P19 | Limites de taxa do Supabase Auth no projeto real (refresh e login por IP) | HITL-035 | números anotados | orçamento de saída (D8) abaixo de 50% dos limites locais, por HITL |
| P20 | O `launchWebAuthFlow` interativo em headless, no Edge 155 e no Chrome, resolve com o 302 imediato, sem janela? | E2E local | modo 1 do §4.4 | modo 2 ou 3, fixo por navegador |
| P21 | O gateway do projeto real responde à *publishable* revogada ou errada com um 401 sem o `error_code` do GoTrue (o `Invalid API key`), na troca, na renovação e no logout? (F1-API-08) | spike S-3, com uma *publishable* inválida e sem tocar a sessão de ninguém | o adapter dá `nao_recebido` (503) nas 3 chamadas | emenda do D7 por HITL. O job `db` não reproduz o caso: o Kong local não confere a `apikey` em `/auth/v1/` |

**Emenda do HITL-035 (2026-11-06): resultado por ponto.** O humano rodou o pré-spike (parte 3 do HITL-035) e anotou o P18 e o P19 no painel. O registro completo está no *spike-metrics* §4. O P4, o P7 e o P8 não falharam, e o recuo do D14 não dispara.
- **P4:** aprovado com ressalva. `code` na query e troca 200 (caso A); negação sem `code`, com `error_code` e `error_description` (G); fluxo completo com o Google (H); sem token no fragmento e `s256` aceito. Por inferência, o servidor confere o S256: o A dá 200 com o verifier certo, e o C falha com o errado. Não informados: as chaves exatas da query e do fragmento (A e H), a chave `error`, onde vieram as chaves de erro (G), o G com o Google e o `st` na negação.
- **P5:** aprovado com ressalva. O `st` voltou igual (A). Com o Site URL A, ele pode ter voltado pelo casamento por host do Site URL, e não pela allow-list; o caso F não separou. O `state` fica, a Q6 não é acionada, e o caso é refeito no S-5 (ou ao cadastrar um ID de loja; D15).
- **P6:** **inconclusivo** (*HITL-QUEUE §HITL-036*). No E, `host_igual` deu falso. Com o Site URL A já aplicado, o fallback cairia no nosso host (`host_igual` verdadeiro, caminho `/`). Falso não bate com isso e é também o que daria se o código tivesse ido ao host pedido. Não se sabe quando o Site URL virou A. No F, o `caminho` não foi informado, e "não resolveu" é o esperado em todo retorno chromiumapp (NXDOMAIN). O critério do E no runbook estava errado para a opção A (D15).
- **P7:** aprovado com ressalva. A troca 200 foi feita pelo PowerShell, fora do navegador, com a *publishable*, o campo `auth_code` (inferido) e o `code_verifier`; o H fez o fluxo completo. Não informados: as chaves da resposta, `expires_in`, `token_type`, `provider_token`, `user`, formato e tamanho do código, tamanhos de access e refresh, `alg`, `typ` e `kid`.
- **P8:** aprovado, com ressalva de evidência para o aceite. O 2º uso do código deu 404 `flow_state_not_found` (A); B, C e D deram ≠ 200 (D com `minutos_do_code` acima de 5, contado desde o `Novo-Fluxo`, antes do login). Não informados: status, `error_code` e `code_presente` de B, C e D. C e B são refeitos com evidência completa antes do aceite (CA-15), ou cobertos pelo CI opcional do §4.3.
- **P18:** aprovado com ressalva. O hook está disponível no painel. A recusa da emissão (inclusive na renovação) segue provada só pela documentação. O hook vira condição de aceite e entra antes dele, pela F1-DB-02 (D5).
- **P19:** aprovado com ressalva. Token Refresh: 150 requisições a cada 5 min por IP; Sign-up/sign-in: 30. São iguais aos limites locais do `supabase/config.toml`. Não informados: os outros limites, o balde do `grant_type=pkce` e se o `/logout` conta (D8 item 5).

**Emenda do 05c-1 (F1-EXT-05c, 2026-11-09): resultado no E2E local.**
- **P3:** aprovado em runtime. O login completo (cenário 1 do §4.4) passou no build de produção com o manifesto do D13 conferido na extensão carregada (`runtime.getManifest()`: as 5 permissões, sem `host_permissions` e com o `connect-src` só na API), no Edge 157.0.4341.42 e no Chrome 156.0.8078.80, headless. A janela é navegação: o `authorize` chega sem `Origin`, e nenhum pedido com `Origin: chrome-extension://` chega ao Supabase falso. O veto do §3 sobre o P3 está cumprido no E2E local; o roteiro manual contra o projeto real segue na CA-02.
- **P17:** aprovado. O ID que o `Extensions.loadUnpacked` devolve é o derivado da chave efêmera, nos dois navegadores.
- **P20:** modo 1 nos dois navegadores (§4.4, "Emenda do 05c-1"). O P1 e o P2 seguem no spike manual, com janela e sem DevTools; o E2E prova só o 302 imediato.

**Emenda do 05c-2 (F1-EXT-05c, 2026-11-09): P13 no E2E local.**
- **P13:** aprovado no E2E local, no Edge 157.0.4341.42 e no Chrome 156.0.8078.80, headless (cenário 6 do §4.4). O `storage.session` some na recarga e no reinício do navegador: depois de cada forma, o ID é o mesmo, o handshake dá `sessao{ false, null }`, e `session`, `local`, `sync`, localStorage e IndexedDB da origem ficam vazios.
- A extensão do `Extensions.loadUnpacked` **não** volta sozinha com o perfil relançado, nos dois navegadores (`ERR_BLOCKED_BY_CLIENT` até 3 s depois do launch). Um novo `loadUnpacked` no mesmo caminho a traz de volta com o mesmo ID.
- A forma `chrome.runtime.reload()` roda só no Edge, onde o SW novo sobe em menos de 500 ms. No Chrome 156, a extensão carregada por CDP e recarregada assim fica bloqueada até o fim do navegador, e nem um novo `loadUnpacked` a traz de volta. É limite do harness, não do produto: no Chrome, o cenário 6 roda com o `loadUnpacked` e o reinício (o §4.4 aceita as duas formas).
- O residual do §3 não muda. O reinício e a atualização com a extensão instalada de verdade (loja ou modo de desenvolvedor) seguem no spike manual.

## 2. Decisões

### D1. Escolha: opção (a), com BFF sem estado e refresh selado
- `[ARCHITECT]` e `[APPSEC]` escolhem a opção (a) do ADR-001 §5.0.1, com três reforços:
  1. **BFF sem estado.** A API é o único cliente do Supabase Auth (GoTrue) a partir da extensão. Não há Redis nem tabela de sessão.
  2. **Refresh selado.** A extensão nunca recebe o refresh token cru do Supabase. Recebe um envelope AES-256-GCM que só a API abre (D5).
  3. **Idade máxima e inatividade sem estado, só nas sessões do BFF.** O início da sessão e a última renovação vão selados no envelope, e a API recusa a renovação vencida sem rede (RFC 10017 §6.3.2.3; RFC 9700 §4.14.2).
     - Isso fecha o gap do T9 **só para as sessões criadas pelo BFF**. Uma sessão criada direto no GoTrue (fluxo PKCE iniciado pelo atacante, T48; ou o portal) continua sem expiração no Free.
     - O T9 só fecha por inteiro com o Custom Access Token Hook (D5), se o P18 confirmar no Free. Sem ele, residual declarado (§3).
- **Por que (a):**
  - `launchWebAuthFlow` é a única API de identidade que serve ao Chrome e ao Edge (§1.1).
  - O `connect-src` continua só na API (SR-02; threat-model §6; Blueprint l.219). O `externally_connectable` continua vazio (Blueprint l.221, corrigido pelo threat-model §6 (D-H7); `manifest.test.ts` L34-36).
  - Não depende do portal, que é só o scaffold [J:portal].
  - Segue o texto do Blueprint (l.119, l.272).
- **O access token é o do Supabase, sem alteração.** Ele precisa passar no verificador do ADR-013 e seguir até o PostgREST (ADR-018 D5/D6) [J:api].
- **Por que o envelope, e não repassar o refresh cru:**
  - um blob forjado morre no `open` local, sem chamada ao GoTrue (T43). O AEAD não barra o *replay* de um envelope genuíno: quem o limita é a inatividade, a idade máxima e o orçamento de saída (D8);
  - a idade máxima e a inatividade saem sem estado (T9, sessões do BFF);
  - um refresh roubado do `storage.session` não serve direto no `/auth/v1/token`, porque está cifrado com uma chave que só a API tem (T44);
  - `provider_token`, `user` e e-mail nunca saem da API (T45).
- **O preço** são emendas explícitas ao ADR-013 D2, ao ADR-007 D6/ADR-021 D8.3, ao ADR-014 e ao ADR-018, cada uma com a sua proteção (§6.1).

### D2. Mecanismo de login
- **Authorization Code + PKCE S256** do Supabase Auth hospedado (`/auth/v1/authorize`), aberto pelo SW com `browser.identity.launchWebAuthFlow({ url, interactive: true })`.
- **Provedores:** `github` e `google`, e só eles (HITL-004). E-mail, senha, *magic link*, OTP e telefone ficam proibidos em produção. O `config.toml` local só liga e-mail e senha para o `test:db`.
- **Proibido:**
  - `identity.getAuthToken` (não existe no Edge e só cobre Google);
  - `response_type=token` ou qualquer *implicit* (RFC 9700 §2.1.2);
  - `code_challenge_method=plain` e qualquer *downgrade* (RFC 7636 §7.2). Sem `crypto.subtle`, o login falha fechado;
  - `interactive:false` e renovação silenciosa por cookie do IdP. A renovação é só pelo refresh (D11);
  - curinga na Redirect URL do Supabase.
- **Um fluxo por vez.** Evita janelas concorrentes, verifier órfão em memória e o retorno de um fluxo resolvendo outro. (A sobreposição da documentação é do `supabase-js`, que guarda o verifier no cliente; aqui o verifier é nosso.) O prazo do fluxo é de 5 min, a validade do código.
- **Login só com gesto.** O fluxo abre quando o usuário clica em "Entrar com …" no painel. Nunca na instalação nem no `onStartup` (recomendação do Chrome).

### D3. Fluxo de login no Service Worker
**Porta `AuthCodeSource`** (`src/auth/auth-code-source.ts`):
- `obtainRedirect({ authorizeUrl, redirectUri }): Promise<{ ok: true; url: string } | { ok: false }>`. Nunca rejeita.
- Adapter de produção: `src/auth/web-auth-flow-source.ts`, o **único arquivo** que toca `browser.identity` (lint, D10).
- Adapter falso do E2E: só no build de teste (§4.4). As contingências do D14 seriam adapters da mesma porta.

**Passos:**
1. **Painel → SW:** `{ kind: "entrar", provedor: "github" | "google" }` pela porta `trampo/sidepanel/v1`.
2. **SW (`auth-service.login`):** se já há fluxo em curso ou sessão local, ignora. Se faltar `TRAMPO_API_ORIGIN` ou `TRAMPO_SUPABASE_ORIGIN` no build, emite `sessao{ autenticado: false, erro: "ERRO_INTERNO" }` e registra `auth_sem_configuracao`.
3. Gera, **só em memória** do módulo:
   - `verifier`: 32 bytes de `crypto.getRandomValues`, em base64url (43 caracteres);
   - `challenge = base64url(SHA-256(verifier))`, por `crypto.subtle.digest`;
   - `state`: 16 bytes em base64url (22 caracteres);
   - `deadline = agora + 300 s`.
4. `redirectUri = browser.identity.getRedirectURL("auth")`, que deve dar `https://<id>.chromiumapp.org/auth` (P2).
5. `authorizeUrl = ${TRAMPO_SUPABASE_ORIGIN}/auth/v1/authorize?provider=<p>&redirect_to=<enc(redirectUri + "?st=" + state)>&code_challenge=<challenge>&code_challenge_method=s256`.
   - O `?st=` só entra se o P5 provar que a allow-list aceita a query com a URL exata. Se não aceitar, o `state` sai, e a defesa contra CSRF de login fica com o PKCE imposto pelo servidor (RFC 9700 §4.7.1), condicionada ao P8. Nunca curinga.
   - A grafia `s256` em minúsculas segue o `supabase-js` por conhecimento prévio, não verificado (P4).
   - **Emenda do HITL-035 (2026-11-06):** o `?st=` fica (P5 aprovado no caso A) e é refeito no S-5 (D15). Se falhar lá, vale a Q6 (o P8 já passou). Nunca curinga. A grafia `s256` em minúsculas foi aceita (casos A e H; o C, com verifier errado, foi recusado).
6. `AuthCodeSource.obtainRedirect`. O caminho esperado é Supabase → GitHub ou Google → callback do Supabase → 302 para `redirect_to?code=…`.
7. **`parseAuthRedirect(url, redirectUri, state)`**, função pura, em falha fechada:
   - `origin + pathname` igual a `redirectUri`, byte a byte (sem barra final);
   - fragmento com `access_token` ou qualquer chave fora de `{ error, error_code, error_description }`: recusa (*downgrade* para *implicit*). O token nunca é usado;
   - `error` ou `error_code` presente (na query ou no fragmento): é negação ou cancelamento no IdP. O texto **nunca** é exibido nem registrado, porque é texto do atacante;
   - parâmetros da query contidos em `{ code, st }`, sem repetição;
   - `code` casa com `AuthCodeSchema`; `st` igual ao `state`, sempre (emenda do HITL-035, 2026-11-06: saiu o "se o P5 passar").
8. **SW → API:** `POST /v1/auth/exchange` com `{ schemaVersion: 1, authCode, codeVerifier }`, pelo `api-client` (D10). O verifier é apagado da memória logo depois do envio, qualquer que seja o resultado.
9. **API:** passos do D4.
10. **SW:** valida `AuthSessionResponseSchema`, grava `trampo/sessao/v1` e emite `sessao{ autenticado: true, erro: null }`.

- Qualquer falha emite uma `sessao` no fim da tentativa, conforme a tabela do D12. O SW não interpreta as mensagens de erro do navegador, que mudam entre o Chrome e o Edge.
- Logs do SW, só motivos de lista fechada: `auth_fluxo_cancelado`, `auth_retorno_recusado`, `auth_troca_recusada`, `auth_indisponivel`, `auth_renovacao_recusada`, `auth_sem_configuracao`, `auth_logout_remoto_falhou`. Nunca código, verifier, `state`, token, envelope ou URL (T23).
- **Emenda do 05a-3 (F1-EXT-05a, 2026-11-07), decisões de implementação do `auth-service`:**
  - a porta ganhou `redirectUri()`: o `getRedirectURL` é `browser.identity`, que só existe no adapter (B2). O `obtainRedirectSafely` impõe o "nunca rejeita" do lado de quem chama: só `{ ok: true, url: <string> }` passa, e rejeição, lançamento ou outra forma viram `{ ok: false }`;
  - o `auth-service` recebe `config: { api, supabaseOrigin } | undefined` (montado no 05a-4 só com as duas origens) e um `setTimer` injetado. Sem `config`, ou com o preparo falhando (origem fora da forma ou sem `crypto.subtle`), emite `{ false, ERRO_INTERNO }` e registra `auth_sem_configuracao`;
  - com sessão local, o clique emite o estado atual sem abrir o IdP, e o painel desliga o "entrando". Com fluxo em curso, o clique é ignorado, e o fluxo emite no fim;
  - o verifier vive só no slot da tentativa, e a presença dele é a vida do fluxo. O prazo de 5 min apaga o verifier, emite `{ false, null }` com `auth_fluxo_cancelado` e libera o próximo clique, mesmo com a janela do IdP aberta; um retorno que chega depois disso é descartado sem troca. O verifier é apagado logo depois do `post` da troca, antes do resultado. Uma string em JS não se zera: "apagar" solta a referência do slot (resíduo aceito);
  - "Sair" durante o login: com o retorno ainda pendente, o código não vai à API; com a troca em voo, a sessão que chega é descartada pela geração;
  - mapa da troca: 200 no contrato grava. 401 com o `ApiError` `NAO_AUTENTICADO`, outro 4xx, 200 fora do contrato e `pedido_recusado` dão `{ false, ERRO_INTERNO }` com `auth_troca_recusada`. 429 dá `LIMITE_DE_TAXA`; 5xx, `sem_resposta` e `resposta_ilegivel` dão `SERVICO_INDISPONIVEL`, os dois com `auth_indisponivel`. A troca não tem nova tentativa, porque o código é de uso único;
  - **M-03:** o retorno chega uma vez por fluxo (a porta resolve uma vez), então o "segundo retorno com o mesmo `state`" do §4.7 é provado por 4 testes: o retorno depois do prazo, com e sem outro clique, recusado sem `POST`; o retorno com o `state` do fluxo anterior recusado sem `POST`; e, com a troca em voo, o prazo não encerra o fluxo nem libera outro, porque o verifier já foi apagado.
- **Emenda do 05a-4 (F1-EXT-05a, 2026-11-08), adapter de produção e composição:**
  - `src/auth/web-auth-flow-source.ts` (`webAuthFlowSource()`) lê o `browser.identity` a cada chamada. O `redirectUri()` só devolve `https://<32 letras de a a p>.chromiumapp.org/auth`, byte a byte (o alfabeto do ID do Chromium); outra forma (outro host, subdomínio, porta, query, barra final, prefixo) lança, e o preparo do login fecha com `{ false, ERRO_INTERNO }` e `auth_sem_configuracao`, sem abrir o IdP (P2 em falha fechada). O `obtainRedirect` chama `launchWebAuthFlow({ url, interactive: true })`, sem outra opção; retorno sem URL, rejeição ou lançamento síncrono viram `{ ok: false }`;
  - `src/auth/worker-auth.ts`: o `authConfigFrom` monta o `config` só com as duas origens https exatas (vazio, `http`, caminho ou barra final dão `undefined`, sem lançar), e o `createWorkerAuth` liga o `authSessionStore()`, o adapter, `Date.now` e o `setTimeout`. O `background.ts` só chama o `createWorkerAuth` com o `import.meta.env` do build e um `log` que escreve só o motivo; a emissão não tem destino até a F1-EXT-05b, que liga o serviço às mensagens do painel.

### D4. BFF sem estado: rotas e passos

| Rota | Pública? | Origem | Limite | Corpo | Sucesso |
|---|---|---|---|---|---|
| `POST /v1/auth/exchange` | **sim** (emenda ao ADR-013 D2) | só extensão, `Origin` obrigatório | local, 10/min por balde de IP | até 2.048 B, `AuthExchangeRequestSchema` | 200 `AuthSessionResponse` |
| `POST /v1/auth/refresh` | **sim** | só extensão, `Origin` obrigatório | local, 30/min por balde de IP | até 2.048 B, `AuthRefreshRequestSchema` | 200 `AuthSessionResponse` |
| `POST /v1/auth/logout` | **não** (Bearer) | extensão; sem `Origin` segue, o Bearer protege | Redis, classe `padrao` (ADR-014 D4) | até 2.048 B, `AuthLogoutRequestSchema` | 204 |

- As três usam POST com JSON. Cabem no preflight atual, sem emendar métodos nem headers (`cors.ts` L9-11).
- Todas as respostas, inclusive de erro, saem com `Cache-Control: no-store` (padrão do ADR-021 D2).
- O GoTrue é chamado numa URL fixa derivada de `SUPABASE_URL`. Nada do cliente vira URL (T19). O `redirect_to` nunca passa pela API.
- **Ordem na borda:** CORS → tipo de mídia → autenticação (as duas rotas públicas não leem `Authorization`) → **limitador local pré-JWT** (só nas duas públicas) → rate limit no Redis (só depois do JWT, sem mudança) → `bodyLimit` de 2.048 → Zod estrito. Nada consome o orçamento de saída (D8 item 5) antes do Zod e, na renovação, antes do `open`.

**Troca (`ExchangeSession`):**
1. Formato conferido antes da rede (`AuthCodeSchema`, `PkceVerifierSchema`).
2. `AccessTokenVerifier.keysReady()` (D6). Sem chaves, 503 sem chamar o GoTrue.
3. Orçamento de saída, partição `troca`, e *bulkhead* (D8 item 5).
4. `AuthTokenGateway.exchangePkce` → `POST ${SUPABASE_URL}/auth/v1/token?grant_type=pkce` com `{ auth_code, code_verifier }` (nomes a verificar no P7) e `apikey` *publishable*. Prazo de 5 s, teto de 32 KiB, `redirect: "error"`, **sem retry**.
   - **Emenda do HITL-035 (2026-11-06):** corpo `{ auth_code, code_verifier }`, com `apikey` *publishable* e sem `Authorization`, inferido do pré-spike (P7). Um nome só, sem nova tentativa com `code`, que seria uma 2ª chamada ao GoTrue. O endpoint segue sem documentação oficial: o spike (CA-02) e o teste opcional do §4.3 refazem a prova.
5. Projeção de `{ access_token, refresh_token, expires_in, token_type: "bearer" }`. O resto (`user`, `provider_token`, `provider_refresh_token`) é descartado na hora.
6. `AccessTokenVerifier.verify` → `{ userId, sessionId }`. Aqui o `sessionId` é obrigatório. `sessionId` nulo, `expires_in > 900` ou `exp − iat > 900` dão 503 e `auth_token_fora_da_politica`, sem *clamp* silencioso.
7. Sela o envelope com `{ rt, sid: sessionId, sst: agora, iat: agora }` (D5).
8. Responde `200 { schemaVersion: 1, accessToken, refreshToken: <envelope>, expiresIn: min(expires_in, 900 − idade do token) }`. O `min()` só desconta a idade.
   - **Emenda da revisão da F1-AUTH-00 (2026-11-06), a cargo da F1-API-07:** o `expiresIn` sai em segundos inteiros (arredondado para baixo). Se o resultado for menor que 1 (token com idade de 900 s, ou de 900 a 909 s pela `clockTolerance` de 10 s do verificador), a resposta é 503 com `auth_token_fora_da_politica`, nunca 200 nem 500: o contrato exige `expiresIn` de 1 a 900. O §4.2 ganha os casos de idade 899, 900 e 909 s.

**Renovação (`RefreshSession`):**
1. `RefreshSealer.open(envelope, origin)`. Falha dá 401 sem rede (`auth_envelope_invalido`).
2. `agora − sst > AUTH_SESSION_MAX_AGE_SECONDS` dá 401 **sem rede** (`auth_sessao_idade_maxima`). Não há revogação de melhor esforço.
3. `agora − iat > AUTH_SESSION_IDLE_SECONDS` dá 401 **sem rede** (`auth_sessao_inativa`).
4. `AccessTokenVerifier.keysReady()`. Sem chaves, 503 **sem consumir o refresh**.
5. Orçamento de saída, partição `renovacao`, e *bulkhead* (D8 item 5).
6. GoTrue `grant_type=refresh_token` com `{ refresh_token: rt }`. A falha é classificada:
   - **o GoTrue não recebeu** (*bulkhead*, orçamento, conexão recusada, 429, 5xx): 503, sem nova tentativa;
   - **o GoTrue pode ter rotacionado** (prazo estourado depois do envio, corpo inválido ou acima do teto): **uma** nova tentativa em até cerca de 2 s, com o mesmo `rt`. Ela se apoia nas duas exceções de reuso do §1.1 (P10). Se falhar, 503.
7. Verifica o access novo, com as regras do passo 6 da troca. `session_id` diferente do `sid` dá 401 **depois** do refresh, e o refresh novo é descartado (sessão órfã, residual §3).
8. Sela de novo com o **mesmo `sst`** e um `iat` novo. Responde 200.

**Logout (`EndSession`):**
1. Exige Bearer válido (rota protegida), classe `padrao`.
2. `POST ${SUPABASE_URL}/auth/v1/logout?scope=global` com `apikey` *publishable* e o Bearer do usuário. O escopo é fixo no servidor; o cliente não escolhe.
3. GoTrue 2xx ou 401 (sessão já revogada) dá 204. 5xx, prazo ou rede dá 503.
   - **Emenda da F1-API-08 (2026-11-11, achado A-01):** o 401 sai da lista. Só o 2xx e o 403 com `error_code` exato `session_not_found` (emenda do 07h, §4.3) dão 204. Qualquer outro status, inclusive o 401, dá 503 (D7).

**Peças novas na API** (código puro com dependências injetadas, no molde dos casos de uso atuais):
- porta `application/ports/auth-token-gateway.ts`: `exchangePkce`, `refresh` e `logout` devolvem `{ ok: true, tokens }` ou `{ ok: false, reason: "recusado" | "nao_recebido" | "pode_ter_rotacionado" }` e nunca rejeitam;
  - **Emenda do HITL-035 (2026-11-06):** um 404 do GoTrue só vira `recusado` com o corpo JSON do GoTrue e um `error_code` string. Sem esse corpo (HTML, vazio, rota ou proxy errado), vira `nao_recebido` (D7). O `error_code` nunca sai da API nem vai a log;
- adapter `infrastructure/supabase/gotrue-token-client.ts`, sem SDK, no padrão do `postgrest-user-client`. O construtor recusa chave `sb_secret_` e legada `eyJ`;
  - **Emenda do 07c (F1-API-07, 2026-11-07), decisões de implementação do adapter:**
    - entrada fora da forma (`AuthCodeSchema`, `PkceVerifierSchema`, refresh de 1 a 512 caracteres, `AccessTokenSchema` no logout) dá `nao_recebido` sem rede;
    - entre as falhas do `fetch`, só a conexão que nem abriu (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `EHOSTUNREACH`) e o redirecionamento recusado são `nao_recebido`. Prazo, aborto do chamador e socket fechado são `pode_ter_rotacionado`: o adapter não distingue o prazo de conexão do prazo depois do envio, e o lado conservador custa no máximo uma chamada a mais na renovação;
    - o redirecionamento é reconhecido pela mensagem do undici (`unexpected redirect`), presa por teste em socket real. Se o Node mudar a mensagem, o redirecionamento cai em `pode_ter_rotacionado` (lado conservador) e o teste quebra;
    - 2xx que não é 200, e 200 fora da forma, são `pode_ter_rotacionado`. Status fora da tabela do D7 (304, 405, 409, 410…) são `nao_recebido`;
    - o logout devolve `ok` com 2xx ou 401; 400, 403, 422 e o 404 com o corpo do GoTrue são `recusado`. O mapa para 204 ou 503 fica com o `EndSession` (07f);
      - **Emenda da F1-API-08 (2026-11-11):** o logout devolve `ok` só com 2xx ou com o 403 `session_not_found`. Os 5 status de recusa (400, 401, 403, 404 e 422) só são `recusado` com o corpo JSON do GoTrue e um `error_code` string; sem ele, `nao_recebido`, na troca, na renovação e no logout (D7);
    - a porta aceita um `signal` opcional, para o `RefreshSession` limitar a nova tentativa a cerca de 2 s (§4.2). Com o signal já abortado, nada sai (`nao_recebido`);
    - o `expires_in` passa como veio (inteiro positivo). A recusa acima de 900 é do caso de uso, sem *clamp* (D4, troca, passo 6);
    - lista fechada de cabeçalhos em `GOTRUE_CLIENT_POLICY.outboundHeaders`: `apikey`, `content-type` e `accept` no `/token`; `apikey`, `authorization` e `accept` no `/logout`, sem corpo.
- porta `application/ports/refresh-sealer.ts` (`seal`, `open` → `{ ok: false }` sem exceção) e adapter AEAD (D5);
- casos de uso `ExchangeSession`, `RefreshSession` e `EndSession` em `application/auth/`;
  - **Emenda do 07f (F1-API-07, 2026-11-07, `e1af5d0`), decisões de implementação dos casos de uso:**
    - código puro em `application/auth/` (`exchange-session.ts`, `refresh-session.ts`, `end-session.ts` e o comum `auth-session.ts`), com as portas injetadas e dois relógios: o de parede (`now`, epoch em ms) para `sst`, `iat` e a idade do token, e o `Clock` monotônico só para o prazo da nova tentativa;
    - o resultado é uma união discriminada que a rota (07g) mapeia pelo D7: `sessao` (200), `nao_autenticado` (401), `indisponivel` (503, com o `retryAfterSeconds` do orçamento ou do *bulkhead*, ou `null`), `entrada_invalida` (400, segunda trava depois do Zod da borda) e, no logout, `encerrada` (204). O motivo é a mensagem do catálogo do D8 item 7;
    - o `sid` divergente usa o motivo `auth_renovacao_recusada`, sem mensagem nova no catálogo. Na renovação, o 503 `auth_token_fora_da_politica` só nasce depois de o GoTrue responder 200, ou seja, depois da rotação: o 07g registra junto a `auth_renovacao_perdida` (D6);
    - a idade do token usa o relógio com milissegundos: `expiresIn = floor(min(expires_in, 900 − (agora − iat)))` nunca promete vida a mais (idade de 899,5 s dá 503; de 899 s exatos, `expiresIn` 1). O `sst` e o `iat` do envelope são segundos inteiros, para baixo. A idade máxima e a inatividade também comparam com milissegundos, e o limite exato passa: só passar dele é recusado;
    - a resposta é montada campo a campo e reparseada pelo `AuthSessionResponseSchema`: token fora do `AccessTokenSchema`, envelope fora do `SealedRefreshSchema` ou `expiresIn` fora de 1 a 900 dão 503 `auth_token_fora_da_politica`;
    - a nova tentativa da renovação usa o `withDeadline` (2 s no `Clock`): o `signal` aborta a chamada, e mesmo um gateway que o ignore perde a corrida. Ela passa por outro `run("renovacao")`; negada, dá 503 com o `retryAfterSeconds` da negação. Qualquer falha dela é 503, inclusive a recusa, porque o 1º pedido pode ter rotacionado;
    - os casos de uso não confiam nas portas: `keysReady` que rejeita ou devolve algo diferente de `true`, `verify` que rejeita, `seal` ou `open` que lançam e gateway que rejeita viram falha fechada (503, ou 401 no `open`), no molde do ADR-014 §3, restrição 2;
    - logout: qualquer falha do GoTrue, inclusive o `recusado` do adapter (400, 403, 422 e 404 com o corpo do GoTrue), é 503. O 204 só sai com a sessão encerrada.
- hook `presentation/edge/pre-auth-limit.ts` e rotas em `presentation/routes/auth.ts`;
  - **Emenda do 07g (F1-API-07, 2026-11-07, `b516fd0`), decisões de implementação das rotas:**
    - as 3 rotas só existem com a opção `auth` do `buildApp`. O `composeApp` monta tudo uma vez por processo: um `GotrueEgress`, um limitador local, uma amostragem de log e o mesmo verificador das rotas protegidas;
    - o mapa do D7 é um `switch` sobre o `kind`, sem regra nova:
      - `sessao` → 200 com o corpo como veio (o `serializerCompiler` ainda confere o `AuthSessionResponseSchema` na saída);
      - `nao_autenticado` → 401 `NAO_AUTENTICADO`, **sem** `WWW-Authenticate`, porque a rota não usa Bearer;
      - `indisponivel` → 503 `SERVICO_INDISPONIVEL`. O `retryAfterSeconds` do orçamento ou do *bulkhead* vai no corpo e no `Retry-After`; o `null` sai sem `Retry-After`, como os outros 503 da borda;
      - `entrada_invalida` → 400 `PAYLOAD_INVALIDO`;
      - `encerrada` → 204 sem corpo;
    - caso de uso que rejeita (quebra a promessa) dá 503 com `auth_provedor_indisponivel`, nunca 500;
    - segunda trava no handler, atrás da borda: sem `Origin`, 403 sem chamar o caso de uso; no logout, sem principal ou sem Bearer, 401;
    - o logout declara `config.rateLimit: "padrao"` (emenda ao ADR-014 D4) e exige `{ schemaVersion: 1 }` no corpo;
    - ordem efetiva, provada por teste: CORS (`Origin` e origem de web) → tipo de mídia → JWT e rate limit (sem efeito nas públicas) → limitador local no `onRequest` da rota → `bodyLimit` → Zod → caso de uso. Corpo fora do contrato conta no limitador e não chega ao GoTrue nem ao orçamento.
- variáveis novas no `.env.example`, só os nomes: `AUTH_REFRESH_SEAL_KEYS`, `AUTH_REFRESH_SEAL_ACTIVE_KEY`, `AUTH_SESSION_MAX_AGE_SECONDS`, `AUTH_SESSION_IDLE_SECONDS`, `AUTH_ALLOWED_AMR` e `API_BEHIND_PROXY`.

### D5. Envelope selado do refresh
- **Forma:** `r1.<kid>.<iv>.<cifrado>.<tag>`, cada parte em base64url canônico, no mesmo padrão do `s1` da pretensão (`salary-cipher.ts` L5-27; ADR-018 D4).
- **Algoritmo:** AES-256-GCM do `node:crypto`, IV de 96 bits aleatório por selagem, tag de 128 bits. Sem dependência nova. O código generaliza o `salary-cipher` num AEAD por finalidade (`infrastructure/crypto/aead-envelope.ts`), com prefixo e AAD próprios de cada finalidade.
- **Texto claro** (`z.strictObject`), com teto de 768 bytes:
  - `rt`: o refresh do Supabase, `string(1..512)`. O formato real fica a verificar (P9);
    - **Emenda da revisão da F1-AUTH-00 (2026-11-06), a cargo da F1-API-07:** o teto de 768 bytes vale para o texto claro serializado, em bytes. Com `rt` ASCII, o pior caso tem 600 bytes (provado no `test/auth.test.ts`); com `rt` fora do ASCII, ou com caracteres que o JSON escapa, passaria de 768, e a API selaria um envelope que o próprio `SealedRefreshSchema` recusa. O `seal` confere o tamanho em bytes, ou o `rt` fica restrito a um alfabeto ASCII sem escape, e o excesso dá 503 `auth_token_fora_da_politica`;
  - `sid`: `session_id` do token, UUID;
  - `sst`: início da sessão, epoch em segundos, pelo relógio da API;
  - `iat`: momento da selagem (última troca ou renovação), epoch em segundos. É a base da inatividade.
- **AAD:** `trampo:auth.refresh:r1:<Origin>`. Liga o envelope ao build da extensão. É higiene, não autenticação: um script fora do navegador forja o `Origin`. O vínculo ao remetente fica como alternativa da Fase 2 (§5).
- **Anel próprio, separado do anel da pretensão:**
  - `AUTH_REFRESH_SEAL_KEYS=<kid>:<32 bytes em base64url>,...` (de 1 a 4 chaves);
  - `AUTH_REFRESH_SEAL_ACTIVE_KEY=<kid>`;
  - o boot falha fechado com formato errado, `kid` repetido ou `kid` ativo ausente, sem ecoar valor;
    - **Emenda da revisão da F1-AUTH-00 (2026-11-06):** o `kid` é `[a-z0-9]{1,16}`, a mesma faixa do `SealedRefreshSchema` (D7) e do runbook *auth-extensao* §1.3. Fora dela, o boot falha fechado; senão a API selaria envelopes que o SW recusa, sem erro no boot. Na F1-API-07, um teste prende o boot à regex do contrato;
    - **Emenda da revisão da F1-AUTH-00 (2026-11-06):** o `SealedRefreshSchema` confere só a forma e aceita base64url não canônica (por exemplo, o último caractere da tag fora de `A`, `Q`, `g` e `w`, ou um cifrado com comprimento ≡ 1 mod 4). O `open` do `aead-envelope` decodifica cada parte em base64url canônica (molde do `decodeCanonical` do `salary-cipher.ts`) e recusa o resto com 401 sem chamar o GoTrue, para o envelope não ser maleável (SR-21; caso no §4.2);
  - as chaves ficam só no `.env` da API e no gerenciador de segredos. Nunca no cofre, no git, no banco ou na extensão.
  - **Emenda do 07g (F1-API-07, 2026-11-07, `b516fd0`):** o boot lê o anel e as idades (`readAuthSessionEnv`) e recusa material de chave repetido entre este anel e o da pretensão, qualquer que seja o `kid` (`KeyringReuseError`, sem ecoar `kid` nem chave). Fecha a pendência do 07b.
- **Rotação de chave:** a selagem usa a ativa e a abertura aceita qualquer `kid` do anel. Retirar uma chave derruba as sessões seladas com ela. A consequência é só um novo login.
- **Idade máxima:** `AUTH_SESSION_MAX_AGE_SECONDS`, padrão 86.400 (24 h), limites de 3.600 a 604.800, validado no boot e fixado por teste contra este ADR. O valor final é decisão do HITL-034 (Q2).
- **Inatividade:** `AUTH_SESSION_IDLE_SECONDS`, recomendação 14.400 (4 h), limites de 900 até `AUTH_SESSION_MAX_AGE_SECONDS`, validado no boot. O valor final é decisão do HITL-034 (Q3).
- **Custom Access Token Hook, condição para fechar o T9 por inteiro:**
  - recusa emitir token quando `auth.sessions.created_at` passa de `AUTH_SESSION_MAX_AGE_SECONDS`. Cobre **todas** as sessões, inclusive as criadas fora do BFF (T48), a chave de selagem vazada e a sessão órfã;
  - se o P18 confirmar o hook no Free, ele entra antes do aceite, com migration por HITL, no molde do HITL-023;
  - **Emenda do HITL-035 (2026-11-06):** o P18 confirmou o hook no painel. Ele entra **antes do aceite**, pela F1-DB-02: migration com HITL próprio (molde do HITL-023) e teste da recusa no job `db` (§4.3). O ramo "se não existir no Free, o HITL-034 aceita o residual (Q10)" saiu. Restrições:
    - o `http_code` da recusa fica no conjunto que o D7 mapeia para 401 (ex.: 403), nunca 5xx;
    - a idade máxima em SQL é travada por teste contra `AUTH_SESSION_MAX_AGE_SECONDS` (86.400);
    - grants só para `supabase_auth_admin`, com `revoke` de `anon`, `authenticated` e `public`;
    - um erro na função derruba toda emissão (falha fechada para todos), então precisa de teste;
    - registrar o efeito no portal (F1-PORTAL-01).
  - **Emenda da F1-DB-02 (2026-11-12, `cf5fe64`):** o hook foi desenhado e entregue por migration no [ADR-026-custom-access-token-hook](ADR-026-custom-access-token-hook.md) (ADR próprio, porque é um artefato de banco com migration, grants, runbook e HITL; `[APPSEC]` sem veto). Resumo:
    - função `trampo_hooks.custom_access_token(event jsonb)`, em schema fora do PostgREST, `plpgsql`, `stable`, `security invoker` e `search_path` vazio; grants só para o `supabase_auth_admin`;
    - recusa com 403, pelo objeto `error`, a sessão com mais de 86.400 s, a que não existe e a sem data; o evento fora da forma dá 500 (falha fechada sem laço de relogin, T30);
    - **a recusa na emissão inicial não é alcançável** (no GoTrue v2.197.0 a sessão nasce na mesma transação do hook): o hook corta a **renovação**, e a recusa não consome o refresh;
    - a constante 86.400 fica literal na função e presa por teste ao padrão do `AUTH_SESSION_MAX_AGE_SECONDS`. Com a variável diferente, os dois limites valem e o menor ganha (*BACKLOG §F1-API-09*);
    - o efeito no portal está no *BACKLOG §F1-PORTAL-01*; aplicar no projeto real e ligar o hook é o *HITL-QUEUE §HITL-040* (runbook *supabase-hook-real*).
- **Emenda da F1-API-09 (sessão 29, 2026-11-13, só o desenho; `[ARCHITECT]` + `[APPSEC]`, sem veto):** o teto do `AUTH_SESSION_MAX_AGE_SECONDS` desce de 604.800 para **86.400**.
  - **Por quê:** o *HITL-QUEUE §HITL-040* fechou: o hook está ligado no projeto real e recusa a renovação da sessão com mais de 86.400 s, qualquer que seja a variável. Acima disso, a variável não tem efeito nenhum e nada avisa, porque o menor limite ganha. Um valor que o hook anula é uma configuração mentirosa: quem lê o `.env` acredita numa sessão de 7 dias que morre em 24 h.
  - **Decisão:** `AUTH_SESSION_LIMITS.maxAgeSeconds` passa a `{ fallback: 86_400, min: 3_600, max: 86_400 }` (`apps/api/src/infrastructure/auth/auth-session-env.ts`). O boot **recusa** o valor acima do teto, pelo `AuthSessionConfigError` de hoje: mensagem com o nome da variável, sem o valor (falha fechada, a API não sobe). Valor menor continua aceito: a API corta antes, e o hook fica como a rede de segurança. A inatividade não muda (teto = a idade configurada).
  - **Alternativa recusada:** aviso no boot quando a variável passar do hook. A API não lê o catálogo do banco (só a *publishable* e o JWT do usuário, ADR-018 D5), então o aviso seria um palpite sobre o valor da função. Também foi recusada a leitura do `pg_get_functiondef` pela API: seria uma credencial nova no processo.
  - **Uma constante, dois lugares:** o 86.400 literal da migration fica preso por teste ao **teto** e ao **padrão** do `AUTH_SESSION_LIMITS`, que passam a ser iguais. Subir a idade no futuro exige migration nova, a constante e uma emenda deste D5, juntas.
  - **Testes do código (próxima sessão):**
    - `test/infrastructure/auth-session-env.test.ts`: 86.400 aceito; 86.401 e 604.800 recusados com a mensagem sem o valor; 3.600 aceito; a inatividade acima da idade configurada continua recusada;
    - `test/compose-app.test.ts`: o boot com `AUTH_SESSION_MAX_AGE_SECONDS=86401` não sobe, e nenhum log traz o valor;
    - `test/db/auth-hook.db.test.ts`: o `secs => N` lido do `pg_get_functiondef` é igual ao `max` **e** ao `fallback` do `AUTH_SESSION_LIMITS` (hoje compara só com o `fallback`);
    - o comentário do `DECIMAL_SECONDS` ("cobre o teto de 604.800") é atualizado; a regex de até 7 dígitos fica, porque o corte por faixa vem depois.
  - **Mutação** (`mut_api09.py`, molde do `mutlib.py` da sessão 29): o teto de volta a 604.800; a comparação `>` trocada por `>=` (86.400 recusado); o `fallback` diferente do `max`; o `test:db` comparando só com o `fallback`. O último se prova pela pilha simulada da sessão 24 ou pelo job `db` do PR.
  - **Efeito na operação:** um `apps/api/.env` com `AUTH_SESSION_MAX_AGE_SECONDS` acima de 86.400 impede a API de subir depois da mudança. A equipe não lê o `.env` (AGENTS §3.2): o aviso vai no runbook *auth-extensao* §1.5 e na mensagem do commit. O `.env.example` não muda (a variável fica sem valor).
  - **Ameaças:** T9 e T48 sem mudança de status (o hook já corta); efeito em SR-21 (a idade em um só valor). Nenhuma fronteira nova.

### D6. Verificação antes de repassar e JWKS em falha fechada
- **Todo access token que vem do GoTrue passa pelo `AccessTokenVerifier` antes de sair da API.** Isso pega HS256, token anônimo e `session_id` ausente.
  - **Não pega** `jwt_expiry` acima de 900, porque mede a idade pelo `iat` (§1.2). Quem pega é a checagem de `expires_in` e `exp − iat` no BFF (D4, passo 6). Também não detecta "e-mail ligado" (residual, §3).
- **`amr` exigido** (emenda ao ADR-013 D4): o verificador exige a claim `amr` com algum método `oauth` e recusa com 401 qualquer outro (`password`, `otp`, `magiclink`, `anonymous`).
  - A lista vem de `AUTH_ALLOWED_AMR`, com padrão `oauth`. A pilha do `test:db` pode permitir `password` só com `NODE_ENV=test`, e o boot de produção recusa.
  - No BFF, `amr` fora da lista é desvio de configuração: 503 e `auth_token_fora_da_politica`.
  - O formato exato do `amr` fica a confirmar no P9.
- **Pré-checagem de chaves** (`AccessTokenVerifier.keysReady(): Promise<boolean>`, nova operação da porta, que nunca rejeita):
  - roda antes de chamar o GoTrue, na troca e na renovação;
  - sem chaves prontas, a resposta é 503 `SERVICO_INDISPONIVEL` sem tocar no GoTrue. Assim o refresh não é consumido, e a sessão sobrevive à queda do JWKS;
  - a forma de implementar sobre o `createRemoteJWKSet` do `jose` 6.2.12 fica a verificar no F1-API-07 (P15).
- **Emenda do 07d (F1-API-07, 2026-11-07, `7e6c5d5`), decisões de implementação do verificador:**
  - **P15 respondido (sim):** o `RemoteJWKSet` do `jose` 6.2.12 expõe `fresh`, `reload()` e `jwks()`. O `keysReady()` confere a chave ES256 (`hasSigningKey`) no cache fresco e, com o cache vencido, chama `reload()` antes; qualquer falha é `false`. Usa o mesmo cache e o mesmo cooldown do `verify`, sem caminho de rede próprio. Cache vencido com o JWKS fora do ar dá `false` mesmo com a chave antiga na memória (ADR-013 D5). Quem decide a nova busca é a validade do cache (10 min), não o cooldown (30 s): um teste prende isso;
  - **formato do `amr`:** o do GoTrue, lista de `{ method, timestamp }` (campos extras, como `provider`, passam e não saem do adapter). A lista precisa ser não vazia e **todo** método precisa estar em `AUTH_ALLOWED_AMR`, então `[oauth, password]` é recusado. A forma do RFC 8176 (lista de strings) fica recusada até o P9; se o token real vier assim, o ajuste passa por HITL;
  - a recusa do `amr` é `token_invalido` (401 nas rotas protegidas), sem motivo novo na porta (sem oráculo, ADR-013 D1). O 503 `auth_token_fora_da_politica` do BFF fica com o mapa do 07f, que trata qualquer falha da verificação depois do GoTrue como desvio de política;
  - **`AUTH_ALLOWED_AMR`** (`infrastructure/auth/allowed-amr-env.ts`): vazia ou ausente vale `oauth`; conjunto fechado `{oauth, password}`, separado por vírgula, sem espaço, sem caixa diferente e sem duplicata; `password` só com `NODE_ENV` exatamente `test`. Fora disso, `AllowedAmrConfigError`, sem ecoar o valor. A lista é parâmetro obrigatório do adapter, sem padrão escondido nele;
  - a leitura entrou no `composeApp` já no 07d, porque o verificador é montado ali e vale para `/v1/analyze` e `/v1/criteria`. O 07g fica com o anel, as idades e o `API_BEHIND_PROXY`;
  - **residual:** com o cache vencido e o JWKS fora do ar, cada `keysReady()` refaz a busca (o `jose` não tem cooldown de falha), como o `verify` já fazia. Nas rotas públicas, o limitador local do 07e limita isso.
- **Emenda do 07f (F1-API-07, 2026-11-07, `e1af5d0`):** o resultado `ok` do `verify` ganhou `lifetime: { issuedAt, expiresAt }`, o `iat` e o `exp` que o `jose` já conferiu, fora do `Principal`. O BFF confere `exp − iat` e desconta a idade sem reabrir o JWT. Nenhuma outra claim sai do adapter, e a presentation não lê o campo (emenda datada no ADR-013 D1).
- **Sem repasse sem verificação.** Se a verificação falhar **depois** de o GoTrue rotacionar (caso raro: `kid` novo e JWKS fora no mesmo instante), a API responde 503 e registra `auth_renovacao_perdida`. É falha fechada (residual, §3).
- Token fora da política (assinatura, `typ`, idade, anônimo, `expires_in`, `amr`) dá 503 e `auth_token_fora_da_politica`, nunca 401. Um desvio de configuração não pode virar laço de relogin (T30; ADR-013 D5).

### D7. Contratos e mapa de erros
Os contratos nascem primeiro em `packages/contracts/src/auth.ts`, subpath `@trampo/contracts/auth` (AGENTS §1.4).

```ts
export const AUTH_SCHEMA_VERSION = 1 as const;
export const AUTH_BODY_MAX_BYTES = 2_048;
export const AUTH_ROUTES = { exchange: "/v1/auth/exchange", refresh: "/v1/auth/refresh", logout: "/v1/auth/logout" } as const;
// ACCESS_TOKEN_MAX_CHARS = 8_192 sobe para limits.ts (fonte única). Hoje em 3 lugares: presentation/edge/auth.ts L20,
// application/criteria/criteria-guard.ts L23 (accessTokenMaxChars) e infrastructure/supabase/postgrest-user-client.ts L25
export const AccessTokenSchema = z.string().max(ACCESS_TOKEN_MAX_CHARS).regex(/^[\w-]+\.[\w-]+\.[\w-]+$/);
export const PkceVerifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
export const AuthCodeSchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9-]+$/); // fica largo (HITL-035, 2026-11-06: code_e_uuid não relatado); o z.uuid() espera essa anotação (HITL-036 item 3 ou spike S-3), junto com os canários CANARIO-CODE-* do §4.4
export const SealedRefreshSchema = z.string().max(1_100)
  .regex(/^r1\.[a-z0-9]{1,16}\.[\w-]{16}\.[\w-]{20,1024}\.[\w-]{22}$/);
export const AuthExchangeRequestSchema = z.strictObject({
  schemaVersion: z.literal(AUTH_SCHEMA_VERSION), authCode: AuthCodeSchema, codeVerifier: PkceVerifierSchema,
});
export const AuthRefreshRequestSchema = z.strictObject({
  schemaVersion: z.literal(AUTH_SCHEMA_VERSION), refreshToken: SealedRefreshSchema,
});
export const AuthLogoutRequestSchema = z.strictObject({ schemaVersion: z.literal(AUTH_SCHEMA_VERSION) });
export const AuthSessionResponseSchema = z.strictObject({
  schemaVersion: z.literal(AUTH_SCHEMA_VERSION),
  accessToken: AccessTokenSchema,
  refreshToken: SealedRefreshSchema,
  expiresIn: z.int().min(1).max(900), // impõe o HITL-004 também no contrato
});
```

- **Nenhum código de erro novo.** O `ApiErrorCodeSchema` não muda. O contrato público fica estável e não nasce oráculo.
- **Emenda do HITL-035 (2026-11-06), F1-AUTH-00 (`47abd8c`):** forma sem mudança. O contrato público segue `{ schemaVersion: 1, authCode, codeVerifier }`; o nome do GoTrue (`auth_code`) fica no D4 passo 4, e o `state` não entra no contrato (é só do SW). O `AuthCodeSchema` fica largo, sem `z.uuid()`, porque o `code_e_uuid` não foi relatado (P7). Desvios deliberados do snippet acima: aspas simples e `AUTH_ROUTES` com `Object.freeze` (mais estrito). Acréscimo: os tipos `z.infer` `AuthExchangeRequest`, `AuthRefreshRequest`, `AuthLogoutRequest` e `AuthSessionResponse`. Nota da revisão: no zod 4.6.7, o `.max()` não interrompe os checks seguintes (o regex roda também na string longa), então ele não é pré-filtro de custo; quem corta antes é o `bodyLimit` de 2.048 e, no Bearer, o teste de tamanho do `bearerToken`. Se a F1-API-07 mexer no regex do Bearer, não pode usar `i` com `u`: com `u`, o `\w` sem diferenciar caixa passa a aceitar `ſ` (U+017F) e `K` (U+212A); o contrato já prova isso nos 3 schemas.

| Situação | HTTP | `code` |
|---|---|---|
| `Origin` ausente numa rota pública de auth; origem fora da lista; origem web em `/v1/auth/*` | 403 | `PROIBIDO` |
| Corpo acima de 2.048 B (sem parse) | 413 | `PAYLOAD_GRANDE_DEMAIS` |
| Tipo de mídia ou `Content-Encoding` errado | 415 | `PAYLOAD_INVALIDO` |
| Zod falha (chave extra, formato, versão) | 400 | `PAYLOAD_INVALIDO` |
| Limitador local excedido | 429 + `Retry-After` | `LIMITE_DE_TAXA` |
| Envelope adulterado, `kid` desconhecido, AAD de outra origem | 401 | `NAO_AUTENTICADO` (**sem chamar o GoTrue**) |
| Idade máxima ou inatividade vencidas | 401 | `NAO_AUTENTICADO` (**sem rede**) |
| `sid` divergente | 401 | `NAO_AUTENTICADO` (depois do refresh; o refresh novo é descartado) |
| GoTrue 400, 401, 403, 404 ou 422 (código inválido, verifier errado, reuso, sessão revogada), **sempre** com o corpo JSON do GoTrue e `error_code` string (emendas do HITL-035 e da F1-API-08, abaixo) | 401 | `NAO_AUTENTICADO` (um único motivo) |
| GoTrue não recebeu: 429, 5xx, conexão recusada, redirecionamento; 400, 401, 403, 404 ou 422 sem o corpo do GoTrue (o `Invalid API key` do gateway, HTML de WAF ou de proxy; F1-API-08); *bulkhead* cheio ou orçamento esgotado | 503 + `retryAfterSeconds` | `SERVICO_INDISPONIVEL` |
| GoTrue pode ter rotacionado: prazo depois do envio, JSON inválido, acima do teto | 503 depois de **uma** nova tentativa com o mesmo `rt` (só na renovação) | `SERVICO_INDISPONIVEL` |
| Chaves do JWKS indisponíveis (pré-checagem) | 503 | `SERVICO_INDISPONIVEL` (refresh não consumido) |
| Token do GoTrue fora da política (inclusive `expires_in` ou `exp − iat` acima de 900, `amr`) | 503 | `SERVICO_INDISPONIVEL` + `auth_token_fora_da_politica` |
| Logout: GoTrue 2xx, ou 403 com `error_code` exato `session_not_found` (emenda do 07h). **O 401 nunca** (emenda da F1-API-08): ele cai nas linhas de cima e dá 503 | 204 | idempotente |

- **Emenda do HITL-035 (2026-11-06), linha do 404:** no pré-spike, o reuso do código deu 404 `flow_state_not_found` (caso A); sem verifier, verifier errado e código vencido (B, C e D) só deram "≠ 200". Regra para a F1-API-07: o 404 só conta como recusa (401) quando vem com o corpo JSON do GoTrue e um `error_code` string. Um 404 sem esse corpo (HTML, vazio, rota ou proxy errado) conta como "não recebeu" e dá 503 `SERVICO_INDISPONIVEL` com `auth_provedor_indisponivel`, para um desvio de configuração não virar laço de relogin (T30). O `error_code` nunca sai da API nem vai a log. Nenhum código novo.

**Emenda da F1-API-08 (2026-11-11): recusa só com o corpo do GoTrue, nos 5 status e nas 3 chamadas** (achados A-01 e A-02 da [revisao-adversarial-auth](../revisao-adversarial-auth.md); `[ARCHITECT]` + `[APPSEC]`, sem veto).
- **Regra:** 400, 401, 403, 404 e 422 só são recusa (401 `NAO_AUTENTICADO`, que faz o SW apagar a sessão) quando chegam com `content-type` JSON, corpo de até 32 KiB em UTF-8 estrito, sem chave de protótipo, e um `error_code` string. Sem esse corpo, o GoTrue não recebeu: 503 `SERVICO_INDISPONIVEL` com `auth_provedor_indisponivel`, sem nova tentativa e sem apagar a sessão (D11.3). É a regra do 404 do HITL-035, estendida pelo mesmo motivo: a *publishable* revogada ou um WAF na frente do Supabase não podem virar recusa para todos os usuários nem laço de relogin (T30).
- **Logout:** só o 2xx e o 403 `session_not_found` dão 204. O 401 nunca: o único 401 do GoTrue no logout é o `no_authorization` (o Bearer não chegou), e o 401 sem o corpo do GoTrue vem do gateway (`Invalid API key`). Nos dois casos, a sessão pode seguir viva, e o 204 seria mentira (o aviso do D11.5 não apareceria).
- **Conferência antes do código, pelo código-fonte das versões do CI:** a estação não sobe a pilha local (o *daemon* do Docker parado e pouca memória livre), e o job `db` só roda no PR. A CLI 2.120.0 fixa o GoTrue v2.197.0 e o Kong 2.8.1. No GoTrue, sem o cabeçalho `X-Supabase-Api-Version` (o adapter não o manda), todo `HTTPError` sai como `{ code, error_code, msg }`, com `error_code` sempre preenchido (`unknown` na falta; `handleResponseErrorHTTP`). Isso cobre todas as recusas que o adapter alcança:
  - troca: 400 `validation_failed` e `bad_code_verifier`, 404 `flow_state_not_found` e 422 `flow_state_expired`;
  - renovação: 400 `refresh_token_not_found`, `refresh_token_already_used`, `session_not_found` e `session_expired`;
  - logout: 401 `no_authorization` e 403 `bad_jwt`, `user_not_found` e `session_not_found`;
  - as exceções não são alcançáveis: o `OAuthError` (`{ error, error_description }`) só sai com o `refresh_token` vazio (o adapter nunca o manda) e para clientes do servidor OAuth; o corpo de erro do Postgres, só com gatilho que levanta exceção.
- **Prova no job `db` (roda no PR):** o `auth-contract.db.test.ts` confere o corpo de cada recusa real acima (o verifier errado e o fluxo vencido por um fluxo gravado em `auth.flow_state` como `postgres`) e o `recusado` do adapter (§4.3, "Emenda da F1-API-08"). **Limite do job:** o Kong local da CLI não confere a `apikey` na rota `/auth/v1/` (só um `request-transformer`, que deixa passar o Bearer do usuário). A *publishable* errada chega ao GoTrue, e o A-01 e o A-02 não se reproduzem ali. O 401 `Invalid API key` do gateway real fica provado no simulado (`gotrue-token-client.test.ts` e `auth-session-stack.test.ts`) e entra no S-3 (P21).
- **Para a F1-DB-02 (Custom Access Token Hook):** a recusa do hook sai pelo objeto `error` com `http_code` 403, que o GoTrue serializa com `error_code` `unknown` (vira 401). Nunca por `raise exception`: o corpo de erro do Postgres não tem `error_code`, e a renovação daria 503 sem fim. O `test:db` da F1-DB-02 prova o `recusado` do adapter.
  - **Feito na F1-DB-02 (2026-11-12, `cf5fe64`; [ADR-026-custom-access-token-hook](ADR-026-custom-access-token-hook.md) D3):** conferido no código do GoTrue v2.197.0 (`hookserrors`, `handleResponseErrorHTTP` e `utilities/postgres.go`). O 403 do hook sai como `{ code: 403, error_code: "unknown", msg }`, que o adapter lê como `recusado`; o `raise exception` sai como 500 `{ code: "P0001", message }` e o `raise … using errcode = 'PT403'` como 403 com o mesmo corpo, os dois **sem `error_code`**: `nao_recebido`, 503. O `auth-hook.db.test.ts` prova os três pela chamada crua, pelo adapter e pela borda do BFF (401 na recusa, 503 no defeito). O evento fora da forma devolve `http_code` 500 (`unexpected_failure`), que também dá 503.
- **Residual aceito:** um proxy ou WAF que responda JSON com um `error_code` string seria lido como recusa. É o comportamento de antes desta emenda, só nesse caso estreito, e o nome da chave é do GoTrue.
- **Extensão:** nada muda. Ela já trata o 503 da renovação como "mantém a sessão" (D11.3) e o 503 do logout como falha, com o aviso do D11.5.

### D8. Proteção das rotas públicas
1. **Lista exata.** `PUBLIC_ROUTES = { "GET /health", "POST /v1/auth/exchange", "POST /v1/auth/refresh" }`, comparada pelo padrão registrado (`auth.ts` L38-39). As rotas públicas de auth **nunca leem** `Authorization`. O logout continua protegido.
2. **CORS.**
   - A origem da extensão alcança `EXTENSION_ROUTES = [POST /v1/analyze, POST /v1/auth/exchange, POST /v1/auth/refresh, POST /v1/auth/logout]`, pelo caminho cru, como hoje.
   - Novo `EXTENSION_ONLY_ROUTES` com as 3 de auth: origem web leva 403. O portal terá login próprio no servidor (F1-PORTAL-01) e não usa este BFF.
   - **`Origin` obrigatório** nas duas rotas públicas. É exceção ao "sem `Origin` segue" do ADR-007 D6 (`cors.ts` L63-64), porque ali não há JWT protegendo. É higiene, não controle.
3. **Os controles de verdade.** Na troca, o PKCE S256: o código é inútil sem o verifier. Na renovação, o AEAD: um blob que a API não emitiu morre no `open`, com custo local e **zero** chamadas ao GoTrue. O AEAD barra o forjado, **não o *replay* de envelope genuíno**. Este fica limitado pela inatividade, pela idade máxima (D5) e pelo orçamento de saída (item 5).
4. **Limitador local de entrada, pré-JWT** (emenda ao ADR-014, novo D10):
   - janela deslizante **em memória do processo**, com chave `HMAC-SHA256(RATE_KEY_PEPPER, balde de IP)`; IPv6 pelo /64, como o ADR-014 D4;
   - `auth_troca` 10/min e `auth_renovacao` 30/min por balde;
   - mapa limitado a 10.000 baldes. Cheio, os novos dividem um balde de transbordo. Falha para o lado restritivo, e nada é despejado (despejo deixaria contornar o limite inundando a tabela);
   - **só vale com `TRUST_PROXY` correto.** Sem ele, todo mundo cai no balde do proxy, e o limite vira global (§1.2). Nova variável `API_BEHIND_PROXY=true|false`, obrigatória em produção: com `true` e `TRUST_PROXY` vazio, o boot falha fechado. O runbook lista as faixas da Cloudflare (S-5);
   - **nenhum comando Redis antes do JWT**. A decisão do humano de 2026-10-21 continua de pé. A Cloudflare do S-5 segue sendo o escudo contra inundação.
5. **Orçamento de saída e *bulkhead*.** O Supabase Auth vê **um único IP**, o da API (T43).
   - Orçamento de chamadas de **saída** ao GoTrue (*token bucket* por instância), particionado. A partição `renovacao` tem reserva mínima de 50% e só é consumida depois de um `open` bem-sucedido. A partição `troca` fica com o resto e só é consumida depois do Zod.
   - Envelope inválido e Zod inválido nunca consomem orçamento de saída.
   - Os números ficam para depois do P19, abaixo de 50% do limite real por IP (o local é `token_refresh` 150 a cada 5 min, `supabase/config.toml` L210). Métrica `auth_orcamento_gotrue{particao,resultado}`.
   - **Emenda do HITL-035 (2026-11-06), números do P19:** no projeto real, Token Refresh = 150 requisições a cada 5 min por IP e Sign-up/sign-in = 30, iguais aos locais. Pelo pior caso (o `grant_type=pkce` contando no balde de sign-in **e** no de token):
     - partição `troca`: até **14** chamadas por 300 s (< 50% de 30);
     - total no `/auth/v1/token` (troca + renovação, contando a nova tentativa do D4 passo 6): até **74** por 300 s (< 50% de 150);
     - partição `renovacao`: o resto (cerca de 60), acima da reserva mínima de 50%;
     - janela deslizante de 300 s, ou *token bucket* com capacidade + reposição em 300 s ≤ teto, para não estourar na virada;
     - os tetos são por IP de saída: com N instâncias, ou com o servidor do portal no mesmo IP, eles se dividem;
     - o adapter nunca repassa `X-Forwarded-For` nem `X-Real-IP` do cliente ao GoTrue;
     - os números finais, e o balde do `pkce` e do `/logout` (conferidos no GoTrue local do job `db`, que tem os mesmos limites), ficam com a F1-API-07, fixados por teste contra este ADR;
     - com o limitador local de hoje (10/min de entrada na troca), um IP sozinho esvazia a partição `troca` (residual "sem Cloudflare até o S-5", §3).
   - *Bulkhead*: no máximo 4 chamadas simultâneas ao GoTrue por instância. O excesso leva 503 com `retryAfterSeconds: 5`.
     - **Emenda da F1-API-08 (2026-11-11, achado A-03):** a troca ocupa no máximo 3 das 4 vagas (`trocaMaxConcurrent`). Ela é a única chamada que um anônimo leva ao GoTrue (basta um código de formato válido); a renovação só chega lá com um envelope que abre, e o logout, com um Bearer verificado. As duas usam as 4 vagas, e a última fica para elas. O boot recusa `trocaMaxConcurrent` que não seja inteiro positivo ou que não deixe vaga sobrando. Reservar a vaga só para a renovação deixaria o logout sem ela; aceitar o A-03 no §3 deixaria quem já está logado à mercê de trocas lentas.
   - **Emenda do 07e (F1-API-07, 2026-11-07, `ac3c2c7`), decisões de implementação dos itens 4 e 5** (texto completo no ADR-014 D10):
     - o limitador local é um hook no `onRequest` **da própria rota** (07g), depois dos globais: nas rotas públicas, o JWT e o rate limit passam sem efeito, e a ordem efetiva continua a do D4;
     - a janela do limitador é a deslizante aproximada do ADR-014 D4 (a negada conta); a do orçamento é exata, por registro das chamadas, porque os tetos do P19 não admitem estouro na virada;
     - o transbordo é um balde por classe. Só o balde vencido (peso zero) sai da tabela, o que não abre contorno; balde vivo nunca é despejado;
     - reserva da renovação: a troca passa se `T < 14` e `T + max(R, 37) < 74`. Com a troca em 14, a reserva não morde; o teste prova que ela vale por si;
     - o *bulkhead* decide antes do orçamento, e nenhuma negação consome vaga. O logout passa só pelo *bulkhead* até o 07h conferir o balde dele;
     - `API_BEHIND_PROXY`: obrigatória fora de `NODE_ENV=test` exato, e `false` com `TRUST_PROXY` configurado também derruba o boot (contradição).
   - **Emenda do 07h (F1-API-07, 2026-11-07, `4efd96c`), o balde do `pkce` e do `/logout`:**
     - **pelo código-fonte do GoTrue** (`supabase/auth`, `master` lido em 2026-11-07; hipótese até a sonda do job `db` confirmar): o `/token` escolhe o limitador dentro do handler (`token.go`), e `password`, `refresh_token`, `id_token` e **`pkce` dividem um balde só, o `Token`** (`token_refresh`). O `sign_in_sign_ups` (`GOTRUE_RATE_LIMIT_OTP` na CLI) limita o `/signup`, **não** o `/token`. O pior caso do HITL-035 (o `pkce` contando nos dois baldes) era conservador, e a partição `troca` de 14 continua valendo;
     - **o `/logout` não passa por limitador nenhum** (`r.With(api.requireAuthentication).Post("/logout", ...)`). Fica como está: só o *bulkhead*, sem partição no orçamento;
     - **achado: o balde `Token` tem rajada fixa de 30** (`tollbooth ... SetBurst(30)`, reposição de 150/300 = 0,5 por segundo). Os 150 por 5 min são a média, não o teto de uma rajada: 31 chamadas seguidas já levam 429. O orçamento do 07e (registro exato de 300 s, total de 74 no `/token`) deixa passar até 74 numa rajada, acima dos 30 e muito acima dos 50% (15). O 429 do GoTrue vira `nao_recebido` e 503 (D7), sem risco de vazamento, mas o IP da API fica bloqueado no GoTrue até a reposição. **Pendente (07j, sem bloquear a F1-EXT-05a):** teto de rajada no `GotrueEgress`, com capacidade de 15 e reposição de 0,25 por segundo, somado às janelas de hoje;
     - **Emenda do 07j (F1-API-07, 2026-11-11, `c6f0c3b`):** entregue. As chamadas ao `/token` (troca e renovação) passam por um balde de 15 fichas com 1 ficha a cada 4 s (`burstCapacity` e `burstRefillIntervalMs`), em milissegundos inteiros, **somado** às janelas de 300 s: a chamada precisa passar nos dois, a negada por um não gasta o outro, e o `Retry-After` do 503 é o maior dos dois. São 50% da rajada (30) e 50% da reposição (0,5 por segundo) do balde `Token`, então o balde do GoTrue nunca desce de 15 por causa da API. O logout não gasta ficha (o `/logout` não tem limitador). **Sem reserva de fichas para a renovação:** as trocas são no máximo 14 por 300 s e nunca esvaziam o balde; depois de uma rajada de 14 trocas, a renovação fica a 1 a cada 4 s por até 56 s, com 503 e `Retry-After`, e a sessão não cai (D11.3). Residual do T43 até o S-5. Provado por propriedade (`fast-check`): nenhuma rajada passa de 15, nenhum intervalo passa de 15 mais 1 a cada 4 s, e nenhuma janela de 300 s passa de 74 nem de 14 trocas;
     - **o limitador só roda com um IP para chavear** (`performRateLimiting`: `Sb-Forwarded-For` com a flag ligada, ou `GOTRUE_RATE_LIMIT_HEADER`). Sem os dois, nenhum limite por IP vale. A CLI (pacote `stack` do branch `develop`) não define nenhum dos dois, então o GoTrue local provavelmente **não aplica** o limite: a premissa "o local tem os mesmos limites" vale para os números do `config.toml`, não para a aplicação deles;
     - **sonda no job `db`** (`test/db/auth-rate-limit.db.test.ts`, grupo próprio depois do contrato): 45 renovações seguidas descobrem o modo. Inativo: 45 trocas e 45 logouts sem 429, todas recusas do GoTrue. Ativo: balde cheio de novo (62 s), rajada do `pkce` igual à do balde `Token` (30 mais a reposição), renovação logo depois com 429 (mesmo balde), signup sem 429 (fora do `sign_in_sign_ups`), e 45 logouts sem 429. Em modo inativo, o balde do projeto real fica pelo código-fonte e pelo P19, e a condição 3 do `[APPSEC]` (§6.3) fica cumprida pela metade: a sonda prova o modo, não o balde.
     - **Medido no job `db` (runs `42397764768` e `42398183789`, 2026-11-07): limitador inativo** no GoTrue local. 45 renovações, 45 trocas e 45 logouts seguidos, sem nenhum 429, todos recusados pelo próprio GoTrue. Os números do D8 item 5 seguem pelo pior caso do HITL-035 para a troca (14) e pelo código-fonte para o resto (o `pkce` no balde `Token` e o `/logout` sem limitador). A prova no projeto real fica para o spike S-3 (P19), sem HITL novo agora. O 07j (teto de rajada) não depende dela: segue a regra dos 50%, aplicada à rajada de 30 do código.
6. **Formato antes da rede:** Zod e `open` antes de qualquer chamada ao GoTrue (D4).
7. **Logs e métricas** (ADR-010, mensagens de catálogo **sem campos**):
   - mensagens: `auth_troca_recusada`, `auth_renovacao_recusada`, `auth_envelope_invalido`, `auth_sessao_idade_maxima`, `auth_sessao_inativa`, `auth_provedor_indisponivel`, `auth_chaves_indisponiveis`, `auth_token_fora_da_politica`, `auth_renovacao_perdida`, `auth_limite_local`;
   - as linhas de recusa são **amostradas**: no máximo 1 linha por motivo a cada 60 s, por instância, com o contador de suprimidas. O volume fica nas métricas (contra o *Denial of Wallet* em log);
   - métricas: `auth_troca_total{resultado}`, `auth_renovacao_total{resultado}` e `auth_logout_total{resultado}`, com `resultado` em `{ok, recusado, indisponivel, limitado}`;
   - código, verifier, `state`, tokens, envelope, `provider_token`, `sub`, e-mail e IP nunca aparecem (SR-12).
   - **Emenda do 07g (F1-API-07, 2026-11-07, `b516fd0`), itens 1, 2, 4 e 7:**
     - **item 1:** `PUBLIC_ROUTES` = `GET /health`, `POST /v1/auth/exchange` e `POST /v1/auth/refresh`, pelo padrão registrado. O hook do JWT sai antes de olhar o `Authorization` nas públicas. Troca e renovação com Bearer canário ou malformado respondem igual a sem o header, com 0 chamadas ao verificador e ao rate limit;
     - **item 2:** `EXTENSION_ROUTES` ganhou as 3 rotas. `EXTENSION_ONLY_ROUTES` (as 3) dá 403 à origem de web, no *preflight* e na requisição real. `ORIGIN_REQUIRED_ROUTES` (as 2 públicas) dá 403 sem `Origin`. As duas listas novas valem pelo caminho cru **e** pelo padrão casado: o roteador decodifica `%61uth` e chegaria à rota com um caminho cru fora da lista. `/v1/auth/exchange/`, `GET` e `PUT` ficam fora (401 sem `Origin` ou vindo de web; 403 vindo da extensão);
     - **item 4:** o hook do 07e entra no `onRequest` da troca (`auth_troca`) e da renovação (`auth_renovacao`), com a linha amostrada `auth_limite_local`; o logout não passa por ele. O `API_BEHIND_PROXY` é lido no boot contra o `TRUST_PROXY` já validado. Com 0 comandos no Redis simulado antes do JWT nas rotas reais (códigos falsos, envelopes forjados e o 429);
     - **item 7:** `presentation/logging/auth-log-sampler.ts` amostra por motivo: 1 linha a cada 60 s por instância, e a seguinte leva `suprimidas`. A linha é `warn`, só com a mensagem do catálogo e o contador (emenda ao ADR-010 D1 e D2). Na renovação, o 503 `auth_token_fora_da_politica` registra também `auth_renovacao_perdida`;
     - **pendente (07i):** as métricas `auth_troca_total`, `auth_renovacao_total` e `auth_logout_total` não entraram. A porta `Telemetry` (ADR-010 D5) só tem eventos de extração e de análise, e o exportador é do S-5. Por enquanto, o volume fica no contador `suprimidas`. O 07i não bloqueia a F1-EXT-05a.
     - **Emenda do 07i (F1-API-07, 2026-11-11, `53ba9c1`):** entregue. `auth_troca_total{resultado}`, `auth_renovacao_total{resultado}` e `auth_logout_total{resultado}` contam uma vez por requisição que chega ao handler ou é barrada pelo limitador local, pelo mapa do D7: `sessao` e `encerrada` são `ok`; `nao_autenticado`, `entrada_invalida` (a segunda trava do Zod) e a quebra de invariante são `recusado`; `indisponivel` é `indisponivel` (inclui a negação do orçamento e do *bulkhead*); o 429 do limitador local é `limitado`. O que a borda recusa antes (CORS, tipo de mídia, tamanho, Zod, JWT e o rate limit do Redis no logout) não conta. O evento só tem a operação e o resultado ([ADR-010-log-allowlist-and-telemetry](ADR-010-log-allowlist-and-telemetry.md) D5). A `auth_orcamento_gotrue{particao,resultado}` do item 5 segue pendente, sem tarefa aberta.

### D9. Onde cada segredo vive

| Segredo | Nasce em | Vive em | Quem vê | Nunca |
|---|---|---|---|---|
| `code_verifier` (32 bytes, 43 caracteres) | SW (`crypto.getRandomValues`) | **só memória do SW** (módulo `auth-service`); apagado no envio da troca ou em 5 min. Na contingência do D11.8, também `trampo/login-pendente/v1` | SW e API (corpo, TLS) | `local`/`sync`, painel, log |
| `state` (16 bytes, 22 caracteres) | SW | memória do SW (e o login pendente, na contingência) | SW; o Supabase só ecoa, sempre conferido (emenda do HITL-035, 2026-11-06: saiu o "se o P5 passar") | `local`/`sync`, painel, log |
| authorization code | GoTrue | URL de retorno → SW → API | SW, API | storage, painel, log |
| access token (JWS ES256, até 8.192, 900 s) | GoTrue | `storage.session`, chave `trampo/sessao/v1`, lido e gravado só por `src/auth/**` | SW, API, PostgREST | painel, extrator, content script, `local`/`sync`, log |
| refresh token cru do Supabase | GoTrue | **só dentro do envelope**; na API, só em memória durante a requisição | API | extensão, log |
| envelope `r1.…` | API | `storage.session` (`trampo/sessao/v1`) | SW, API | painel, extrator, log |
| `provider_token`, `provider_refresh_token`, `user` (e-mail, metadados) | GoTrue (resposta da troca) | **descartados na API** (projeção de 3 campos) | ninguém | extensão, log |
| `AUTH_REFRESH_SEAL_KEYS` | humano (HITL-035 parte 1) | `.env` da API e gerenciador de segredos | API | cofre, git, extensão |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase | `.env` da API (já existe) | API → GoTrue (`apikey`) | extensão |
| `SUPABASE_SECRET_KEY` | Supabase | `.env` da API, só no `DeleteAccount` (ADR-018 D5) | nenhum fluxo deste ADR | qualquer rota de auth |
| chave privada da extensão (`.pem`) | humano (HITL-035 parte 1) | gerenciador de senhas, fora do git e do cofre | ninguém no MVP | repositório, cofre |
| chave pública da extensão | humano (HITL-035 parte 1) | variável de build `TRAMPO_EXTENSION_KEY` (não é segredo) | manifesto | build de loja |

Estado guardado, privado da extensão:

```ts
// apps/extension/src/auth/session-schema.ts
export const SESSION_STORAGE_KEY = "trampo/sessao/v1";
export const StoredSessionSchema = z.strictObject({
  v: z.literal(1),
  accessToken: AccessTokenSchema,        // @trampo/contracts/auth
  refreshToken: SealedRefreshSchema,     // o envelope, nunca o rt cru
  accessExpiresAt: z.int().positive(),   // epoch ms local = recebidoEm + expiresIn * 1000
  obtainedAt: z.int().positive(),
});
```

- **O cliente trata o token como opaco.** O SW nunca decodifica o JWT, e nenhuma claim entra na extensão. É minimização, e tira a dependência do relógio local em relação ao `exp`.
- O `sessionStore` revalida na leitura e apaga valor adulterado (`session-store.ts`).
  - **Emenda do 05a-2 (F1-EXT-05a, 2026-11-07):** o `session-schema.ts` exporta o `authSessionStore(area?)`, que é o `sessionStore` da chave `trampo/sessao/v1` com este schema. Endurecimento: um `refine` exige `accessExpiresAt − obtainedAt` entre 1.000 e 900.000 ms (o `expiresIn` de 1 a 900 s do contrato). Um valor que prometa mais de 900 s de vida, ou vencimento antes da obtenção, é tratado como adulterado e apagado. Com o `refine`, o `.positive()` do `accessExpiresAt` virou redundante (mutante equivalente na 1ª rodada) e saiu: o `obtainedAt` positivo e a diferença mínima de 1.000 ms já o garantem.
- **Login pendente, só na contingência do D11.8 e na C2:** `trampo/login-pendente/v1` com `z.strictObject({ v: z.literal(1), verifier: PkceVerifierSchema, state, deadline, tabId: z.int().nullable() })`. Entrada única, apagada no uso, no erro e no prazo de 5 min. O painel conseguiria ler esse verifier, sem ganho para quem já lê o token. Ele nunca vai a log.

### D10. Isolamento: token só no SW, nunca no painel nem no extrator
**Fato que pesa:** o painel é página da extensão e **consegue ler `storage.session`** (§1.1; [J:extensao]). O navegador não impõe a regra "só o SW". A barreira tem de ser de código, de build e de rede, com prova automática.

- **B1. Lint no painel** (`src/entrypoints/sidepanel/**` e `src/panel/**`):
  - `no-restricted-properties` para `browser.storage`, `chrome.storage`, `storage.onChanged`, `browser.identity` e `chrome.identity`;
  - `no-restricted-globals` para `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `indexedDB` e `caches`;
  - `no-restricted-imports` para `**/auth/**`, `**/api/**` e `**/messaging/session-store`;
  - `window.open`, atribuição a `location` (`location.href`, `location.assign`), `browser.tabs`, `chrome.tabs`, `runtime.setUninstallURL`, `RTCPeerConnection` e `HTMLFormElement.submit`.
  - **Emenda do 05b-1 (F1-EXT-05b, 2026-11-08):** o B1 é um bloco próprio do `eslint.config.js` (`@trampo/extension/panel`, `.ts` e `.tsx` de `src/entrypoints/sidepanel/**` e `src/panel/**`). Ele repete as listas do B2 e soma as do painel, porque as regras `no-restricted-*` não se acumulam entre blocos.
    - **armazenamento:** `storage` como propriedade de qualquer objeto, o que pega `browser.storage`, `chrome.storage`, o acesso computado, a desestruturação e, com eles, o `storage.onChanged`. `indexedDB`, `caches`, `localStorage` e `sessionStorage` saem como global e como propriedade;
    - **navegação e canais que a CSP não barra:** `location`, `open` (solto e em `window`, `self`, `globalThis` e `document`), `tabs`, `runtime.setUninstallURL`, `submit`, `requestSubmit`, `RTCPeerConnection` e `webkitRTCPeerConnection`;
    - **módulos do SW:** import relativo com um segmento `auth` ou `api`, ou do `messaging/session-store` (com ou sem extensão), estático, de tipo ou reexportado; o `import()` dinâmico sai por seletor, para não escapar da regra de imports. O subpath `@trampo/contracts/api` segue liberado, porque não é o `src/api`. O `browser.identity` já vinha do B2;
    - fixtures negativas em `test/worker-modules-lint.test.ts`: 36 formas em 3 caminhos do painel (os dois diretórios e um subdiretório), com a prova de que o bloco não apaga as regras anteriores, de que fora do painel nada muda e de que os testes ficam fora.
- **B2. Lint por módulo, em toda a extensão** (cada regra com fixture negativa):
  - `fetch` só em `src/api/api-client.ts`;
  - `browser.identity` só em `src/auth/web-auth-flow-source.ts`;
  - `tabs.create` só no `background.ts`; `executeScript` só em `src/capture/capture.ts`;
  - `storage.onChanged` só em `src/auth/**`;
  - proibidos em todo o `src/**`: `runtime.onMessageExternal`, `runtime.onConnectExternal`, `runtime.sendMessage`, `BroadcastChannel`, `MessageChannel`, `clients`, `navigator.serviceWorker`, `registerContentScripts`, `insertCSS`, `tabs.sendMessage`, `tabs.connect` e a opção `files:` do `executeScript`.
  - **Emenda do 05a-4 (F1-EXT-05a, 2026-11-08):** o B2 está completo no `eslint.config.js`. `browser.identity` (e `chrome.identity`, acesso computado e desestruturação), `storage.onChanged` (inclusive `storage.session.onChanged`) e `executeScript` vão por `no-restricted-properties`, com exceção só no arquivo dono. `tabs.create` e `tabs.connect` vão por seletor, porque a regra de propriedades só casa objeto identificador e o `runtime.connect` (canal do painel) fica liberado. Os canais laterais valem em todo o `src/`, inclusive nos arquivos com exceção, como global e como propriedade (`self.clients`, `self.BroadcastChannel`). As regras `no-restricted-*` não se acumulam entre blocos: cada bloco repete a lista inteira com a sua exceção, e um teste prova que a exceção não apaga as outras regras do arquivo. Fixtures negativas em `test/worker-modules-lint.test.ts`; os testes ficam fora da regra.
- **B3. dependency-cruiser** (`packages/config/dependency-cruiser.cjs`):
  - regra `extension-panel-no-auth`: `^apps/extension/src/(entrypoints/sidepanel|panel)/` não importa `^apps/extension/src/(auth|api|messaging/session-store)`;
  - regra `extension-capture-no-auth`: `src/extraction/**` e `src/capture/**` não importam `src/auth/**` nem `src/api/**`;
  - `src/auth/**` e `src/api/**` só são importados por `src/entrypoints/background.ts` e entre si.
- **B4. Meta CSP no painel**, só no build de produção, em `src/entrypoints/sidepanel/index.html`, antes de qualquer script: `connect-src 'none'; form-action 'none'; base-uri 'none'; require-trusted-types-for 'script'; trusted-types 'none'`.
  - As políticas se somam. O painel perde o egress por `fetch`, XHR, WebSocket, EventSource e `sendBeacon`, **inclusive para a API**, e não envia formulário. O React com render só de texto não precisa de política de Trusted Types.
  - **A CSP não barra** navegação (`location`, `window.open`), `tabs.create`, `identity` nem WebRTC. O lint B1 os proíbe no código-fonte, mas o controle real é não ter XSS.
  - O painel não precisa de rede: ele só usa `runtime.connect`. O `connect-src` do manifesto não muda para o SW.
  - O HMR do dev não recebe a meta (a forma de condicionar no WXT fica a verificar no F1-EXT-05b; P16).
  - **Emenda do 05b-1 (F1-EXT-05b, 2026-11-08), P16 provado:**
    - **forma:** a meta sai do plugin `trampo:panel-csp` do Vite (`apps/extension/panel-csp.ts`, ligado pelo `wxt.config.ts`), pelo `transformIndexHtml` com `injectTo: "head-prepend"`, só quando o `mode` é exatamente `production`. É o `mode` do `wxt build` (loja e E2E); o `wxt` de desenvolvimento roda em `development`. O `index.html` do código-fonte não muda;
    - **prova de unidade:** o `panel-csp.test.ts` fixa a política exata e nenhum tag em `development`, `test`, vazio e variações de caixa e espaço. Ele também monta o plugin pelo próprio `wxt.config.ts`: `development` com `serve` não recebe nada, e `production` com `build` recebe a meta;
    - **prova no artefato:** nos dois builds de produção do `manifest.test.ts`, uma só meta, exata, dentro do `<head>` e antes de qualquer `script`, `link`, `style` ou `base`;
    - **prova no Edge** (`csp.e2e.test.ts`, emenda do §4.5 item 5): o `fetch` do painel para a API dispara `securitypolicyviolation` em `connect-src`, com 0 hits; o `submit` dispara `form-action`, com 0 hits; o `<base>` dispara `base-uri`; `innerHTML` e `trustedTypes.createPolicy` lançam `TypeError`. O painel real renderiza com a meta (React só com texto), e nenhuma diretiva precisou sair.
- **B5. Grep do artefato**, num build com as duas origens e a `key` (o build do E2E):
  - "chunks do painel" é o fecho transitivo de `script`, `modulepreload` e `import` a partir do `sidepanel.html`;
  - nenhum deles contém `storage.session`, `.identity.`, `launchWebAuthFlow`, `getRedirectURL`, `/v1/auth/` nem a origem do Supabase. O código de auth aparece só no `background.js`.
  - **Emenda do 05b-1 (F1-EXT-05b, 2026-11-08):** o `manifest.test.ts` calcula o fecho a partir do `sidepanel.html`: o `src` de cada script, o `href` de cada `modulepreload` e, nos chunks, o `import` estático, o reexport e o `import()`. Uma referência a arquivo fora do artefato derruba o teste. Nos dois builds (o fechado e o completo), o `sidepanel.html` é a única página; o fecho tem o chunk do painel e não tem o `background.js`; os dois juntos cobrem todo `.js` do artefato (um chunk que ninguém carrega pede revisão do teste); e nenhum arquivo do fecho tem os marcadores acima. O leitor do fecho tem teste próprio, com um artefato sintético.
- **B6. Protocolo sem texto livre.** A `SessaoView` (D12) só tem um booleano e um enum fechado. Por tipo, ela não consegue carregar token, claim, e-mail, `sub`, expiração nem `session_id`. Chave extra derruba a porta nos dois sentidos (SR-10).
- **B7. Extrator sem mudança.** `executeScript` com `args: [EXTRACTION_LIMITS, platform]`, travado pela interface `ScriptingApi` (`capture.ts` L130-156). O lint de `src/extraction/**` já proíbe `chrome`, `browser` e `fetch`. Por padrão, content scripts não leem `storage.session`.
- **B8. Manifesto** continua sem `content_scripts` e sem `web_accessible_resources`. Não há página de callback na extensão: o `launchWebAuthFlow` intercepta o chromiumapp.org.
- **B9. `api-client`** (`src/api/api-client.ts`), o único `fetch` da extensão:
  - `credentials: "omit"`, `redirect: "error"`, `cache: "no-store"`, `referrerPolicy: "no-referrer"`, prazo de 10 s e teto de resposta;
  - aceita só URLs com origem igual a `TRAMPO_API_ORIGIN` e caminho de uma lista fechada;
  - anexa o Bearer **só** em `POST /v1/analyze` e `POST /v1/auth/logout`.
  - **Emenda do 05a-2 (F1-EXT-05a, 2026-11-07), decisões de implementação do `api-client`:**
    - `createApiClient({ apiOrigin, fetch? })` lança com origem fora da forma https exata (a mesma checagem do `authorize-url`). A falta de `TRAMPO_API_ORIGIN` é tratada por quem monta o cliente (D3 passo 2, no 05a-4);
    - a lista fechada é um `Map` com os 4 caminhos exatos (`/v1/auth/exchange`, `/v1/auth/refresh`, `/v1/auth/logout` e `/v1/analyze`), cada um com o Bearer, o schema do corpo e o teto de resposta. Na rota com Bearer, o token passa pelo `AccessTokenSchema`; um token oferecido a uma rota pública é recusado sem rede;
    - a chamada é lida uma vez só, e o corpo sai pelo JSON validado: `JSON.stringify`, depois `JSON.parse` e o schema da rota sobre a cópia, e o envio é a mesma string. Um *getter* não troca o caminho nem o corpo entre a checagem e o envio;
    - cabeçalhos de lista fechada: `content-type: application/json` e, só nas 2 rotas, `authorization`. O `Origin` é posto pelo navegador;
    - o prazo de 10 s cobre o pedido e a leitura do corpo. No fim, sempre `clearTimeout` e `abort`, que também derruba o stream acima do teto;
    - teto de 16 KiB nas 3 rotas de auth (o pior caso legítimo fica abaixo de 9,5 KB) e de 64 KiB, provisório, no `/v1/analyze`. O corpo é lido em stream, contado em bytes e decodificado em UTF-8 estrito (`fatal`);
    - nunca rejeita. Devolve `{ ok: true, status, body }` para qualquer status HTTP, ou um destes motivos: `pedido_recusado` (nada saiu), `sem_resposta` (rede, redirecionamento recusado ou prazo antes do status) e `resposta_ilegivel` (o status chegou, mas o corpo passou do teto ou do prazo, ou não é UTF-8). No D11.3, o `sem_resposta` é o caso "sem resposta HTTP" (uma nova tentativa) e o `resposta_ilegivel` conta como resposta HTTP (sem nova tentativa); o mapa é do 05a-3;
    - **lint B2:** o `fetch` como global (`no-restricted-globals`) e como propriedade (`no-restricted-properties`, que pega `globalThis.fetch`, `self["fetch"]` e a desestruturação) só existe em `src/api/api-client.ts`. `XMLHttpRequest`, `WebSocket`, `EventSource` e `sendBeacon` ficam proibidos em todo o `src/`, inclusive no `api-client`. Os testes ficam fora da regra;
    - **ponto aberto para a F1-EXT-04 parte 2:** o prazo de 10 s do B9 não cobre a análise com o fallback do LLM (Groq até 3 s e Workers AI até 10 s, [ADR-009-llm-provider-router](ADR-009-llm-provider-router.md) §5), nem o stream SSE lido aos poucos. O leitor do stream, o prazo e o teto do `/v1/analyze` se decidem lá. Até então, o `api-client` só tem a rota para fixar o Bearer (M-07).
- **B10. Canários em runtime:** §4.5.
- **Resíduo:** qualquer código na origem da extensão lê o token (residual, §3). Mitigações: `script-src 'self'`, Trusted Types, sem `innerHTML` (SR-03), render só de texto (ADR-025) e B4.

- **Emenda da F1-EXT-07 (2026-11-11, `08149f0`; achado E-01 da [revisao-adversarial-auth](../revisao-adversarial-auth.md)):** o lint recusa `setAccessLevel` em qualquer forma de acesso e em todo arquivo `.ts`/`.tsx`: o nome em qualquer profundidade, o acesso computado por string e por template, e a desestruturação, com ou sem outro nome, em declaração, atribuição ou parâmetro. Em `src/`, a regra de propriedades é a segunda barreira. O B5 confere o artefato inteiro, `background.js` incluído. **Residual de lint, coberto pelo E2E (`auth-negative`, item 7):** o nome montado em tempo de execução (`"set" + "AccessLevel"`), que também não aparece no artefato, e o alias de `storage`.

### D11. Ciclo de vida
**11.1 Uso do token (SW)**
- `authService.accessToken()` lê `trampo/sessao/v1`. Se `agora ≥ accessExpiresAt − 60 s`, renova antes de usar.
- O `expiresIn` já vem descontado da idade do token na API (D4), então o limiar local respeita o `maxTokenAge` de 900 s sem depender do relógio da máquina.
- **Não há timer nem permissão `alarms`.** A renovação é preguiçosa, sob demanda.
- O envio da vaga exige `consent.isGranted()` **e** sessão (ADR-025 D2). Login e consentimento são independentes: a troca não leva dado do usuário, e qualquer ordem vale.

**11.2 Single-flight e geração** (T9.3)
- Uma única `Promise` de renovação em memória, compartilhada por todos os chamadores.
- **Contador de geração**, no molde do `CaptureService`: "Sair", um 401 que apaga a sessão e um login novo incrementam a geração. Uma renovação ou troca só grava `trampo/sessao/v1` se a geração ainda for a do início. Assim, um refresh em voo que resolve depois do "Sair" não ressuscita a sessão.

**11.3 Renovação no SW**
- 200 → grava.
- **401 → apaga `trampo/sessao/v1`** e emite `sessao{ autenticado: false, erro: "NAO_AUTENTICADO" }`.
- **503, 429 ou erro de rede → mantém a sessão** e **nunca** pede login (ADR-013 D5; T30).
  - Para rede ou prazo, sem resposta HTTP: **uma única** nova tentativa **sequencial**, 2 s depois. Ela se apoia nas duas exceções de reuso do §1.1 (P10). Nunca depois de uma resposta HTTP: o caso "o GoTrue pode ter rotacionado" é repetido pela própria API (D4).
  - Depois disso, emite `sessao{ autenticado: true, erro: "SERVICO_INDISPONIVEL" }` (ou `LIMITE_DE_TAXA`). A próxima renovação bem-sucedida volta a `erro: null`.
- **SW suspenso no meio da renovação:** a promessa se perde. A próxima renovação reusa o pai do token ativo, e o GoTrue devolve o ativo (P10). Sem essa exceção, novo login (residual, §3).

- **Emenda do 05a-3 (F1-EXT-05a, 2026-11-07), renovação:**
  - limiar `agora ≥ accessExpiresAt − 60 s`. Depois de uma falha transitória, o `accessToken()` devolve o token guardado só se ele ainda não venceu;
  - *single-flight* por geração: quem chama numa geração nova não se junta a uma renovação da geração anterior;
  - **só um 401 com o corpo `ApiError` `NAO_AUTENTICADO` da API apaga a sessão.** Um 401 sem esse corpo (proxy, configuração errada) mantém a sessão e conta como `SERVICO_INDISPONIVEL`, para um desvio de configuração não virar laço de relogin (T30, no molde do 404 do D7). O mesmo vale para 200 fora do contrato e outros status;
  - a nova tentativa de 2 s vale só para o `sem_resposta` do `api-client`; o `resposta_ilegivel` conta como resposta HTTP;
  - a emissão `{ true, null }` depois de uma renovação boa só sai se a anterior tinha falhado ("Renovação 200 depois de falha transitória"); a renovação comum não emite;
  - o 401 que apaga também confere a geração: uma renovação da sessão anterior não apaga a sessão de um login novo.

**11.4 Análise com 401**
- Uma renovação e **um** reenvio com o **mesmo `requestId`** (idempotente pelo ADR-014 D5). Um segundo 401 apaga a sessão. Não há laço.
- Este caminho entra com o envio à API (F1-EXT-04 parte 2). O `auth-service` já expõe `onUnauthorized()` para ele.
- **Emenda do 05a-3 (F1-EXT-05a, 2026-11-07):** a forma é `onUnauthorized(tentativa: 1 | 2)`. Na 1ª, uma renovação forçada (que se junta à que estiver em voo), e o token novo volta para o reenvio. Na 2ª, a sessão é apagada com `{ false, NAO_AUTENTICADO }` e `auth_renovacao_recusada`. O tipo do argumento impede o laço.

**11.5 Logout ("Sair da conta")**
1. O SW captura a sessão numa variável, incrementa a geração, **apaga `trampo/sessao/v1` primeiro** e emite `sessao{ autenticado: false, erro: null }`. O logout local é imediato e incondicional.
2. Em melhor esforço: se o access tiver menos de 60 s de vida, renova só em memória (sem gravar). Se essa renovação der 401, pula a parte remota, porque a sessão já morreu no servidor.
3. Chama `POST /v1/auth/logout` com o Bearer e `{ schemaVersion: 1 }`. A API usa `scope=global` (D4).
4. **Falha remota** (503, rede, prazo ou renovação de logout com 503): uma repetição sequencial automática. Se falhar de novo, emite `sessao{ autenticado: false, erro: "SERVICO_INDISPONIVEL" }`, com texto próprio (D12) e um botão que repete. A sessão capturada fica só em variável do módulo até dar certo, até o SW morrer ou até a idade máxima.
- Atende o T9.4 e o Blueprint ("logout que invalida de fato", l.226). O `global` derruba também o portal e outros dispositivos: o HITL-034 confirma.
- **Emenda do 05a-3 (F1-EXT-05a, 2026-11-07):** a repetição automática espera os mesmos 2 s e refaz a parte remota inteira (a renovação em memória, se ainda precisar, e o `POST`). 204 e 401 encerram o logout (o 401 diz que o token já não vale). A sessão guardada para o "Tentar sair de novo" é a última renovada em memória. Ela sai da memória no "Sair" seguinte, que prefere a sessão local se houver uma (de um login feito depois). A idade máxima do passo 4 se cumpre pelo servidor: passada ela, a renovação do logout dá 401, e a parte remota é pulada.

**11.6 Revogação externa**
- Logout no portal ou em outro dispositivo, exclusão de conta (SR-16) e reuso detectado: a próxima renovação dá 401, e a sessão é apagada.
- O access já emitido continua valendo até o `exp` (residual, §3).
- Item futuro, fora deste ADR: conferir o `session_id` em `auth.sessions` nas rotas sensíveis.

**11.7 Reinício do navegador, atualização, recarga ou desativação da extensão**
- O `storage.session` é apagado (§1.1). O painel recebe `sessao{ autenticado: false, erro: null }` no handshake e mostra "Entrar".
- Não há relogin silencioso. O consentimento também se perde, um resíduo já aceito no ADR-025 §3.

**11.8 Ciclo de vida do SW durante o login**
- Os tokens sobrevivem à suspensão do SW (`storage.session`). O verifier não: se o SW morrer durante o login, o fluxo se perde e o usuário tenta de novo.
- Se o P12 mostrar que o SW morre num login de mais de 30 s, entra a mensagem `{ kind: "pulso" }` (strictObject sem campos), enviada pelo painel a cada 20 s enquanto ele estiver "entrando". Se o `pulso` não bastar, o recuo é a C2 (D14), com o verifier e o `state` no login pendente (D9): o SW acordado pelo evento precisa deles para a troca.

- **Emenda da F1-EXT-07 (2026-11-11, `08149f0`; achados E-02 e E-03):**
  - **D11.4, `onUnauthorized(tentativa, usado)`:** a função recebe o access que levou o 401. Se ele é o da sessão gravada, vale o de antes (1ª vez, uma renovação; 2ª, a sessão é apagada). Se não é, nada é renovado nem apagado: só o token que a renovação **desta mesma geração** trocou recebe o atual, sem outra renovação; o 401 atrasado de outra sessão ("Sair", 401 ou login novo no meio) volta sem token. A F1-EXT-04 parte 2 passa o token capturado no envio;
  - **D11.5, sessão órfã da troca:** com "Sair" durante a troca em voo, a sessão que chega não é gravada e é encerrada no servidor em melhor esforço: `POST /v1/auth/logout` com o access recebido, uma tentativa, em segundo plano (o fluxo fecha na hora), sem gravar e sem emitir. A falha só registra `auth_logout_remoto_falhou`, e o caso fica no residual "Sessão órfã" do §3.

### D12. Contrato do Side Panel
Em `apps/extension/src/messaging/protocol.ts`, privado da extensão:

```ts
export const AUTH_PROVIDERS = ["github", "google"] as const;
export const SessaoErroSchema = ApiErrorCodeSchema.extract([
  "NAO_AUTENTICADO", "SERVICO_INDISPONIVEL", "LIMITE_DE_TAXA", "ERRO_INTERNO",
]);
export const SessaoViewSchema = z
  .strictObject({ autenticado: z.boolean(), erro: SessaoErroSchema.nullable() })
  .refine((s) => !s.autenticado || s.erro === null || s.erro === "SERVICO_INDISPONIVEL" || s.erro === "LIMITE_DE_TAXA");
// PanelToWorkerSchema += (lista fechada, strictObject)
z.strictObject({ kind: z.literal("entrar"), provedor: z.enum(AUTH_PROVIDERS) }),
z.strictObject({ kind: z.literal("sair") }),
// WorkerToPanelSchema +=
z.strictObject({ kind: z.literal("sessao"), sessao: SessaoViewSchema }),
```

- **O painel enxerga só um booleano e um código do catálogo do ADR-025** (requisito 3). Nenhum código privado novo.
- `autenticado: true` só quer dizer que existe sessão local. Quem tem autoridade é o servidor.
- O "entrando…" é **estado local do painel**: liga no clique em "Entrar" e desliga na próxima `sessao`, com teto de 5 min e 10 s. O SW sempre emite uma `sessao` no fim de cada tentativa, mesmo sem mudança.

| Evento no SW | `sessao` emitida | `trampo/sessao/v1` |
|---|---|---|
| Handshake com sessão local válida | `{ true, null }` | mantém |
| Handshake sem sessão, ou valor adulterado (o `sessionStore` apaga) | `{ false, null }` | vazio |
| Login concluído | `{ true, null }` | grava |
| Promessa do `launchWebAuthFlow` rejeitada (janela fechada ou outra falha do navegador) ou prazo de 5 min | `{ false, null }` | sem mudança |
| `error` ou `error_code` no retorno (negado no IdP) | `{ false, null }` | sem mudança |
| Retorno adulterado (outro host ou caminho, fragmento com token, parâmetro extra ou repetido, `st` divergente, `code` fora do formato) | `{ false, "ERRO_INTERNO" }` | sem mudança |
| Troca 401 (código inválido, verifier errado, reuso: não acontece em fluxo normal) | `{ false, "ERRO_INTERNO" }` | sem mudança |
| Troca 429 | `{ false, "LIMITE_DE_TAXA" }` | sem mudança |
| Troca 503, rede ou prazo | `{ false, "SERVICO_INDISPONIVEL" }` | sem mudança |
| Build sem origem da API ou do Supabase | `{ false, "ERRO_INTERNO" }` | sem mudança |
| Renovação 200 depois de falha transitória | `{ true, null }` | grava |
| Renovação 401, ou segundo 401 na análise | `{ false, "NAO_AUTENTICADO" }` | apaga |
| Renovação 503, 429 ou rede (depois da nova tentativa) | `{ true, "SERVICO_INDISPONIVEL" }` ou `{ true, "LIMITE_DE_TAXA" }` | mantém |
| "Sair" | `{ false, null }` | apaga antes da rede |
| "Sair" com falha remota, depois da repetição automática (D11.5) | `{ false, "SERVICO_INDISPONIVEL" }` | já vazio |

- **Emenda do 05a-3 (F1-EXT-05a, 2026-11-07):** a `SessaoView` entrou no `protocol.ts` só como tipo: a união `{ autenticado: true; erro: SERVICO_INDISPONIVEL | LIMITE_DE_TAXA | null } | { autenticado: false; erro: SessaoErro | null }`, que já recusa `{ true, NAO_AUTENTICADO }` na compilação. O schema com o `refine` (M-08) e as mensagens são da F1-EXT-05b. O handshake (`authService.view()`) devolve `{ true, erro }` com o erro transitório da última renovação, se houver, e não sempre `{ true, null }`: um painel reaberto durante a falha vê o mesmo estado do painel que já estava aberto. Cada linha do SW desta tabela é um teste `D12 | …` em `test/auth-service.test.ts` (CA-14).
- **Handshake novo**, fixado no E2E: `[ready, captura, consentimento, sessao]`. A `sessao` vai no fim para mexer o mínimo nas provas atuais (`messaging.e2e.test.ts` L41-46). Ela é reemitida a cada mudança pelo `PanelHub`.
- **UI** (emenda ao ADR-025 D4/D5):
  - botões, nunca links (o lint proíbe `a` e `href`): "Entrar com GitHub", "Entrar com Google" e "Sair da conta";
  - `texts.ts` ganha um `SESSION_TEXTS` exaustivo para `{ autenticado, erro }`. Os códigos reaproveitam o `ERROR_TEXTS`, menos `ERRO_INTERNO`, que ganha texto próprio sem pedir o código do pedido (a `SessaoView` não tem `requestId`). Com `autenticado: false` e `erro: null`, o texto é "Entre com a sua conta do GitHub ou do Google para analisar vagas.";
  - `{ false, "SERVICO_INDISPONIVEL" }` depois de "Sair" (o painel sabe pelo último clique, estado local como o "entrando") mostra "Você saiu neste navegador, mas o servidor não confirmou o encerramento da sessão. Tente de novo." e o botão "Tentar sair de novo", que reenvia `sair`;
  - o painel não mostra identidade nem provedor (sem e-mail nem nome; residual "conta trocada", §3; Q11). Conectado, mostra só "Conectado à sua conta do Trampo.";
  - "Analisar" só fica habilitado com API configurada, sessão e consentimento;
  - com `queda: "porta_fechada"` (e só nela; com `resposta_invalida` a queda continua definitiva), aparece o botão "Reconectar", que faz um novo `runtime.connect` e um novo `hello`. É ação do usuário, sem laço.
- **Emenda do 05b-1 (F1-EXT-05b, 2026-11-08), protocolo e handshake:**
  - **schema:** o do bloco acima, com o `refine` escrito como guarda de tipo (`sessaoCoerente`), para a saída do schema ser a união do 05a-3. O tipo `SessaoErro` passa a vir do `SessaoErroSchema`;
  - **única saída:** o SW só emite pelo `toSessaoView`, que copia `autenticado` e `erro` num objeto novo e revalida a cópia. Um objeto com campo a mais nunca sai como veio, e um valor fora do schema vira `{ false, ERRO_INTERNO }`, sem eco;
  - **hub da sessão:** `src/messaging/session-channel.ts`, sobre o `PanelHub`. A emissão vai a todas as portas confiáveis. No handshake, a porta entra no hub antes da leitura da visão atual, e a leitura só é enviada se nenhuma emissão aconteceu durante ela e se a porta segue ligada: uma emissão concorrente já é a mais nova;
  - **composição:** o `createWorkerAuth` monta o canal, liga o `emit` do `auth-service` a ele e devolve o serviço sem o `view()`, com um `attach(port)`. O `background.ts` encadeia `capture.attach`, `consent.attach` e `auth.attach` e liga `entrar` e `sair` (`onLogin` e `onLogout` do `worker-port`). As duas mensagens não têm resposta direta: a resposta é a `sessao` emitida. O `panel-state` guarda a `sessao` (null até o fim do handshake), ainda sem UI (05b-2 e 05b-3);
  - **E2E no Edge** (`messaging.e2e.test.ts`): o handshake tem exatamente as 4 mensagens. No build sem origens, `entrar` dá `{ false, ERRO_INTERNO }` sem abrir janela, e `sair` sem sessão dá `{ false, null }`. Provedor fora da lista, chave extra, `sair` com payload e `sessao` vinda do painel derrubam a porta.

- **Emenda do 05b-2 (F1-EXT-05b, 2026-11-09), estado e textos da sessão, em lógica pura (o React é do 05b-3):**
  - **estado local** (`src/panel/panel-state.ts`): `entrandoDesde` (a hora do clique em "Entrar", no relógio do App) e `pediuSair` (o último pedido de sessão foi "Sair"). Nada dos dois vai ao SW, e a porta não ganhou mensagem;
  - **ações novas do redutor:** `entrar { agora }`, `sair`, `tique { agora }` e `reconectar`. O redutor ignora o clique que a tela não oferece. O `sessionActions` não oferece nada antes da `sessao` do handshake, fora do `pronto` ou durante o "entrando"; oferece `["sair"]` com sessão, `["entrar"]` sem sessão e `["tentar_sair", "entrar"]` na falha remota do logout;
  - **"entrando":** liga no clique e desliga na próxima `sessao`, qualquer que seja. O `ENTRANDO_TETO_MS` (310.000) é o `loginDeadlineMs` do SW mais 10 s, preso por teste, porque o painel não importa `src/auth`. O `tique` desliga no teto e também com o relógio que volta (decorrido negativo ou `NaN`): a falha segura devolve os botões, e o SW ignora o 2º clique com um fluxo pendente (o `login` não emite com tentativa em curso). Um 2º clique durante o "entrando" não reinicia o teto;
  - **último "Sair":** o `pediuSair` liga no "Sair" (o "Tentar sair de novo" já o encontra ligado), desliga no "Entrar" e com qualquer `sessao` autenticada (um login feito em outra janela). O `logoutUnconfirmed` é o `pediuSair` com `{ false, SERVICO_INDISPONIVEL }`. Sem o clique, a mesma visão tem o texto geral (troca 503);
  - **"Reconectar":** o `canReconnect` só vale com `queda: "porta_fechada"`. A ação volta ao `INITIAL_PANEL_STATE`: o handshake novo traz tudo de novo, e o "entrando" não sobrevive. Com `resposta_invalida`, ou com a conexão viva, ela é ignorada. Nenhuma mensagem, clique ou tique sai da queda (a condição 3 do `[APPSEC]`, na lógica; o clique em si é do 05b-3);
  - **portão do "Analisar":** `analyzeBlock(api, { consentimento, sessao })` devolve `sem_api`, `sem_consentimento` ou `sem_sessao`, nessa ordem, ou `null`. Sessão é `autenticado: true`, com ou sem erro transitório. O `api` vem do App: o painel não lê o build (o `import.meta.env` fica só no `background.ts`) e, até o envio existir, ele é sempre `false`. A fonte do `api` se decide na F1-EXT-04 parte 2, com o `[APPSEC]` (B6);
  - **textos** (`src/panel/texts.ts`):
    - `SESSION_TEXTS` com `{ estado, erro }` para cada `{ autenticado, erro }`, exaustivo pelo tipo: 3 visões com sessão e 5 sem;
    - `LOGOUT_UNCONFIRMED_TEXT`, `SIGNING_IN_TEXT` ("Entrando… Conclua o acesso na janela que abriu."), `SIGN_IN_LABELS` por provedor da `AUTH_PROVIDERS`, `SESSION_ACTION_LABELS` e `ANALYZE_BLOCKED_TEXTS`. O `sem_api` é o aviso de hoje, e o `SEM_API` do `Analysis.tsx` passou a vir daqui;
    - `NAO_AUTENTICADO` e `SERVICO_INDISPONIVEL` reaproveitam o `ERROR_TEXTS`;
    - **dois desvios do D12:** o `ERRO_INTERNO` da sessão é "Algo deu errado do nosso lado." com "Tente de novo. Se continuar, fale com o suporte do Trampo."; e o `LIMITE_DE_TAXA` ganhou texto próprio ("Muitas tentativas em pouco tempo." com "Espere um pouco e tente de novo."), porque o do `ERROR_TEXTS` fala de análises, e o 429 da sessão vem do login ou da renovação;
  - **residuais aceitos, sem mudança no SW:**
    - o handshake depois de um "Sair" com falha remota devolve `{ false, null }`: o storage já está vazio, e a sessão do "Tentar sair de novo" vive só na memória do SW. Um painel reaberto não mostra o botão, e a sessão remota vence na idade máxima (D11.5);
    - se o usuário clicar em "Entrar" nos 2 s da repetição do logout, a falha remota desliga o "entrando" antes do fim do login e mostra o texto geral do `SERVICO_INDISPONIVEL`. O login segue e emite `{ true, null }` no fim.

- **Emenda do 05b-3 (F1-EXT-05b, 2026-11-09), botões, "Reconectar" e E2E do painel (o React; [ADR-025-side-panel-ui](ADR-025-side-panel-ui.md) D4, D5 e D6, "Emenda do 05b-3"):**
  - **sem lógica nova fora do `src/panel`:** o `src/entrypoints/sidepanel/Session.tsx` mostra o `describeSession` e só os botões do `sessionActions`. O `entrar` vira um botão por provedor da `AUTH_PROVIDERS`, e o "Sair da conta" e o "Tentar sair de novo" mandam o mesmo `sair`. O clique despacha a ação local e posta a mensagem; o `entrar` leva o `Date.now()` do App. Depois do login, nada mostra conta nem provedor;
  - **relógio:** o tique de 1 s (`ENTRANDO_TIQUE_MS`, no `panel-state`) só fica armado com o `entrandoDesde` ligado e não posta nada. O teto desliga com no máximo 1 s de atraso, dentro da folga de 10 s;
  - **"Reconectar":**
    - o `PanelState` ganhou a `geracao` da porta (0 no início). O redutor a soma de 1 só no "Reconectar" aceito, com `queda: "porta_fechada"`, e volta ao estado inicial com a geração nova;
    - o efeito da porta no App depende só da `geracao`. Um clique ignorado, uma mensagem, um tique ou uma queda nunca abrem porta, e um teste de invariante prova isso em todos os estados alcançáveis;
    - a porta que caiu ou foi derrubada fica inativa: o painel ignora o que ainda chegar por ela e não a derruba de novo;
    - o texto da `porta_fechada` passou a "A conexão com o Trampo caiu. Clique em Reconectar para continuar.". O da `resposta_invalida` não muda, e ela não tem botão;
  - **"Analisar":** o `analyzeBlock(API_DO_ENVIO, state)`, com o `API_DO_ENVIO` constante `false` no `App.tsx` até a F1-EXT-04 parte 2. A fonte dele segue com o `[APPSEC]` (B6);
  - **E2E** (`panel.e2e.test.ts`, Edge 157, build de produção):
    - com a porta falsa: o texto das 8 `SessaoView` e só os botões oferecidos; "Entrar" com cada provedor (só `{ entrar, provedor }` sai); "Sair", a falha remota e o "Tentar sair de novo" a 320 px; a mesma falha sem o clique, com o texto geral; o "entrando" com o relógio falso do Playwright (teto e relógio que volta, e o intervalo vivo só durante o "entrando"); o "Reconectar" com uma porta nova, um `hello` novo e a porta antiga ignorada; e o "Analisar" pelo portão;
    - com o SW real, no build sem origens: o "Entrar" dá `{ false, ERRO_INTERNO }` sem janela e com o texto do catálogo; e o SW parado por `Target.closeTarget` derruba a porta, e o "Reconectar" acorda o SW e refaz o handshake (cenário 11 do §4.4);
  - **condição 3 do `[APPSEC]`** ("Reconectar" só por ação, sem laço): cumprida. Na unidade, só o "Reconectar" aceito muda a `geracao` (o mutante G-06, a queda que soma a geração, é o laço automático e morre). No E2E, 1 s depois da queda ainda há uma porta só, e o clique abre exatamente a segunda;
  - **mutação** (`mut05b3.py`): 32/33. O sobrevivente é equivalente: sem marcar a porta derrubada por resposta inválida como inativa, nada muda na tela, porque a queda por resposta inválida é definitiva no redutor e não sobra botão que poste. A marcação ficou como defesa em profundidade.

### D13. Manifesto (diff exato)

| Item | Antes | Depois | Por quê |
|---|---|---|---|
| `permissions` | `activeTab, scripting, sidePanel, storage` | **+ `identity`** | `launchWebAuthFlow` e `getRedirectURL`. Não gera aviso ao usuário (§1.1). |
| `identity.email` | ausente | **ausente** | O e-mail não é necessário (minimização) e geraria aviso. |
| `key` | ausente | **presente só quando `TRAMPO_EXTENSION_KEY` está definida**: builds unpacked de dev, de E2E e do MVP em Developer Mode (HITL-008) | ID fixo: Redirect URL exata no Supabase e origem exata no CORS (ADR-001 §5.0.1; F1-EXT-00). A variável é validada como chave pública SPKI em base64. |
| `host_permissions`, `optional_host_permissions`, `<all_urls>` | ausentes | **ausentes** | A documentação não as exige para o `launchWebAuthFlow` (confirmar no P3). |
| `externally_connectable` | `{ ids: [], matches: [] }` | **sem mudança** | A opção (a) não precisa (T20; Blueprint l.221, corrigido pelo threat-model §6 (D-H7)). |
| CSP `connect-src` (manifesto) | só `TRAMPO_API_ORIGIN` ou `'none'` | **sem mudança** | A janela de login é navegação, não `fetch` (confirmar no P3). |
| CSP do painel | só a do manifesto | **+ meta do D10 B4** no `index.html` de produção | Sem egress por `fetch` nem formulário; Trusted Types (D10 B4). |
| `optional_permissions` | ausente | **ausente** | Nada é pedido em runtime. |
| `alarms`, `tabs`, `cookies`, `webRequest`, `declarativeNetRequest`, `oauth2`, `content_scripts`, `web_accessible_resources` | ausentes | **ausentes** | Renovação preguiçosa; nada de callback na extensão. |
| `contextMenus`, `commands` | ausentes | **fora deste ADR** | Pertencem ao gatilho do S-3 (itens 1 e 2). |
| `minimum_chrome_version` | `116` | **sem mudança** | `launchWebAuthFlow` devolve Promise desde o 106. |
| Variável de build nova | nenhuma | `TRAMPO_SUPABASE_ORIGIN` (origem https exata, validada como a `apiConnectSrc`) | Só monta a URL do `authorize`. **Não entra na CSP.** |

- **Builds de loja** (Fase 2) ficam com HITL próprio: o ID na loja do Edge fica a verificar (§1.1), e a política das lojas sobre a `key` também.
  - Uma Redirect URL exata e uma origem de CORS **por ID de loja** (Chrome e Edge). **Nunca curinga de host** (`https://*.chromiumapp.org/**` abriria o fluxo a qualquer extensão, e `identity` não gera aviso).
  - O ID de dev sai das listas de produção.
- **`manifest.test.ts`**, no build do E2E (as duas origens e a `key`):
  - lista exata `[activeTab, identity, scripting, sidePanel, storage]`; `identity.email` e `optional_permissions` ausentes;
  - `key` presente se e somente se `TRAMPO_EXTENSION_KEY` estiver definida, provado com dois builds (com e sem), com o ID derivado igual ao esperado;
  - `externally_connectable` igual a `{ ids: [], matches: [] }`;
  - `connect-src` sem a origem do Supabase;
  - meta CSP do D10 B4 presente no `sidepanel.html` de produção;
  - grep do artefato (D10 B5) e ausência do marcador do adapter falso de identidade do E2E.
- **Emenda do 05a-4 (F1-EXT-05a, 2026-11-08):**
  - as três variáveis são lidas uma vez por `apps/extension/build-env.ts` (`readBuildEnv`), no topo do `wxt.config.ts`: as duas origens com a forma https exata (regex e `new URL(v).origin === v`, que recusa `_`, porta 443 explícita, maiúsculas e quebra de linha) e a `key` como SPKI DER de uma chave `rsa` com 2048 bits ou mais, em base64 canônico (a chave reexportada tem de dar o mesmo texto: recusa quebra de linha, base64url, PEM, bytes sobrando, bits de preenchimento trocados, EC, Ed25519, RSA-PSS, RSA de 1024 e chave privada). Valor fora da forma derruba o build, e a mensagem nunca ecoa o valor. Vazio conta como ausente. O `extensionIdFromSpki` deriva o ID (128 bits do SHA-256, de 0-f para a-p) para o E2E e o runbook;
  - as origens chegam ao bundle por `define` (`import.meta.env.TRAMPO_*`, tipadas em `src/build-env.d.ts`); sem a variável, o valor é `""`, e o login dá `auth_sem_configuracao`. As três entram no `env` da tarefa `build` do turbo;
  - o `manifest.test.ts` faz dois builds próprios, em processo filho e pasta temporária: o "fechado" (sem variável) e o "completo" (as duas origens e uma chave RSA gerada na hora, nunca no git). Prova a lista exata de permissões nos dois, `identity.email`, `oauth2` e `optional_permissions` ausentes, `key` se e somente se, o ID derivado, o `connect-src` `'none'` ou só a API, a origem do Supabase fora do manifesto, e três builds inválidos que falham sem ecoar o valor (§4.6);
  - o grep do artefato já roda nos dois builds: `launchWebAuthFlow`, `getRedirectURL`, `.identity.`, `storage.session`, `/v1/auth/` e a origem do Supabase não aparecem em nenhum arquivo além do `background.js` (um superconjunto do fecho transitivo do painel). A meta CSP do painel (B4) e o grep pelo fecho exato ficam com a F1-EXT-05b; o marcador do adapter falso, com a F1-EXT-05c (hoje o teste prova só a ausência de `TRAMPO_E2E`).

### D14. Contingências e recuo
Nenhuma contingência entra sem HITL próprio. Todas são adapters da porta `AuthCodeSource` (D3) e usam a mesma `POST /v1/auth/exchange`.

- **C1. Se o P1 falhar** (o `launchWebAuthFlow` não abre a partir do SW sem gesto):
  - o painel chama `launchWebAuthFlow` com a `authorizeUrl` montada pelo SW (sem segredo: leva só o `challenge`) e devolve ao SW a URL de retorno pela porta, numa mensagem estrita `{ kind: "retorno", url }` com teto;
  - o verifier nunca sai do SW, e o código sozinho é inútil sem ele;
  - custo: exceção escrita ao lint B1/B2 para um único arquivo (`src/panel/identity-relay.ts`); o SR-23 passa a admitir que o **código** transite pelo painel, nunca token, envelope ou verifier.
- **C2. Se o P2 ou o P12 falharem no Edge** (a interceptação do chromiumapp.org não funciona ou o SW morre no login): o portal vira **relay do código** (b2):
  - o SW abre uma aba normal (`tabs.create`, sem a permissão `tabs`) no `/auth/v1/authorize` com `redirect_to` para uma página estática do portal, `/extensao/retorno/<id>`, sem login nem cookie, com CSP `default-src 'none'; script-src 'self'` e `Referrer-Policy: no-referrer`;
  - a página tira o `code` da URL (`history.replaceState`) e chama `runtime.sendMessage(<id>, { v: 1, kind: "trampo/retorno", code })`;
  - o SW valida no `onMessageExternal`, com a matriz de recusa: `sender.origin` exato, `pathname` exato, `sender.tab` igual ao `tabId` do login pendente, `frameId` 0, fluxo pendente com menos de 5 min, Zod estrito e nenhum *replay*. Recusa responde `{ ok: false }` sem chamar a API;
  - o verifier e o `state` ficam no login pendente (D9). Sem ele, o SW acordado pelo evento não teria o verifier, e a C2 não resolveria o P12;
  - pré-requisitos: portal hospedado com origem exata (fora do S-5 hoje); `matches` com essa origem; divergência do Blueprint l.221 aprovada pelo humano; SR-10, TB3b e `manifest.test.ts` L34-36 revistos;
  - ganha: aba com barra de endereço e entrega por evento, que acorda o SW. Perde: abre o `onMessageExternal`, e um XSS na origem do portal captura o código de um fluxo iniciado com o verifier do atacante.
- **Recuo.** Se o P4, o P7 ou o P8 falharem (o Supabase não faz PKCE hospedado com o redirect chromiumapp), o ADR volta para desenho com novo HITL. Nunca *implicit*, nunca ID token só do Google.

### D15. Configuração externa exigida (sem nenhum valor no cofre)
- **Credenciais** (HITL-035 parte 1): §6.2.
- **Supabase real** (HITL-035 parte 2, com o runbook `auth-extensao.md`):
  - Redirect URL exata `https://<id-dev>.chromiumapp.org/auth`, sem curinga. Prova negativa: um `redirect_to` com outro ID de chromiumapp não recebe código;
  - Site URL numa origem própria (nunca o `localhost` do template), por causa do P6 e do T48: uma página estática sem subrecurso de terceiros, com `Referrer-Policy: no-referrer`, `history.replaceState` que remove o `code` e sem log de query string no host ou na CDN. O portal fica proibido de ter *open redirect*;
    - **Emenda do HITL-035 (2026-11-06): o humano escolheu a opção A.** Até o S-5, o Site URL é `https://<id-dev>.chromiumapp.org/`, a raiz do host chromiumapp da própria extensão:
      - não há página, servidor, CDN nem log: o host não resolve (NXDOMAIN, runbook §3.0), e só o `launchWebAuthFlow` desta extensão intercepta o host;
      - um código que caia na raiz dentro da janela de login é recusado pelo `parseAuthRedirect` (caminho ≠ `/auth`), sem troca. Numa aba comum, fica no `tab.url` e no histórico do perfil (residual T48);
      - nunca `localhost` nem origem de terceiro. O ID de dev fica em três lugares que mudam juntos: Redirect URL, Site URL e `CORS_ALLOWED_ORIGINS`;
      - por conhecimento prévio, não verificado nesta versão, o GoTrue aceita qualquer `redirect_to` com o mesmo hostname do Site URL. Com a opção A, qualquer caminho e query no nosso host receberiam código; o `parseAuthRedirect` exige `/auth` exato, e o resto é o T48. A classe do risco não muda;
      - a prova negativa (outro ID de chromiumapp não recebe código) é o caso E, com o critério da opção A: o retorno cai na raiz do Site URL (nosso host, caminho `/`) ou não traz código, e **nunca** chega ao host pedido. Hoje está **inconclusiva** (*HITL-QUEUE §HITL-036*);
      - os requisitos de página estática deste item ficam suspensos enquanto não há página e voltam no S-5.
    - **No S-5, ao trocar o Site URL:** a página estática fica pronta antes, numa origem própria e dedicada. Depois o humano refaz, pelo runbook §3, os casos A com `-ComState` (P5, agora sem a confusão do host), E, F (anotando o `caminho`; se o caminho arbitrário for aceito, toda a origem nova precisa das regras de página estática) e G. Se o `st` deixar de voltar, vale a Q6, com emenda ao D3 passo 5. Se algum código chegar a host fora da lista, vale o veto do §3.
  - ES256 como chave current, JWT de 900 s, rotação ligada, reuso de 10 s, anônimo desligado;
  - **provedores Email e Phone desligados**; GitHub e Google ligados, com o callback do Supabase nos apps OAuth;
  - recomendação para a Fase 1: desligar novos cadastros depois de criar a conta do autor (impede contas descartáveis consumindo cota). **Emenda do HITL-035 (2026-11-06):** Q9 aprovada e **ainda não aplicada** (runbook §2.2 sem marca; *HITL-QUEUE §HITL-036*);
  - anotar os limites de taxa do Auth (P19) e a disponibilidade do Custom Access Token Hook (P18). **Emenda do HITL-035 (2026-11-06):** feito (§1.4);
  - confirmar se o runbook `supabase-setup` foi movido ou apagado (§1.2). **Emenda do HITL-035 (2026-11-06):** apagado de propósito (§1.2).
- **API em produção:** `API_BEHIND_PROXY` e `TRUST_PROXY` com as faixas do proxy (D8 item 4); `AUTH_ALLOWED_AMR` com o padrão `oauth`.
- **Relatório de conformidade do token real (P9):** só no ambiente do spike, com `AUTH_SPIKE_CONFORMANCE_REPORT=1`, que o boot recusa com `NODE_ENV=production`. A etapa "verificar antes de repassar" registra uma mensagem de catálogo com **só booleanos e faixa de tamanho** para cada item do P9 (com `expires_in` e `exp − iat` iguais a 900). Nunca valores.

## 3. Auditoria do `[APPSEC]`

**Veto condicional.** O `[APPSEC]` aprova a direção e mantém o veto à passagem para **aceito** até:
- o P3 provar que não há `host_permissions`;
- o P4 e o P8 provarem o PKCE imposto pelo servidor (sem isso, não há defesa contra injeção de código);
- o P5 decidir o `state` (ou o HITL-034 aceitar o recuo para PKCE sem `state`);
- o P6 e o HITL-035 garantirem o Site URL numa página estática de origem própria (D15);
- o P18 decidir o T9 fora do BFF: com o hook no Free, ele entra antes do aceite; sem ele, o HITL-034 aceita o residual de forma explícita (Q10).

**Emenda do HITL-035 (2026-11-06), estado do veto** (o veto continua de pé para o aceite):
- P4 e P8 cumpridos no pré-spike (casos A a D, G e H), com a ressalva de evidência do P8 para o aceite (§1.4);
- P5 decidido: o `state` fica e é refeito no S-5 (D15);
- **P6 aberto:** o *HITL-QUEUE §HITL-036* refaz o caso E pelo critério da opção A (D15);
- P18 confirmado: o hook entra antes do aceite (F1-DB-02), sem a alternativa da Q10;
- P3 sem mudança.

**Emenda do HITL-036 (2026-11-07), estado do veto:**
- P6 aprovado (declarado pelo humano): com o Site URL A, os casos E e F refeitos foram bloqueados ou caíram na raiz do nosso host. O Site URL virou A durante a parte 3 do HITL-035, o que explica o caso E original;
- Q9 aplicada (excedentes apagados, novos cadastros desligados): o residual "cadastro aberto" fecha;
- as anotações do pré-spike não vieram: a ressalva de evidência do P8 e o `code_e_uuid` passam ao spike S-3;
- **restam P3 e P18.** O veto continua de pé para o `aceito` formal até a F1-EXT-05a (P3) e a F1-DB-02 (P18), além dos CAs do §4.10.

**Sobreposição do veto pelo humano (2026-11-07):** o humano sobrepôs o veto e marcou o ADR como `aceito` antes do P3 e do P18. O `[APPSEC]` registra:
- a decisão é do humano e vale para o status do documento, não para as provas. O P3 (manifesto sem `host_permissions`, F1-EXT-05a, CA-01) e o P18 (hook, F1-DB-02, CA-15) seguem obrigatórios para fechar essas trilhas e o F1-EXT-05;
- até a F1-DB-02 ser aplicada no projeto real, seguem de pé os residuais que dependem do hook: T48, sessão órfã e chave de selagem vazada junto com o `storage.session` (lista abaixo);
- se o P3 ou o P18 falharem, o `[APPSEC]` abre HITL para decidir o status e a contingência (D14).

**Critérios de aceite:** as condições do veto acima (CA-15), os SRs do §4.9 e os CAs do §4.10, com o rastreio no fim do §4.10.

**Ameaças novas para o threat model v2** (o TB9 já é Dev/CI):

| ID | Ameaça | Mitigação neste ADR | SR |
|---|---|---|---|
| TB10 | Fronteira SW ↔ janela do `launchWebAuthFlow` ↔ Supabase Auth hospedado ↔ GitHub/Google, com retorno interceptado no chromiumapp.org | D2, D3 | SR-18 |
| TB11 | Fronteira API → Supabase Auth (GoTrue), HTTPS com `apikey` *publishable*; Bearer do usuário só no logout | D4, D6, D8 | SR-19 a SR-22 |
| T41 | CSRF de login e injeção de authorization code | PKCE S256 imposto (P8), `state` (P5), redirect exato, um fluxo por vez | SR-18 |
| T42 | *Downgrade* para *implicit* ou `plain`; redirect não registrado caindo no Site URL | nunca `response_type=token`, fragmento recusado, só `s256`, Site URL própria, sem curinga | SR-18 |
| T43 | Abuso das rotas públicas e esgotamento do limite do Supabase Auth pelo IP único da API | limitador local (com `TRUST_PROXY`), orçamento de saída particionado, *bulkhead*, corpo até 2 KiB, formato e AEAD antes do GoTrue, logs amostrados, Cloudflare no S-5 | SR-19, SR-20, SR-21 |
| T44 | Roubo e *replay* do envelope | envelope só serve pela API, inatividade e idade máxima sem rede, `sid` amarrado, orçamento de saída, logout global | SR-21, SR-24 |
| T45 | Vazamento de `provider_token`, `user` e PII da resposta do GoTrue | projeção de 3 campos na API, canários | SR-22 |
| T46 | Painel (contexto confiável) lendo `storage.session` ou recebendo token | D10 (B1 a B10), `SessaoView` sem texto livre | SR-23 |
| T47 | Comprometimento da chave de selagem | anel próprio, só no `.env`, rotação, varredura de segredos | SR-14, SR-21 |
| T48 | Fluxo PKCE iniciado pelo atacante: o código lido no destino (`tab.url` do chromiumapp numa aba normal, ou o Site URL) é trocado direto no GoTrue com a *publishable*, e a sessão nasce sem envelope nem idade máxima | allow-list exata, Site URL estático (D15), Custom Access Token Hook (D5) se o P18 confirmar; senão residual | SR-18, SR-21 |

**Riscos residuais** (a aceitar no HITL-034):
- **Painel na mesma origem.** Qualquer página da extensão lê o `storage.session`. A regra "só o SW" depende de lint, depcruise, grep, canários e revisão.
  - Um XSS no painel leria token e envelope. A meta CSP (B4) não barra navegação, `window.open`, `tabs.create`, `identity` (*phishing* numa janela sem barra) nem WebRTC.
  - Com o envelope, ele renova de qualquer lugar até a inatividade ou a idade máxima (a AAD é forjável). O controle real é não ter XSS.
- **Malware local (AT8)** lê a memória do navegador. Fora do alcance do app. O residual M do T9 entra na tabela §9 do threat model.
- **Revogação não instantânea.** Depois de logout, revogação no portal, exclusão de conta ou reuso detectado, o access já emitido vale na API por até 900 s + 10 s. Um access roubado vale até o `exp` também direto no PostgREST (`/rest/v1`) e no `/auth/v1/user`, que devolve e-mail e metadados.
- **Sessões fora do BFF sem idade máxima (T48).** Sem o Custom Access Token Hook, uma sessão criada direto no GoTrue (fluxo do atacante ou portal) não expira no Free. A reautorização silenciosa no IdP fica a medir no P14. **Emenda do HITL-035 (2026-11-06):** mitigado pelo hook quando aplicado (F1-DB-02); até lá, residual.
- **Sem Cloudflare até o S-5.** O limitador local vale por instância e zera quando o processo reinicia. Poucos IPs esgotam a partição de troca (negação de login), e um /48 IPv6 enche os 10.000 baldes. A renovação com envelope válido tem reserva de 50% do orçamento de saída (T43). **Emenda do HITL-035 (2026-11-06):** pelo P19, os tetos reais são 30 (sign-in) e 150 (token) a cada 5 min por IP, e o orçamento fica em até 14 e 74 (D8 item 5). Com o limitador local de hoje (10/min na troca), um IP sozinho esvazia a partição `troca`.
- **Fase 2:** com vários usuários, o IP único da API vira gargalo dos limites do Supabase Auth. Será preciso rever os limites ou distribuir a saída.
- **Comprometimento da API** dá acesso a sessões vivas: a API abre o envelope e vê o refresh cru em memória.
- **Chave de selagem vazada junto com o `storage.session`:** o atacante abre o envelope e usa o refresh direto no Supabase. Rotacionar a chave derruba todas as sessões. O Custom Access Token Hook (D5) reduziria isso. **Emenda do HITL-035 (2026-11-06):** mitigado pelo hook quando aplicado (F1-DB-02); até lá, residual.
- **Sessão órfã:** quando a idade máxima ou a inatividade vencem (401 sem rede), ou o `sid` diverge (refresh novo descartado), a sessão fica em `auth.sessions`, porque no Free o refresh não expira. Ela é inutilizável sem a chave de selagem. O hook (D5) a cobriria. **Emenda do HITL-035 (2026-11-06):** mitigado pelo hook quando aplicado (F1-DB-02); até lá, residual. **Emenda da F1-SEC-01 (2026-11-11):** também quando o "Sair" cai durante a troca em voo, porque a sessão que chega é descartada só no local ([revisao-adversarial-auth](../revisao-adversarial-auth.md) E-03; logout remoto em melhor esforço na *BACKLOG §F1-EXT-07*).
- **Logout remoto que falha:** a sessão segue viva no GoTrue até a idade máxima. O painel avisa e oferece repetir (D11.5).
- **Janela de reuso:** se o GoTrue rotacionar e a resposta se perder, a API ou o SW tentam uma vez com o mesmo `rt`, e o reuso do pai do token ativo devolve o ativo, mesmo depois de 10 s (§1.1). A sessão só cai se outra renovação avançar a cadeia no meio. Sem a exceção do pai (P10), volta a valer a janela de 10 s.
- **Renovação perdida por JWKS:** `kid` novo e JWKS fora no mesmo instante fazem a API responder 503 depois de consumir o refresh (D6). A próxima renovação recupera pela exceção do pai (P10); sem ela, novo login.
- **`state` ausente**, se o P5 falhar: a defesa contra CSRF de login fica só com o PKCE imposto pelo servidor (RFC 9700 §4.7.1), aceitável só se o P8 passar. **Emenda do HITL-035 (2026-11-06):** não se aplica agora (P5 aprovado); volta se o P5 falhar no S-5.
- **Pontos sem documentação oficial:** os do §1.4. Por isso o status é proposto.
- **Chave pública de dev:** qualquer pessoa carrega um unpacked com o mesmo ID e herda a origem de CORS e a Redirect URL de dev. Aceitável no MVP de um usuário. Na Fase 2, o ID de dev sai de `CORS_ALLOWED_ORIGINS` e das Redirect URLs de produção, que ficam com uma entrada exata por ID de loja (D13).
- **Conta trocada não detectável no painel.** O painel não mostra conta nem provedor (D12). Com outra conta do GitHub logada no perfil e reautorização silenciosa (P14), o usuário envia vagas e salva critérios na conta errada sem sinal na tela (Q11).
- **UX:** login e consentimento somem a cada reinício do navegador ou atualização da extensão. Sem relogin silencioso. Se o SW morrer no meio do login, o usuário tenta de novo.
- **Cadastro aberto:** se os novos cadastros continuarem ligados, qualquer conta GitHub ou Google cria usuário e consome cota (50 análises por dia por usuário, ADR-014 D5). Contas por e-mail ou telefone são barradas pelo `amr` (D6). **Emenda do HITL-035 (2026-11-06):** ativo até o humano desligar os novos cadastros (Q9; *HITL-QUEUE §HITL-036*).
- **Configuração real desconhecida:** só a declaração do HITL-004. O D6 diz o que aparece em runtime (503 ou 401 pelo `amr`). "E-mail ligado" não aparece: só o HITL-035 confere.
- **Janela de login sem barra de endereço** (P14): pode facilitar *phishing* visual. A contingência C2 usaria aba normal.
- **Código na raiz do host da extensão** (emenda do HITL-035, 2026-11-06; opção A do D15): até o S-5, o Site URL é a raiz do nosso host chromiumapp. Um código que caia ali numa aba comum fica no `tab.url` e no histórico do perfil. Coberto pelo T48.
- **Variante *implicit* do T48** (emenda do HITL-035, 2026-11-06; a registrar no threat model v2 pela F1-SEC-01; conhecimento prévio, a verificar): um `authorize` montado pelo atacante sem `code_challenge`, com o nosso `redirect_to`, poderia devolver tokens no fragmento numa aba comum. A opção A não cria esse risco, e o hook limita a sessão a 24 h.

**Emenda da F1-SEC-01 (2026-11-11): threat model v2 e revisão adversarial de auth.** A tabela de ameaças acima e os residuais entraram no [threat-model](../threat-model.md) v2 (TB10, TB11, T41 a T48, SR-18 a SR-24 e §9), com o residual do chromiumapp (§4.4, "Emenda do 05c-1") e a observação do P14 (§4.5, "Emenda do 05c-3") no T48. A [revisao-adversarial-auth](../revisao-adversarial-auth.md) achou 7 pontos no código, nenhum crítico ou alto. O `[APPSEC]` não veta, e cada achado ficou ligado a um teste ou a uma tarefa:
- **D7, logout (A-01):** o "GoTrue 401 (já revogado) → 204" não se sustenta. O contrato do 07h mostrou o 403 `session_not_found` para a sessão encerrada, e o 401 sem o corpo do GoTrue vem do gateway (`Invalid API key`). A *BACKLOG §F1-API-08* emenda o D7 junto com o código;
- **D7, troca e renovação (A-02):** a regra do 404 ("só é recusa com o corpo JSON do GoTrue") se estende a 400, 401, 403 e 422 na mesma tarefa, depois de o job `db` confirmar o `error_code` desses status;
- **D8, *bulkhead* (A-03):** o *bulkhead* não tem partição. O teste novo prende o comportamento, e a F1-API-08 decide entre reservar uma vaga para a renovação ou aceitar o residual aqui;
- **D10 B2 (E-01), D11 (E-02 e E-03):** ficam na *BACKLOG §F1-EXT-07*.
A aprovação da v2 e da revisão é o *HITL-QUEUE §HITL-039* (CA-13).

**Emenda da F1-API-08 (2026-11-11):** o *HITL-QUEUE §HITL-039* foi aprovado pelo humano, e a CA-13 está cumprida. O A-01 e o A-02 foram fechados pela emenda do D7 e o A-03 pela do D8 item 5, com teste antes do código e mutação dirigida. O residual novo (proxy com JSON e `error_code` string) está no D7 e na §9 do [threat-model](../threat-model.md), e o P21 (§1.4) leva o 401 do gateway real ao S-3.

## 4. Plano de testes (`[QA_EVALS]`)

### 4.1 Unidade, extensão (Vitest)
`src/auth/**` e `src/api/**` entram no `include` de cobertura do `vitest.config.ts`, com 100% nas 4 métricas.
- **`pkce.ts`:**
  - vetor do RFC 7636, Apêndice B: o verifier `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` gera o challenge `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM` (errata de 2026-11-04, Trilha S3b: a versão anterior trazia `Melhoe2`; o valor foi conferido pelo `node:crypto` e pelo .NET);
  - 43 caracteres no alfabeto *unreserved*; fonte de entropia injetada;
  - sem `crypto.subtle`, lança; nunca `plain`.
- **`authorize-url.ts`:** parâmetros exatos e codificados; `code_challenge_method=s256`; nenhum `response_type`.
- **`redirect.ts` (`parseAuthRedirect`):** aceita só a forma exata. Recusa outro host, outro caminho, barra final, parâmetro extra ou repetido, fragmento com `access_token`, `code` ausente ou longo e `st` divergente. `error` ou `error_code` vira cancelamento, sem ecoar o texto.
  - **Emenda do HITL-035 (2026-11-06):** caso explícito: `https://<id>.chromiumapp.org/?code=…` (a raiz, destino do Site URL na opção A do D15) é recusado sem troca.
- **`auth-service.ts`** (relógio, `fetch`, store e `AuthCodeSource` falsos):
  - um fluxo por vez; o prazo de 5 min apaga o verifier; o verifier é apagado depois do envio, inclusive em erro;
  - troca 200 grava e emite; 401 dá `ERRO_INTERNO`; 429 dá `LIMITE_DE_TAXA`; 503 dá `SERVICO_INDISPONIVEL`;
  - **5 chamadas simultâneas com token vencido → exatamente 1 renovação** (contador no `fetch` falso);
  - renovação 401 apaga; 503 ou rede mantém, com uma única nova tentativa sequencial depois de 2 s; nenhuma nova tentativa depois de resposta HTTP;
  - **geração:** "Sair" durante uma renovação pendente deixa o storage vazio quando a renovação resolve;
  - logout apaga o local antes da chamada e mesmo com falha remota; renovação de logout não grava; falha remota faz **uma** repetição automática e emite `{ false, "SERVICO_INDISPONIVEL" }`;
  - cada linha da tabela do D12 vira um teste de unidade **nomeado pela linha** (CA-14);
  - login pendente (contingência): schema estrito, apagado no uso, no erro e no prazo;
  - logs só com motivos da lista fechada (argumentos conferidos).
- **`panel-state`:** "Analisar" desabilitado nas 7 combinações incompletas de API, sessão e consentimento; sem "Reconectar" em `resposta_invalida`; o "entrando" desliga aos 310 s com relógio falso; texto de "Sair" com falha remota só depois do clique em "Sair".
- **`session-schema`:** valor com chave extra `token` é apagado; `storage.local` e `sync` nunca são tocados.
- **`api-client.ts`:** opções exatas (`credentials`, `redirect`, `cache`, `referrerPolicy`, prazo, teto de resposta); recusa origem ou caminho fora da lista; Bearer só nas duas rotas.
- **`protocol`:** `entrar` com chave extra ou `provedor` desconhecido, `sair` com payload e `sessao` vinda do painel derrubam a porta. `sessao` com `token`, `email` ou `exp` é recusada. `{ autenticado: true, erro: "NAO_AUTENTICADO" }` é recusado. `expectTypeOf<SessaoView>` sem campo `string` livre.
- **Teste de unidade da captura depois do login:** com uma sessão gravada, o `executeScript` recebe exatamente `[EXTRACTION_LIMITS, platform]`.
- **Lint e depcruise:** `RuleTester` com fixtures negativas para cada regra do B1 e do B2 (cada uma precisa falhar), e teste das regras novas do depcruise.

### 4.2 Unidade e integração, API (Fastify `inject` e GoTrue simulado em socket real em `127.0.0.1`)
O GoTrue simulado segue o padrão do Redis simulado do ADR-014. O JWKS fica em `/auth/v1/.well-known/jwks.json`, com chave ES256 de teste, e o `iss` dos tokens falsos é exatamente `SUPABASE_URL + "/auth/v1"` (`auth-env.ts` L8-28).
- **`PUBLIC_ROUTES`** exata. `/v1/auth/exchange/`, `%61uth`, `GET` e `PUT` ficam fora, com a semântica atual (401 ou 403).
- **CORS:** a origem da extensão alcança só as 4 rotas; origem web em `/v1/auth/*` dá 403; **sem `Origin` nas públicas dá 403**; preflight passa; `GET /v1/criteria` vindo da extensão continua 403.
- **Corpo:** acima de 2.048 dá 413 sem parse; tipo errado dá 415; chave extra dá 400.
- **Limitador local:** a 11ª troca no mesmo minuto dá 429 com `Retry-After`; o transbordo funciona; **0 comandos no Redis falso antes do JWT**; as chaves em memória são HMAC (SR-17 por analogia).
- **Proxy:** com `trustProxy` configurado, dois `X-Forwarded-For` distintos vindos do proxy confiável caem em baldes distintos; `X-Forwarded-For` vindo de IP não confiável é ignorado; `API_BEHIND_PROXY=true` com `TRUST_PROXY` vazio derruba o boot.
- **Orçamento de saída:** uma inundação de trocas com códigos bem formados e falsos não impede a renovação com envelope válido; 10.000 envelopes forjados consomem 0 do orçamento; o transbordo dos baldes não derruba a partição `renovacao`; o *replay* do mesmo envelope genuíno fica limitado pelo orçamento.
- ***Bulkhead*:** a 5ª chamada simultânea ao GoTrue dá 503 com `retryAfterSeconds: 5`.
- **Envelope:** blob aleatório, tag adulterada, `kid` desconhecido e AAD de outra origem dão 401 com **0 chamadas ao GoTrue**; `sst` além da idade máxima e `iat` além da inatividade dão 401 com **0 chamadas**; `sid` divergente dá 401 depois de 1 chamada, sem selar o refresh novo; o boot falha com anel inválido; o pior caso do texto claro cabe no `SealedRefreshSchema`. **Emenda da revisão da F1-AUTH-00 (2026-11-06):** tag ou cifrado em base64url não canônica dá 401 com **0 chamadas**; o boot recusa `kid` fora de `[a-z0-9]{1,16}`; um `rt` cujo texto claro passa de 768 bytes não é selado (503); um token com 899 s de idade dá `expiresIn` 1, e com 900 e 909 s dá 503 `auth_token_fora_da_politica`, nunca 200 nem 500 (D4, troca, passo 8).
- **GoTrue:** recusas conforme a emenda abaixo; "não recebeu" dá 503 com **exatamente 1 chamada**; na renovação, o simulado que rotaciona e responde depois do prazo (ou com JSON inválido) gera **exatamente 2 chamadas** com o mesmo `rt` em até 2 s; na troca, sempre 1.
  - **Emenda do HITL-035 (2026-11-06)**, no lugar de "400 `invalid_grant` dá 401 com o mesmo corpo para código inválido, verifier errado e reuso":
    - o simulado aceita só `{ auth_code, code_verifier }`, e o campo `code` dá 400 (derruba um adapter que mande `code`);
    - o reuso responde 404 `{ error_code: "flow_state_not_found" }`, como no pré-spike;
    - sem verifier, verifier errado e código vencido são parametrizados em 400, 401, 403, 404 e 422 com corpo JSON do GoTrue (os status reais não foram informados), e todos dão o mesmo 401;
    - caso novo: 404 sem o corpo do GoTrue dá 503 com exatamente 1 chamada na troca e, na renovação, 503 sem apagar nada;
    - a resposta 200 do simulado é hipótese até o P9.
- **Verificação antes de repassar:** token HS256, anônimo, sem `session_id`, com mais de 900 s de idade, com `expires_in` 3600 ou `exp − iat` de 3600, ou com `amr` sem `oauth` não é repassado (503). Na API, tokens com `amr` `password` ou `otp` dão 401, e `password` só passa com `NODE_ENV=test`.
- **Rotas públicas ignoram `Authorization`:** troca e renovação com `Authorization: Bearer <canário>` se comportam como sem o header, e o canário não aparece em log.
- **Logs amostrados:** 1.000 recusas em 1 min geram no máximo 1 linha por motivo, com o contador de suprimidas.
- **JWKS:** sem chaves na pré-checagem, 503 com **0 chamadas ao GoTrue** na troca e na renovação.
- **Resposta:** exatamente 4 chaves e `Cache-Control: no-store` em 200 e nos erros. A resposta simulada do GoTrue com `provider_token`, `user` e e-mail canários não aparece na resposta nem nos logs.
- **Logout:** exige Bearer; chama `logout?scope=global` com o Bearer do usuário; responde 204; GoTrue 401 dá 204; 5xx dá 503.
- **SR-12:** canário de código, verifier, `state`, access, refresh cru, envelope, `provider_token`, `sub` e IP ausente de toda linha de log nos caminhos 200, 401, 429 e 503.
- **`AUTH_SPIKE_CONFORMANCE_REPORT`:** o boot recusa com `NODE_ENV=production`; o relatório só tem booleanos e faixa.
- **Fixtures novas** (JWS, envelopes, anel de teste) entram na allowlist do `.gitleaks.toml` por valor exato (§4.8).

### 4.3 Contrato contra o GoTrue local (job `db` do CI)
- O `supabase/config.toml` passa a espelhar a produção: `jwt_expiry = 900` e chave ES256 em `signing_keys_path`, **gerada no próprio job e nunca versionada** (o comando da CLI fica a verificar). E-mail e senha seguem ligados só na pilha local, por causa do `test:db`.
- Provas:
  - o token local passa no `JoseAccessTokenVerifier` real só com `password` liberado por `NODE_ENV=test`; com `AUTH_ALLOWED_AMR=oauth`, dá 401;
  - o `GotrueTokenClient` renova e faz logout contra o GoTrue de verdade, não só contra o simulado;
  - rotação (P10 em CI): o reuso do pai do token ativo devolve o ativo, também depois de 10 s; o reuso de um ancestral mais velho, depois de 10 s, revoga a cadeia;
  - `logout?scope=global` invalida o refresh (P11 em CI).
- **Opcional (P7 e P8 em CI):** `grant_type=pkce` real por *magic link* (exige tirar o `mailpit` do `supabase start -x` do CI) ou por um provedor OIDC falso.
- **Emenda do HITL-035 (2026-11-06):** o `config.toml` local liga o Custom Access Token Hook (D5, F1-DB-02), e um teste prova a recusa da renovação quando `auth.sessions.created_at` passa da idade máxima (a forma de envelhecer a sessão fica a verificar). Os limites reais do P19 (150 e 30) são iguais aos locais. O opcional acima pode cobrir a ressalva de evidência do P8 (§1.4).
- **Emenda do 07h (F1-API-07, 2026-11-07, `4efd96c`; ADR-019 §3.4):**
  - **chave:** o comando da CLI ficou de fora. O `apps/api/test/db/support/write-signing-key.ts` roda no Node do job antes do `supabase start` e grava `supabase/signing_keys.json` (lista com uma JWK ES256 privada, `kid` aleatório, modo 0600, `wx`: nunca sobrescreve; destino só com esse nome). O arquivo está no `.gitignore` e na regra `trampo-auth-seal-keys-files` do gitleaks. O `config.toml` tem `jwt_expiry = 900` e `signing_keys_path = "./signing_keys.json"`, e o `@trampo/ci-policy` prende os dois, a rotação, o reuso de 10 s, os limites 150 e 30 e a ordem "chave antes do start";
  - **contrato** (`test/db/auth-contract.db.test.ts`): o token sai com `alg` ES256 e o `kid` gerado no job; o JWKS público tem a chave e nenhum `d` nem `k`; `expires_in` 900 e `exp − iat` 900 no verificador real; `password` só pelo `readAllowedAmr` com `NODE_ENV=test`; com `oauth`, `token_invalido` e **401 pela borda real** (`createAuthHook`); o `GotrueTokenClient` renova (4 campos, mesma sessão) e recusa refresh desconhecido; `pkce` com código desconhecido é `recusado` (404 com o corpo do GoTrue, D7); P10 e P11 como no texto acima;
  - **P10 nos dois algoritmos do GoTrue:** no v1, um token revogado há menos de 10 s ainda troca, mesmo depois da revogação da cadeia. A prova da cadeia caída espera o intervalo de reuso também depois do reuso do ancestral (no v2, a sessão já foi apagada e a recusa vale na hora);
  - **achado do logout repetido:** o GoTrue atual responde **403 `session_not_found`** ao JWT de uma sessão já apagada (`maybeLoadUserOrSession`), não 401. O adapter passou a tratar só esse `error_code`, exato e lido do corpo JSON com teto, como sessão encerrada (204, D7 idempotente). O `bad_jwt` e o resto do 403 seguem `recusado`. O simulado agora responde como o GoTrue;
  - **o que só roda no CI:** o contrato e a sonda precisam da pilha local (a estação não tem o *daemon* do Docker). Localmente rodaram o gerador da chave (de verdade, num diretório temporário), a contagem da sonda (`rate-limit-probe.ts`, 100% no `pnpm test`), o 403 do adapter no simulado e o typecheck e o lint dos testes do `test:db`. A confirmação é o job `db` do PR #17.
  - **Confirmado no CI (2026-11-07):** o run `42397764768` (`4efd96c`) passou em 71 dos 72 casos do `test:db` contra o GoTrue real, inclusive a chave do job, os 900 s, o P10, o P11 e o logout repetido com 403 `session_not_found`. O caso "pela borda real" falhou por um erro do próprio teste: um Fastify mínimo sem o `buildApp` devolvia 500. Corrigido em `316da68`, com o `buildApp` e o `openLimits`. No run `42398183789`, os 4 jobs ficaram verdes (`secrets` com as regras novas no histórico inteiro, sem achado; `db` com os 72 casos e a cobertura de 100%). O `groupOrder` não segurou a ordem dos grupos do `test:db` (a sonda rodou antes do contrato), então a sonda, em modo ativo, devolve o balde cheio antes de terminar.
- **Emenda da F1-API-08 (2026-11-11):** 9 casos novos no `auth-contract.db.test.ts` conferem o corpo `{ code, error_code, msg }` de cada recusa real (troca 400 `validation_failed`, 404 `flow_state_not_found`, 400 `bad_code_verifier` e 422 `flow_state_expired`; renovação 400; logout 403 `bad_jwt`, 403 `session_not_found` e sem Bearer) e o `recusado` do adapter onde ele alcança. O verifier errado e o fluxo vencido usam um fluxo gravado direto em `auth.flow_state` pelo `psql` como `postgres` (`insertPkceFlow` em `test/db/support/auth-stack.ts`; o privilégio vem do padrão do `supabase_auth_admin` para o `postgres`). Um caso prende o limite do job: o Kong local não confere a `apikey` em `/auth/v1/`. Os casos foram escritos e conferidos por typecheck e lint; a 1ª execução é a do job `db` no PR do 4º ciclo do *HITL-QUEUE §HITL-037*.

- **Correção do 1º run no PR #21 (sessão 21, `4bf1e40`):** os 9 casos da F1-API-08 rodaram pela 1ª vez no run `43129891448`, e 4 caíram por causa das sondas, não do adapter. No GoTrue v2.197.0, o refresh que não tem a forma legada (12 caracteres `[a-z0-9]`) nem a nova assinada é recusado com 400 `validation_failed` antes da busca, e o `FlowState` lê `provider_access_token` e `provider_refresh_token` como `string` (nulo no banco dá 500 na troca). O refresh desconhecido passou a ter a forma legada, a sonda antiga virou o 10º caso (`validation_failed`, `recusado` no adapter), e o `insertPkceFlow` grava texto vazio. Verde no run `43142012159`.
- **Emenda da F1-DB-02 (2026-11-12, `cf5fe64`; [ADR-026-custom-access-token-hook](ADR-026-custom-access-token-hook.md) §4):** o `config.toml` local liga o hook (`pg-functions://postgres/trampo_hooks/custom_access_token`), e o `@trampo/ci-policy` prende o bloco (único hook de auth, URI exata, sem `[auth.sessions]`). O `auth-hook.db.test.ts` (54 casos) responde o "a verificar" da emenda do HITL-035:
  - **a forma de envelhecer a sessão:** `update auth.sessions set created_at = …` pela conexão do `supabase_auth_admin` (a do GoTrue local, com a senha do banco local; ele é o dono da tabela). O GoTrue não guarda a data: a função lê `auth.sessions` a cada emissão, dentro da transação do token;
  - **a recusa na renovação:** 403 `{ code, error_code: "unknown", msg }` do GoTrue, `recusado` no adapter e **401 `NAO_AUTENTICADO` em `POST /v1/auth/refresh`** com o `composeApp` de pé contra a pilha local, numa sessão criada pela troca PKCE (`insertPkceFlow`), nunca 503. A recusa não consome o refresh;
  - **a recusa na emissão inicial:** não alcançável (a sessão nasce na transação do hook). O limite exato (86.400 s passa; 86.401 s e 86.400 s mais 1 microssegundo recusam) é provado com a função chamada direto, numa transação só;
  - **a constante:** o `secs => N` lido do `pg_get_functiondef` é igual ao padrão do `AUTH_SESSION_MAX_AGE_SECONDS`;
  - **grants:** ACL exata do schema e da função, RPC (404 `PGRST202` e 406 `PGRST106`) e SQL por papel (`42501`);
  - **falha fechada:** com a função trocada por uma que lança (`P0001` e `PT403`), nenhuma emissão sai, o adapter diz `nao_recebido` e o BFF 503; o teste restaura a função pela própria migration (idempotente) e confere o `md5` da definição.
  - **O que rodou onde:** na estação, só a pilha simulada (Postgres 17.11 e PostgREST 16.4 reais, com um GoTrue simulado pelo código-fonte), com 115/115 e a mutação da migration (35/36, 1 equivalente). **A 1ª execução contra o GoTrue de verdade é o job `db` do PR do 7º ciclo do *HITL-QUEUE §HITL-037*.**

### 4.4 E2E local com IdP falso (Playwright, build de produção, Edge headless como hoje, e Chrome via `TRAMPO_E2E_BROWSER`)
- **Roda local, fora do CI, como hoje** (§1.2), com o critério da CA-16.

**Topologia:**
- `https://localhost:47443`: o servidor do `global-setup` vira **BFF falso** (`/v1/auth/exchange`, `/v1/auth/refresh`, `/v1/auth/logout` e, quando o F1-EXT-04 parte 2 existir, `/v1/analyze`), com contadores.
- `https://localhost:47444`: **Supabase falso**, numa origem separada. O `/auth/v1/authorize` valida os parâmetros (`s256`, challenge com 43 caracteres, `redirect_to` exato), guarda o challenge e responde 302 para `https://<id>.chromiumapp.org/auth?code=CANARIO-CODE-<uuid>&st=<eco>`.
- O BFF falso confere `S256(verifier)` contra o challenge visto no `authorize` (estado compartilhado no processo do teste), código de uso único com 5 min, e registra o verifier recebido.
- **Canários** são os valores exatos emitidos pelos falsos: o access inteiro e cada um dos 3 segmentos (com `sub` e `session_id` canários no payload); o envelope `r1.<kid>.<iv>.CANARIO_RT_<hex>.<tag>` inteiro e o segmento cifrado; o código; o verifier recebido; e `error_description=CANARIO-ERR-<uuid>` no cenário 8. Os coletores procuram a forma crua, a de `encodeURIComponent` e a de JSON escapado. A regex de 100+ caracteres é só reforço.
- O Supabase falso conta **toda** requisição com `Origin: chrome-extension://…` em qualquer caminho (`/auth/v1/token`, `/rest/v1/*`, `/auth/v1/otp`): precisa ficar em 0. Só a navegação da janela toca o `/authorize`. Isso prova o SR-02 no E2E.
- `--host-resolver-rules` mapeia `*.chromiumapp.org` para um servidor HTTPS local com contador, que precisa ficar em 0 (sintaxe a verificar). O teste registra a abertura e o fechamento da janela.
- O BFF **real** não roda no E2E da extensão (o depcruise proíbe importar `apps/api`). A ida e volta real fica no §4.2 e no §4.3.
- O storage é lido por CDP `Extensions.getStorageItems`.

**Build:**
- `TRAMPO_API_ORIGIN=https://localhost:47443` e `TRAMPO_SUPABASE_ORIGIN=https://localhost:47444`.
- **Chave de teste efêmera** gerada no `global-setup` (que já usa `openssl`), para o ID ser conhecido antes do launch (P17). Ela nunca sai da pasta temporária e não depende do HITL-035 parte 1.

**Modo do headless (P20), fixo por navegador, nunca escolhido em runtime:**
1. `launchWebAuthFlow` real em headless, com o 302 imediato do Supabase falso.
2. Headed: nativo no Windows; `xvfb` no Linux.
3. Build `TRAMPO_E2E_FAKE_IDENTITY=1`, com um adapter falso da `AuthCodeSource`, sem rede. Ele devolve o retorno roteirizado em `trampo/e2e/retorno`, gravado pelo teste por CDP `Extensions.setStorageItems`, ou, sem roteiro, `https://<id>.chromiumapp.org/auth?code=CANARIO-CODE-<HMAC(segredoDeTeste, challenge)>`. O BFF falso valida código, challenge e verifier, então o PKCE continua provado de ponta a ponta. Só no build de teste: o `wxt.config.ts` recusa a flag sem `TRAMPO_E2E=1` (§4.6).
   - **Emenda do HITL-035 (2026-11-06):** o HMAC do canário vai em **hex**, porque o `AuthCodeSchema` mantido (D7) não aceita o `_` do base64url.
- O login real com GitHub e Google, no Chrome e no Edge, contra o projeto real, fica como roteiro manual guiado (HITL-034 Q8), registrado no *spike-metrics* §4. A CA-02 declara o que fica só nesse roteiro.
- **Emenda do 05c-1 (2026-11-09): modo 1 nos dois navegadores.** A sondagem com o build de produção, a chave efêmera e o 302 imediato do Supabase falso, em headless, resolveu o `launchWebAuthFlow({ interactive: true })` real no Edge 157.0.4341.42 (53 ms) e no Chrome 156.0.8078.80 (73 ms), sem janela nova e com 0 pedidos no chromiumapp local. A navegação do `authorize` chega sem `Origin`, com `Sec-Fetch-Mode: navigate` e `Sec-Fetch-Site: cross-site`.
  - os dois ficam no modo 1, fixos na tabela `test/e2e/support/p20.ts` (pelo nome do executável, nunca por sondagem em runtime); navegador fora dela não roda o E2E de login, e um navegador que mude de modo passa por sondagem nova e emenda deste parágrafo;
  - o modo 3 ficou sem código: o `build-env.ts` recusa `TRAMPO_E2E_FAKE_IDENTITY` sem `TRAMPO_E2E=1` (§4.6) e também com ele, porque o adapter falso não existe. Sozinho, o `TRAMPO_E2E` não muda o build. O E2E roda o adapter de produção (`web-auth-flow-source.ts`) de ponta a ponta;
  - o `--host-resolver-rules=MAP *.chromiumapp.org 127.0.0.1:<porta>` funciona: uma aba comum aberta em `controle.chromiumapp.org` chega ao servidor local (o controle positivo; o mutante que tira a regra só morreu com ele);
  - **achado: o "0 no chromiumapp" da topologia não é garantia.** Com a conexão ao host do retorno já aquecida (o 1º controle usava o mesmo host), o `GET /auth?code=…&st=…` do 302 chegou ao servidor local antes de o `launchWebAuthFlow` abortar a navegação, em 3 de 3 rodadas; com o host frio, deu 0 em todas. O navegador intercepta o retorno, mas pode já ter mandado o pedido. O E2E passou a medir, e não a zerar: no máximo um `GET /auth` por login, sem `Origin`, `Authorization` nem `Cookie`, e o login sempre sai da URL interceptada (o servidor responde 404). **`[APPSEC]`:** sem veto. O `<id>.chromiumapp.org` não resolve na DNS pública (NXDOMAIN, conferido em 2026-11-09), então em produção o pedido morre no DNS. Um resolvedor hostil na máquina do usuário veria só o código, inútil sem o verifier, que nunca sai do SW (PKCE, SR-18), com uso único e 5 min. O residual entra no T48 e vai para a F1-SEC-01, e o spike manual (P14) confere o DNS no Edge e no Chrome;
  - o mutante `interactive: false` sobrevive ao E2E (com o 302 imediato, o modo não interativo também resolve) e morre na unidade do adapter, que exige `interactive: true`.
- **Emenda do 05c-1: falsos e storage.**
  - o BFF falso e o Supabase falso sobem no `global-setup`, num só processo (o `authorize` guarda o challenge que a troca confere). Os testes rodam em outro processo e leem e zeram o estado por um canal de controle HTTP em `127.0.0.1`, com segredo gerado na hora;
  - o registro de cada pedido guarda servidor, método, caminho (sem a query), origem e a presença de `Authorization` e `Cookie`, nunca o valor;
  - o BFF falso só responde à origem exata da extensão (403 sem CORS para o resto), com o preflight de `authorization` e `content-type` e o `bodyLimit` de 2.048. Ele não é mais permissivo que o BFF real;
  - o `Extensions.getStorageItems` só responde pela sessão CDP anexada a uma página da própria extensão (o painel). Pela sessão do navegador dá "No associated browser context", e pela de uma página comum, "Extension not found" (Edge 157).
- **Emenda do 05c-2 (2026-11-09): roteiro dos falsos e ciclo de vida.**
  - **roteiro**, só pelo canal de controle e com o segredo: `POST /roteiro` com `{ authorize?: "segurar" | "cancelar" | "outro_caminho" | "fragmento" | "outro_challenge", logout503?: 1 a 5 }`, em `strictObject` e com teto de 256 bytes. O do `authorize` vale para o próximo pedido **válido** e é consumido nele: os 4 parâmetros são sempre conferidos antes, e o pedido recusado não o gasta. O 503 do logout só sai depois do corpo e do Bearer vivo conferidos, e a sessão segue viva no servidor;
  - **a troca e a renovação não têm roteiro.** O "código de outro challenge" nasce no `authorize`, ligado ao S256 de um valor que nenhum SW tem, e a troca o recusa por `verifier_divergente`. Os falsos ficam mais hostis e nunca mais permissivos (condição 2 do `[APPSEC]`, §6.3 item 5). O `/estado` traz o `roteiro` que de fato agiu, na ordem;
  - **302 segurado:** o Supabase falso guarda a resposta até o `POST /soltar`, e o `/estado` conta os `segurados`. O `/zerar` encerra o que estiver preso com 410, para nenhum socket ficar aberto;
  - **cancelamento** como o GoTrue no PKCE: `?st=<eco>&error=access_denied&error_code=access_denied&error_description=CANARIO-ERR-<uuid>`, na query do `redirect_to`, sem código;
  - **cada retorno roteirizado passa, na unidade, pelo `parseAuthRedirect` real:** o `segurar` e o `outro_challenge` dão `ok`, o `cancelar` dá `cancelado`, e o `outro_caminho` e o `fragmento` dão `recusado`, com um código que valeria na troca. O E2E prova a barreira do SW, e não um retorno mal formado;
  - **SW parado:** o `Target.closeTarget` do 05b-3, agora `stopWorker` no `browser.ts`. Com o 302 segurado, o login não abriu janela nem aba (Edge 157 e Chrome 156), nem depois do 302 solto;
  - **recargas e reinício:** `chrome.runtime.reload()` pelo SW, novo `loadUnpacked` no mesmo caminho, e o navegador fechado e relançado com o mesmo perfil. O teste espera o `close` do SW antigo, abre o painel numa página nova (a porta acorda o SW) e só então pega o SW novo. A forma por `runtime.reload()` fica numa tabela fixa por navegador no teste (Edge sim, Chrome não; §1.4, "Emenda do 05c-2"), nunca sondada em runtime;
  - **localStorage e IndexedDB** da origem por CDP (`DOMStorage.getDOMStorageItems` e `IndexedDB.requestDatabaseNames` com o `storageKey`, pela sessão do painel), com o controle positivo de um item e um banco gravados e apagados pelo teste;
  - **observador da sessão:** uma 2ª porta na página do painel guarda cada `sessao` emitida depois do handshake, e o teste confere a `SessaoView` exata de cada tentativa, e não só o texto.

**Cenários:**
1. **Login feliz:** clique em "Entrar com GitHub" até `sessao{ true, null }`; `trampo/sessao/v1` presente; `local` e `sync` vazios. **Aplicado no 05c-1 (2026-11-09):** com o par exato que o BFF falso emitiu no storage, sem janela nova, o PKCE conferido no BFF falso e um 2º login com o Google depois do "Sair" (código e verifier novos).
2. **Logout:** "Sair" deixa o storage vazio na hora; o BFF falso recebe o logout com Bearer; depois do "Sair", **0** `POST /v1/auth/refresh` com o envelope antigo. A revogação real fica no §4.3 (P11). **Aplicado no 05c-1 (2026-11-09).**
3. **Expiração com chamadas paralelas** (depende do F1-EXT-04 parte 2): `expiresIn` curto e N=5 chamadas autenticadas simultâneas geram exatamente 1 renovação no contador.
4. **Revogação** (depende do F1-EXT-04 parte 2): o BFF falso responde 401 na renovação; o painel recebe `sessao{ false, "NAO_AUTENTICADO" }`; o storage fica limpo.
5. **BFF fora** (depende do F1-EXT-04 parte 2): 503 ou prazo na renovação mantém `autenticado: true` com `SERVICO_INDISPONIVEL`, e **0 novos hits** no `/authorize`.
   - No F1-EXT-05, os cenários 3, 4 e 5 ficam provados pela unidade do `auth-service` (§4.1).
6. **Reinício e recarga:** recarregar por `chrome.runtime.reload()` ou por novo `loadUnpacked` no mesmo caminho, e relançar o contexto com o perfil preservado e o mesmo ID. Exige `sessao{ false, null }` e `session`, `local`, `sync`, IndexedDB e localStorage vazios (P13). **Aplicado no 05c-2 (2026-11-09):** as três formas no Edge 157, e o `loadUnpacked` e o reinício no Chrome 156 (§1.4, "Emenda do 05c-2").
7. **Retorno adulterado:** outro caminho, fragmento `#access_token=` ou código de outro challenge dão login recusado, `ERRO_INTERNO` e storage inalterado, com **0 hits** na troca nos dois primeiros casos. **Aplicado no 05c-2 (2026-11-09):** o código de outro challenge é o controle positivo dos dois 0 (1 troca, recusada por `verifier_divergente`).
8. **Cancelamento:** `?error=access_denied&error_code=<código>&error_description=CANARIO-ERR-<uuid>` no retorno dá `sessao{ false, null }`, sem o texto na tela nem nos coletores. **Aplicado no 05c-2 (2026-11-09):** o canário fica fora da tela e do storage; o console ficou para o 05c-3, que o conferiu em todo alvo (§4.5 item 9, "Emenda do 05c-3").
9. **Canais externos fechados:** `runtime.sendMessage` avulso falha com "Receiving end does not exist" (como hoje), e uma página de outra origem não tem `chrome.runtime` para a extensão (`matches` vazio). **Aplicado no 05c-2 (2026-11-09)** no build com a chave, com e sem o ID no `sendMessage`; o painel, que enxerga o `sendMessage`, é o controle positivo.
10. **Handshake:** sequência exata `[ready, captura, consentimento, sessao]`. **Aplicado no 05c-1 (2026-11-09)** com a sessão aberta: `sessao{ true, null }` no fim.
11. **Reconectar:** com a porta fechada pelo SW, o botão "Reconectar" refaz o handshake. **Aplicado no 05b-3 (2026-11-09):** com a porta falsa (porta nova, `hello` novo e porta antiga ignorada) e com o SW real parado por `Target.closeTarget`.
12. **Bearer só onde deve** (quando o F1-EXT-04 parte 2 existir): a análise leva `Authorization` só em `/v1/analyze`.
13. **SW parado por CDP** (forma a verificar para SW de extensão): com sessão, ela sobrevive ao handshake; com o 302 do login segurado, dá 0 trocas e `sessao{ false, null }` depois de "Reconectar". Com CDP anexado o SW não suspende sozinho, então o P12 fica no spike manual, sem DevTools. **Forma achada no 05b-3 (2026-11-09):** no Edge 157 headless, o `Target.closeTarget` no alvo `service_worker` da extensão, pela sessão CDP do navegador, para o SW e derruba a porta do painel; o `runtime.connect` do "Reconectar" acorda o SW. O resto do cenário segue na F1-EXT-05c. **Aplicado no 05c-2 (2026-11-09):** o controle positivo do "0 trocas" é o 302 segurado e solto com o SW vivo, que completa o login.
14. **Logout com falha remota:** o BFF falso responde 503 ao logout; 2 chamadas (uma repetição) e `sessao{ false, "SERVICO_INDISPONIVEL" }` com o texto de "Sair" e o botão de repetir. **Aplicado no 05c-2 (2026-11-09):** o "Tentar sair de novo" encerra no servidor com o mesmo Bearer, que seguia vivo (3ª chamada, 204).

**Emenda do 04b-3 (F1-EXT-04 parte 2, 2026-11-12): os cenários 3, 4, 5 e 12 com o envio.** O desenho dos falsos está no [ADR-025-side-panel-ui](ADR-025-side-panel-ui.md) §6.5; os cenários rodam no `analysis.e2e.test.ts`, no build `auth`.
- **BFF falso com o `POST /v1/analyze` em SSE**, nunca mais permissivo que a API: origem exata, corpo até 64 KiB, `content-type: application/json`, `Authorization: Bearer` igual ao access de uma sessão viva no falso (emitido por ele e não girado, encerrado nem revogado) e o corpo no `AnalyzeJobRequestSchema` estrito. O registro de cada análise guarda o `requestId`, o modo, a plataforma, a contagem e o SHA-256 do texto e o índice do access na lista dos emitidos, nunca o token nem o texto.
- **Roteiro, só depois das barreiras:** a fila `analyze` (`401`, `503`, `fora_do_contrato`, `silencio`, `keep_alive`, `depois_do_resultado`, `event_divergente` e `grande_demais`) e a fila `refresh` (`503` e `segurar`), mais o `expiresIn` dos próximos pares e o `POST /revogar` do canal de controle (o logout em outro dispositivo, D11.6). **A regra do 05c-2 muda só para a renovação:** ela passa a ter roteiro, porque os cenários 3 e 5 pedem a renovação lenta e a renovação fora; os dois passos só recusam ou atrasam o que o falso aceitaria. A troca continua sem roteiro. Cada stream roteirizado passa, na unidade, pelo leitor de verdade do SW (`createSseReader`).
- **Cenário 3, forma nova.** O `analysis-service` aceita uma análise por vez (ADR-025 §6 D10), então "N=5 chamadas autenticadas simultâneas" deixou de existir como estava escrito: 4 dos 5 cliques são ignorados antes do `accessToken()`. O *single-flight* fica provado assim: `expiresIn` de 30 s (abaixo do limiar de 60 s) e a renovação `segurar`; 5 painéis clicam em "Analisar vaga" ao mesmo tempo (1 análise aceita, 1 renovação presa); a vaga muda, o que cancela a análise com o `accessToken()` dela ainda esperando; os 5 painéis clicam de novo, e a análise nova se junta à mesma renovação; o `soltar` gira o par uma vez. **Exatamente 1 renovação e 1 análise no contador do BFF falso**, com o access renovado, que é o da sessão gravada, e o mesmo relatório nos 5 painéis. O controle positivo: sem a renovação presa, cada análise faz a sua (2 no total). O mutante que tira o *single-flight* do `auth-service` morre neste cenário (X-12).
- **Cenário 4, três caminhos:**
  - a sessão revogada no falso, com o token ainda "válido" no SW: a análise leva 401, a renovação leva 401, a sessão é apagada (`sessao{ false, "NAO_AUTENTICADO" }`, storage limpo), e a análise mostra `NAO_AUTENTICADO`, sem reenvio;
  - pela análise: 401, renovação 200 e 401 de novo. O `onUnauthorized(2)` apaga a sessão, e não há 3º envio (o mesmo `requestId` nos dois);
  - pela renovação antes do envio (`expiresIn` de 30 s e a sessão revogada): a sessão é apagada do mesmo jeito, nada sai para o `/v1/analyze`, e a análise mostra `SERVICO_INDISPONIVEL` (ADR-025 §6 D10, portão 4: sem token, a análise nunca diz `NAO_AUTENTICADO`). A área da sessão mostra o `NAO_AUTENTICADO`. **Achado de UX**, sem risco de segurança: os dois textos se contradizem; virou a *BACKLOG §F1-EXT-08*.
- **Cenário 5:** com `expiresIn` de 1 s (o token guardado já venceu quando a renovação falha), o 503 na renovação mantém `sessao{ true, "SERVICO_INDISPONIVEL" }` e o mesmo par no storage, a análise mostra `SERVICO_INDISPONIVEL`, nada sai para o `/v1/analyze`, e o `/authorize` tem 0 hits novos; a análise seguinte renova e volta a `{ true, null }` (o controle positivo). O prazo é a renovação `segurar` duas vezes, nunca solta: 10 s, 2 s de espera e mais 10 s (D11.3), e o SW desiste das duas sem que nada gire no falso.
- **Cenário 12:** no total do que o BFF falso recebeu, o `Authorization` vai só no `POST /v1/analyze` e no `POST /v1/auth/logout`, nunca na troca nem na renovação (`requestViolations`, agora com a regra da análise), e o access de cada análise é exatamente o da sessão gravada (no reenvio do 401, o renovado). O controle positivo é uma renovação com `Authorization` mandada pelo próprio teste, que fere a regra.
- **Stream e cancelamento, fora da lista de cenários:** os estágios e o relatório; o 401 com um reenvio do mesmo `requestId` e do token renovado; o 503 com `ApiError`; o corpo de erro fora do contrato; as 4 formas de stream fora do servidor (todas `ERRO_INTERNO`, sem relatório na tela); o servidor em silêncio até o prazo real de 20 s do SW (o único teste que espera o prazo, com o tempo medido); e o servidor em silêncio com a retirada do consentimento ou com a vaga trocada, em que o BFF falso vê a conexão fechar na hora (`analises.abortadas`).
- **`[APPSEC]`:** sem veto. As 5 condições do ADR-025 §6.5 estão cumpridas; nada em `src/` mudou nesta parte.

### 4.5 Provas negativas: o token nunca chega ao painel nem ao extrator
Rodam depois de todos os cenários do §4.4 (SR-23), com os canários do §4.4 nas três formas:
1. **Espião no painel** (`addInitScript`): registra todas as mensagens da porta, sem canário. Envolve também `storage.session.get`, `getKeys`, `storage.onChanged`, `storage.session.onChanged`, `runtime.onMessage`, as mensagens de `navigator.serviceWorker`, `BroadcastChannel` e o `message` da `window`, e exige **0 chamadas**.
2. `document.body.innerText` e os atributos do DOM do painel sem canário.
3. **Heap snapshot** por CDP do painel e da aba: nenhum segmento de canário com 16 caracteres ou mais. É a prova independente do canal.
4. **Rede do painel:** CDP Network ligado por *auto-attach* antes do `goto`. **0 requisições com URL fora de `chrome-extension://<id>/`**, medidas antes do `fetch` proposital do item 5.
5. **Meta CSP:** um `fetch` do painel para o BFF falso dispara `securitypolicyviolation` com `effectiveDirective` igual a `connect-src`, com 0 hits; um `submit` dispara `form-action`, e um `innerHTML` lança por Trusted Types (P16). O `csp.e2e.test.ts` (L105-122) é emendado: o painel deixa de alcançar a API, e o SW continua alcançando só ela. **Aplicado no 05b-1 (2026-11-08)**, contra a API falsa do E2E atual, e não contra o BFF falso (ver D10 B4, "Emenda do 05b-1"). Os outros itens seguem para a F1-EXT-05c.
6. Na aba da vaga (fixture), depois de uma captura com sessão ativa: DOM e propriedades de `window`, nos mundos MAIN e ISOLATED, sem canário.
7. `chrome.storage.session.get` chamado no mundo ISOLATED da aba falha por contexto não confiável (padrão `TRUSTED_CONTEXTS`, §1.1).
8. **Origem da extensão sem resto:** `storage.local` e `storage.sync` vazios; localStorage, IndexedDB e CacheStorage vazios (CDP `DOMStorage`, `IndexedDB.requestDatabaseNames` e `CacheStorage.requestCacheNames`).
9. **Console:** *auto-attach* a cada alvo (`service_worker` e `page`) com `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` e `Log.entryAdded`, sem canário.
10. **O que os falsos recebem:** troca e renovação sem `Authorization` e sem `Cookie`; logout com Bearer; Supabase falso sem `Authorization`.
11. O argumento do `executeScript` fica provado pela unidade do §4.1. O heap snapshot da aba (item 3) cobre o runtime.

**Emenda do 05c-1 (2026-11-09):** os itens 2, 8 (só `local` e `sync`) e 10 já rodam dentro dos cenários 1 e 2, e o item 5 roda contra o BFF falso (o SW também não alcança o Supabase falso, fora do `connect-src`). O resto do §4.5 é do 05c-3, depois de todos os cenários (§6.3 item 5).

**Emenda do 05c-3 (2026-11-09): as provas negativas depois de todos os cenários.**
- **onde rodam:** no `auth-negative.e2e.test.ts`, num navegador só, com o build `auth`. Cada arquivo E2E tem o seu navegador, então "depois de todos os cenários" vale no navegador em que eles rodaram: o teste refaz em sequência os que geram canário (1 com o GitHub, 13, 14, 8, 7 nas três formas, 1 com o Google e a captura com a sessão ativa) e só então confere os itens. O cenário 6 troca o navegador (o P13 já prova a origem vazia depois dele, agora também com o CacheStorage), e o 9 não gera canário. Os controles positivos nunca são canários;
- **coletor próprio (itens 4 e 9):** a sessão CDP do Playwright não entrega as sessões filhas de um *auto-attach* `flatten`. O navegador desse arquivo abre também o `--remote-debugging-port=0` (só em 127.0.0.1, num perfil descartável e só nele), e o `cdp-tap.ts` liga o *auto-attach* no nível do navegador antes do `loadUnpacked`, com `waitForDebuggerOnStart`: todo SW e toda página nascem pausados até o Runtime, o Log e o Network estarem ligados, e as páginas repetem o *auto-attach* para os filhos. O pipe do Playwright e a porta convivem (Edge 157 e Chrome 156). O mutante que desliga o `waitForDebuggerOnStart` do coletor sobrevive: o Playwright também pausa todo alvo novo até se preparar, e o coletor fica coberto por essa pausa (equivalente no harness);
- **item 1:** o espião entra por `addInitScript` na página do painel, antes do `goto`, e envolve cada caminho: a porta nas duas direções; `storage.session.get` e `getKeys`; `storage.onChanged` e `storage.session.onChanged`; `runtime.onMessage`; as mensagens do `navigator.serviceWorker` por `addEventListener`, `onmessage`, `onmessageerror` e `startMessages`; o `BroadcastChannel`; e o `message` da `window` por `addEventListener`, `onmessage` e `onmessageerror`. Nenhuma API faltou, e todas deram 0. O controle positivo roda por último, porque o `get` dele traz a sessão ao painel e sujaria o heap: cada contador dá o número exato de caminhos dele;
- **item 3:** o heap snapshot (`HeapProfiler.takeHeapSnapshot`) do painel e o da aba, com a busca de cada trecho de 16 caracteres das três formas de cada canário nas sequências do alfabeto `[\w.%-]` com 16 caracteres ou mais (`support/leaks.ts`). Canário mais curto que o trecho, ou com caractere fora do alfabeto, é erro do teste. O heap da aba é um só para os mundos MAIN e ISOLATED: o controle plantado no ISOLATED aparece nele. **Achado da sondagem:** o snapshot não traz todo texto da página. Um texto montado por `join` e concatenação ficou fora dele, e um de 3.000 caracteres feito por concatenação simples ficou dentro (sem corte em 1.024). A prova do heap é reforço independente do canal, e os controles positivos usam a forma em que um canário chegaria ao painel (texto plano de mensagem ou de JSON);
- **item 4:** a rede do painel e dos filhos dele, ligada antes do `goto`. O SW aparece como filho da sessão do painel e fica de fora, porque a rede dele é a da API. O controle positivo é o 1º pedido, o próprio `sidepanel.html`, e o mesmo coletor registra a URL da aba da vaga, que é de fora. **Achado:** o `fetch` barrado pela meta CSP não gera `Network.requestWillBeSent`, só o `Log.entryAdded` de `security`. A medida conta o que saiu, e a tentativa barrada aparece no item 9. No Edge 157 e no Chrome 156, 3 pedidos (HTML, JS e CSS), todos em `chrome-extension://<id>/`;
- **itens 6 e 7:** o MAIN pelo `evaluate` do Playwright, e o ISOLATED pelo contexto `isolated` com a origem da extensão no CDP da aba (o mundo do extrator, que existe depois da captura). O dump traz o texto, os comentários, os atributos, as propriedades próprias da `window`, o storage e o cookie da página, o título e a URL. Cada mundo vê o seu controle e não o do outro. No ISOLATED, pelo `executeScript` do SW (o caminho do extrator), o `storage.session.get` e o `getKeys` falham com "Access to storage is not allowed from this context.", e o `storage.local.get` responde (o controle);
- **item 8:** `local` e `sync` vazios, com o controle por `Extensions.setStorageItems` e `removeStorageItems`; localStorage, IndexedDB e CacheStorage vazios (`CacheStorage.requestCacheNames` com o `storageKey`), com o controle de um item, um banco e um cache criados e apagados pelo teste. O cenário 6 passou a conferir também o CacheStorage;
- **item 9:** `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` e `Log.entryAdded` de todo alvo, sem canário nas três formas e sem trecho de 100 caracteres ou mais. Controles: um `console.log` no SW depois do reinício do cenário 13, outro no painel, uma exceção no painel, o `Log` do `fetch` barrado e um `console.log` no ISOLATED da aba. **Achado:** o SW parado por `Target.closeTarget` volta no mesmo alvo CDP (o Chromium mantém o agente do SW entre a parada e a partida). O `Worker` do Playwright e a sessão do coletor seguem os mesmos, e uma marca global que some prova o reinício;
- **item 10:** no total, a troca e a renovação sem `Authorization` nem `Cookie`, o POST do logout com Bearer, o BFF falso só com a origem exata, o Supabase falso só com o `authorize`, sem `Authorization` e sem `Origin` de extensão, e o chromiumapp só com o GET do retorno (`/auth` e `/outro`). Um cookie para `localhost` entra no perfil antes dos cenários: o BFF falso nunca o recebe (`credentials: "omit"`), e uma navegação comum ao BFF falso o leva (o controle positivo). **Observação para o P14:** o `authorize` levou o cookie do perfil em 6 de 6, no Edge 157 e no Chrome 156 (o `launchWebAuthFlow` usa os cookies do perfil, também em headless);
- **guarda do build:** o `wxt build` também lê o `.env` da pasta da extensão (o WXT o carrega no `process.env` depois de avaliar o `wxt.config.ts`, então hoje sem efeito no build). O `global-setup` confere, logo depois de cada build, a `key` e o `connect-src` do manifesto e a origem do Supabase falso no `background.js`, e o E2E para se algo divergir. Na unidade, o `WxtVitest` carrega esse `.env` no `process.env` dos testes, e o `vitest.config.ts` zera ali as variáveis de build (*BACKLOG §F1-EXT-06*);
- **`[APPSEC]`:** sem veto. As 4 condições da partição estão cumpridas: nada em `src/` nem no build; os falsos não mudaram; cada "0" tem controle positivo; nenhum literal com cara de segredo (os canários, os controles e o cookie nascem em tempo de execução), e o gitleaks 8.30.1 conferido não achou nada. A porta de depuração fica aberta só durante esse arquivo, em 127.0.0.1, num perfil descartável sem nenhuma credencial real.

**Emenda do 04b-3 (2026-11-12): as provas negativas com o envio.**
- **sequência:** depois do cenário 1 com o Google e da captura na aba, o `auth-negative.e2e.test.ts` passou a rodar, no mesmo navegador e antes das provas, o cenário 12 (a vaga capturada na aba vai à API falsa), o 3 (o 401 com a renovação e o reenvio, e a renovação presa com a análise em curso), o 5 (503 na renovação e a recuperação, mais um erro fora do contrato com texto canário) e o 4 (a sessão revogada no falso). No fim o login volta e uma análise roda, porque as provas contam com a sessão aberta e passaram a conferir também o relatório na tela;
- **texto de vaga canário** (`CANARIO-VAGA-<hex>`, montado em tempo de execução e posto na página da vaga): o controle positivo é o SHA-256 do texto que o BFF falso recebeu, igual ao do texto capturado, que contém o canário. Ele fica só onde o [ADR-024-capture-in-service-worker](ADR-024-capture-in-service-worker.md) D4 manda (o `storage.session` do SW, conferido pelo leitor, e a própria aba) e nunca aparece nas mensagens da porta (item 1), no DOM do painel (item 2), no heap do painel (item 3), no console de nenhum alvo (item 9), nem em `local`, `sync`, localStorage, IndexedDB e CacheStorage (item 8);
- **item 1:** o espião conta as 7 mensagens `entrar` e as 8 `analisar`, só com o modo, e vê os eventos do stream chegarem (o controle positivo do registro); todo o resto segue em 0;
- **item 10:** no total, 4 trocas, 6 renovações, 3 logouts e 8 análises, com a regra nova do Bearer (só no logout e na análise);
- o token canário segue fora do painel com a análise em curso (a renovação presa) e depois do resultado.

### 4.6 Manifesto e artefato de build
- `manifest.test.ts` (D13) e grep (D10 B5) no build do E2E, com as duas origens e a `key`; a `key` "se e somente se" com dois builds.
- O build normal não contém o marcador do adapter falso nem `TRAMPO_E2E`. **Aplicado no 05c-1 (2026-11-09):** o `manifest.test.ts` procura `TRAMPO_E2E`, `FAKE_IDENTITY` e `trampo/e2e/` em todos os arquivos dos dois builds, e prova que `TRAMPO_E2E_FAKE_IDENTITY` derruba o build com e sem `TRAMPO_E2E=1`, sem ecoar o valor. Como o modo 3 não tem código (§4.4, "Emenda do 05c-1"), o marcador não existe em lugar nenhum.
- `TRAMPO_EXTENSION_KEY` fora do formato SPKI derruba o build; `TRAMPO_SUPABASE_ORIGIN` fora de origem https exata também.

- **Emenda da F1-EXT-06 (2026-11-11, `8f81e42`), a fonte das variáveis do build:** o `wxt.config.ts` chama o `loadBuildEnv(process.env, <.env ao lado dele>)`. O leitor tira do arquivo só o `TRAMPO_API_ORIGIN`, o `TRAMPO_SUPABASE_ORIGIN` e o `TRAMPO_EXTENSION_KEY` (`parseEnv` do `node:util`); qualquer outra chave é descartada e nunca chega ao `process.env`, ao `define` nem ao artefato. A variável definida no ambiente, mesmo vazia, vence a do arquivo. `TRAMPO_IGNORE_DOTENV=1` desliga a leitura (só o valor `1`; outro derruba o build), e os testes de unidade, os builds do `manifest.test.ts` e o `global-setup` do E2E o definem. Derrubam o build, sem ecoar valor nem caminho: chave da lista repetida, arquivo ilegível, acima de 16 KiB ou fora de UTF-8, e valor fora da forma. O caminho é fixo: nenhuma variável escolhe outro arquivo. O build real é provado no `manifest.test.ts` com um `.env` de teste, pela mesma fábrica (`extension-config.ts`).

### 4.7 Mutação
Script no scratchpad, registro no SESSION-LOG e arquivos restaurados com o hash idêntico, como nos ADR-023 e ADR-024. Meta: nenhum sobrevivente que não seja equivalente. Catálogo fixo (API em `apps/api/src`):

| M | Arquivo | Operador | Teste que mata |
|---|---|---|---|
| M-01 | `src/auth/pkce.ts` | `plain` no lugar de S256 | vetor do RFC 7636 |
| M-02 | `src/auth/redirect.ts` | `startsWith` no lugar da igualdade; chave extra no fragmento; sem `st` | barra final, `#access_token=` e `st` divergente recusados |
| M-03 | `src/auth/auth-service.ts` | verifier não apagado depois do envio | segundo retorno com o mesmo `state` recusado sem `POST /v1/auth/exchange` |
| M-04 | idem | single-flight removido; cada incremento de geração removido ("Sair", 401, login) | N=5 gera 1 renovação; caso de geração de cada um |
| M-05 | idem | limiar de 60 s vira 0; 503 apaga; repete depois de HTTP | renova com 59 s; 503 mantém; sem nova tentativa depois de HTTP |
| M-06 | idem | rede antes de apagar, no logout; mapa do D12, um mutante por linha | storage vazio antes da chamada; teste nomeado da linha (CA-14) |
| M-07 | `src/api/api-client.ts` | caminho a mais; Bearer em toda rota | caminho fora recusado; Bearer só nas 2 rotas |
| M-08 | `src/messaging/protocol.ts` | `refine` da `SessaoView` removido | `{ true, "NAO_AUTENTICADO" }` recusado |
| M-09 | `application/auth/refresh-session.ts` | `>` vira `>=`, ou a regra some, na idade máxima, na inatividade e no `sid` | limites exatos com 0 chamadas; `sid` divergente dá 401 |
| M-10 | idem e `exchange-session.ts` | `keysReady()` depois do GoTrue | sem chaves, 0 chamadas |
| M-11 | `exchange-session.ts` | `min()` vira `expires_in`; recusa acima de 900 removida; projeção por *spread* | `expiresIn` descontado; 3600 dá 503; 4 chaves |
| M-12 | `infrastructure/crypto/aead-envelope.ts` | AAD sem `Origin`; tag não conferida | outra origem e tag adulterada dão 401 |
| M-13 | `infrastructure/supabase/gotrue-token-client.ts` | "pode ter rotacionado" vira "não recebeu"; 404 sem corpo do GoTrue vira recusado (emenda do HITL-035, 2026-11-06) | 2 chamadas no prazo depois do envio; caso novo do §4.2 (404 sem corpo dá 503) |
| M-14 | `presentation/routes/auth.ts` | mapa do D7, um mutante por linha | caso da linha no §4.2 |
| M-15 | `presentation/edge/auth.ts` e `cors.ts` | rotas por prefixo; `Origin` opcional | `/v1/auth/exchange/` fora; sem `Origin` dá 403 |
| M-16 | `presentation/edge/pre-auth-limit.ts`, orçamento e *bulkhead* de saída | limiares +1; chave sem HMAC; transbordo que despeja; orçamento antes do `open`; *bulkhead* 5 | 11ª troca dá 429; chave HMAC; 10.000 forjados consomem 0; 5ª chamada dá 503 |
| M-17 | `infrastructure/auth/jose-access-token-verifier.ts` | `amr` ignorado | `amr` `password` recusado |

### 4.8 Gates de CI e cobertura
- Lint e depcruise com as regras do D10.
- `manifest.test.ts` (D13) e grep do artefato.
- Varredura de segredos (SR-14): regra própria `trampo-auth-seal-keys` no `.gitleaks.toml` (proposta, a aplicar na implementação) para `AUTH_REFRESH_SEAL_KEYS` e `*.pem`, com teste no `packages/ci-policy`. **Aplicada no 07h (`4efd96c`), em duas partes**, porque o gitleaks não junta regex e caminho com "ou": `trampo-auth-seal-keys` (atribuição com `=`, `:`, `:=` ou `=>`, nome entre aspas ou colchete, valor na mesma linha ou na de baixo, `kid:` e 32+ caracteres de material em base64url, base64 ou hex; palavra-chave `auth_refresh_seal_keys`) e `trampo-auth-seal-keys-files` (`.pem` sem diferença de caixa e `signing_keys.json`, pelo caminho). Nenhuma das duas tem allowlist própria. O `gitleaks-config.test.ts` lê a configuração real por um leitor estrito (recusa chave desconhecida numa regra e regex que o RE2 e o V8 leriam diferente) e prova 21 formas pegas, 9 não pegas e a árvore versionada sem achado. Mutação: 57 mutantes, 56 mortos e 1 equivalente.
- Teste de contrato no job `db` (§4.3).
- Cobertura de 100% em `packages/contracts/src/auth.ts`, `apps/api/src/application/auth/**`, nos adapters novos da API e em `apps/extension/src/{auth,api}/**`.

### 4.9 SRs novos (threat-model §7)
Hoje nenhum SR cobre T9 nem T22, e o guardrail do F1-EXT-05 é justamente "T9 e T22" [J:cofre-ameacas]. Cobertura proposta:
- **T9** (roubo de sessão): SR-21 (envelope e idade máxima) e SR-24 (ciclo de vida, single-flight, logout global).
- **T22** (token exposto): SR-23 (isolamento por canário, painel sem egress) e SR-18 (verifier só em memória).
- T41 e T42: SR-18. T43: SR-19, SR-20 e SR-21. T44: SR-21 e SR-24. T45: SR-22. T46: SR-23. T47: SR-21 e SR-14. T48: SR-18 e SR-21.

| SR | Requisito | Prova | Tarefa |
|---|---|---|---|
| SR-18 | Fluxo OAuth no SW: PKCE S256 com vetor do RFC, redirect exato, `state` sempre conferido (emenda do HITL-035, 2026-11-06: o P5 passou), fragmento e *implicit* recusados, `error` nunca exibido, um fluxo por vez, verifier só em memória e apagado em 5 min | unidade + E2E local | F1-EXT-05a |
| SR-19 | Rotas públicas de auth: lista exata, `Origin` de extensão obrigatório, origem web 403, até 2 KiB sem parse, strictObject, `no-store`, um único 401 | borda da API | F1-API-07 |
| SR-20 | Limitador local pré-JWT (com `TRUST_PROXY`), orçamento de saída particionado e *bulkhead*, com **0 comandos Redis** antes do JWT | API com Redis simulado | F1-API-07 |
| SR-21 | Envelope AEAD conforme o D7: forjado dá 401 **sem chamar o GoTrue**; idade máxima e inatividade, 401 sem rede; `sid` divergente, 401 com o refresh descartado; uma nova tentativa só em "pode ter rotacionado"; JWKS fora não consome o refresh; hook do D5 se o P18 confirmar | API | F1-API-07 |
| SR-22 | Resposta do BFF com exatamente 4 chaves; `provider_token`, `user` e e-mail nunca saem nem vão a log | API (canário) | F1-API-07 |
| SR-23 | Token, envelope, código e verifier nunca chegam ao painel, ao extrator, à página, a `local`/`sync` nem a log; painel sem egress por `fetch` nem formulário; lint, depcruise e grep barram storage, identity e auth no painel | unidade + E2E local + CI | F1-EXT-05b, F1-EXT-05c |
| SR-24 | Ciclo de vida: single-flight com geração; 503 nunca apaga a sessão nem pede login; 401 da renovação apaga; logout local incondicional, global no servidor e com aviso se o remoto falhar; reinício ou atualização exigem login | unidade + E2E local | F1-EXT-05a, F1-EXT-05c |

### 4.10 Critérios de aceite (o ADR vira aceito e o F1-EXT-05 fecha)
- **CA-01:** manifesto exatamente como o D13.
- **CA-02:** login com GitHub e com Google no Chrome **e** no Edge contra o projeto real (roteiro manual) e no E2E local com o IdP falso. Ficam só no roteiro manual: o IdP real, os cookies do perfil (P14) e, nos modos 2 e 3 do P20, a janela real.
- **CA-03:** SR-18 a SR-24 verdes; SR-02, SR-05, SR-10, SR-12 e SR-17 continuam verdes.
- **CA-04:** provas negativas do §4.5 com 0 ocorrências de canário, 0 chamadas no espião e 0 requisições do painel com URL fora de `chrome-extension://<id>/`. **Cumprido no E2E local no 05c-3 (2026-11-09)**, no Edge 157 e no Chrome 156, cada "0" com controle positivo (§4.5, "Emenda do 05c-3").
- **CA-05a:** N=5 chamadas simultâneas com token vencido geram 1 `POST /v1/auth/refresh` (unidade do `auth-service`; E2E depois do F1-EXT-04 parte 2).
- **CA-05b:** cada `POST /v1/auth/refresh` gera exatamente 1 chamada ao GoTrue simulado, fora do caso "pode ter rotacionado" (§4.2).
- **CA-06:** 503 ou prazo na renovação não apaga a sessão nem mostra "Entre de novo" (unidade; E2E depois do F1-EXT-04 parte 2).
- **CA-07:** depois do "Sair", storage vazio na hora, GoTrue com `scope=global` (§4.3), 0 renovações com o envelope antigo e aviso quando o remoto falha.
- **CA-08:** os casos de envelope do SR-21 provados no §4.2 (sem GoTrue, sem rede ou com o refresh descartado, conforme o D7); sem `Origin` dá 403; 0 comandos Redis antes do JWT.
- **CA-09:** envelope com mais de `AUTH_SESSION_MAX_AGE_SECONDS`, ou parado há mais de `AUTH_SESSION_IDLE_SECONDS`, dá 401.
- **CA-10:** reinício do navegador e atualização da extensão deixam o painel em `autenticado: false`.
- **CA-11:** cobertura de 100% nos módulos novos; M-01 a M-17 do §4.7 (um mutante por operador) mortos ou equivalentes justificados, com os hashes restaurados no SESSION-LOG.
- **CA-12:** P1 a P20 aprovados, ou a coluna "Se falhar" aprovada em HITL, registrados no *spike-metrics* §4, com o relatório de conformidade do P9; ADR-013 §5 fechado.
- **CA-13:** threat model v2 e revisão adversarial de auth aprovados; HITL-034 e HITL-035 fechados. **Estado em 2026-11-11 (F1-SEC-01):** HITL-034 e HITL-035 fechados; a v2 e a revisão foram entregues e esperam o *HITL-QUEUE §HITL-039*.
- **CA-14:** cada linha da tabela do D12 tem teste de unidade nomeado; as linhas exercitáveis também no E2E local; handshake exato `[ready, captura, consentimento, sessao]`.
- **CA-15:** condições do veto do §3 cumpridas: P3, P4 e P8, P5 (ou Q6), P6 com o Site URL estático, e o T9 decidido pelo P18 (hook, ou residual aceito na Q10).
  - **Emenda do HITL-035 (2026-11-06):** P4 e P8 cumpridos no pré-spike (P8 com ressalva de evidência); P5 cumprido e refeito no S-5; P6 com o Site URL da opção A até o S-5 e o caso E refeito (*HITL-QUEUE §HITL-036*); T9 decidido pelo P18: hook aplicado e recusa provada (F1-DB-02). P3 sem mudança.
  - **Emenda da F1-DB-02 (2026-11-12):** o hook está entregue por migration e provado no `test:db` (`cf5fe64`, [ADR-026-custom-access-token-hook](ADR-026-custom-access-token-hook.md)). O P18 e esta CA só fecham com o job `db` verde no PR **e** com o *HITL-QUEUE §HITL-040* respondido (migration aplicada no projeto real, hook ligado no painel e fumaça).
- **CA-16:** E2E local ao fim de cada trilha F1-EXT-05x e antes do aceite, com navegador, versão, modo do P20 e contagens no SESSION-LOG.

**Rastreio §3 → CA/SR:**

| §3 | CA | SR |
|---|---|---|
| Veto: P3, P4, P5, P6 e P8 | CA-01, CA-02, CA-15 | SR-18 |
| Veto: P18 (T9 fora do BFF) e T48 | CA-15 | SR-18, SR-21 |
| T41, T42 | CA-02 | SR-18 |
| T43 | CA-05b, CA-08 | SR-19, SR-20, SR-21 |
| T44 | CA-07, CA-08, CA-09 | SR-21, SR-24 |
| T45 | CA-03 | SR-22 |
| T46 e T22 | CA-04, CA-14 | SR-23 |
| T47 | CA-13 | SR-14, SR-21 |
| T9 (ciclo de vida) | CA-05a, CA-06, CA-07, CA-10 | SR-24 |

## 5. Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| (b1) Login no portal e repasse dos tokens do portal | Quebra o cookie `HttpOnly` (T9.5). Portal e extensão dividiriam uma cadeia de refresh: um uso fora dos 10 s revoga as duas sessões (T9.3), e o logout do portal derruba a extensão. **Vetado pelo `[APPSEC]`.** |
| (b1) Login no portal com sessão nova cunhada pela Admin API (*magic link* e `verify`, não verificado na documentação) | Põe a chave *secret* numa rota pré-autenticação (contra o ADR-018 D5), liga *magic link* e exige tabela de *handoff*. Um XSS no portal viraria credencial persistente. |
| (b1) Portal como tela de consentimento do OAuth 2.1 Server do Supabase | Recurso em beta (§1.1), exige o portal pronto, claims (`aud`, `client_id`) não conferidos contra o ADR-013 e continua precisando de `launchWebAuthFlow` ou relay. |
| (b2) Portal como relay do código, como caminho principal | Mesmo BFF da (a) com mais superfície: `onMessageExternal`, portal hospedado fora do S-5, divergência do Blueprint (l.221) e XSS no redirect. Fica como contingência C2 (D14). |
| SW falando direto com o Supabase Auth (`connect-src` com dois caminhos exatos, sem BFF) | Fere o SR-02, o threat-model §6, o guardrail do S-3 e o Blueprint (l.219). O refresh cru ficaria no `storage.session`, legível pelo painel, e valeria para sempre direto no GoTrue com a *publishable*: o gap do T9 continuaria aberto. Acopla o contrato não documentado do GoTrue a versões da extensão. |
| `supabase-js` dentro da extensão | Exige a origem inteira do Supabase no `connect-src`, traz o `user` e o `provider_token` para o SW, renova por timer que morre com o SW e é dependência nova. |
| BFF com sessão guardada no servidor (Redis ou tabela) e token opaco próprio | Quebra o ADR-013 e o ADR-018, porque a RLS precisa do JWT do Supabase. Gasta orçamento do Upstash e cria estado novo. O CORS não tem `Allow-Credentials`. |
| `signInWithIdToken` do Google (o exemplo oficial para extensão) | Deixa o GitHub de fora (HITL-004), usa resposta fora do Authorization Code e exige *nonce*. |
| Cifrar os tokens dentro do `storage.session` com chave do SW | A chave morre a cada suspensão do SW (relogin constante). Com a chave no IndexedDB, o painel, na mesma origem, também a usaria. Não protege contra o vetor real. |
| API emitindo a URL do `authorize` (GET público com 302) | Mais uma rota pública, com risco de *open redirect*. O `ref` do projeto não é segredo, e a URL sai de `TRAMPO_SUPABASE_ORIGIN`, fora da CSP. |
| Mostrar o provedor no painel ("Conectado com GitHub") | Exigiria `provedor` na `SessaoView`, contra o requisito 3 (só booleano e códigos). O residual "conta trocada" fica no §3, e a Q11 pergunta. |
| Vínculo do envelope ao remetente: par ECDSA P-256 não extraível no IndexedDB do SW, impressão digital selada no envelope e prova assinada a cada renovação | **Alternativa para a Fase 2**, não adotada. O envelope exfiltrado deixaria de servir fora do navegador (RFC 9700 §2.2.2), mas não protege contra AT8 (a chave fica no disco do perfil) e põe IndexedDB e assinatura na renovação. |
| Job de E2E no CI | **Alternativa para a Fase 2.** Hoje o E2E roda local (§1.2), com o critério da CA-16. |

## 6. Consequências

### 6.1 Emendas exatas a outros documentos (a aplicar na implementação; nenhuma aplicada agora)
- **Emenda do HITL-035 (2026-11-06):** o "nenhuma aplicada agora" é da redação. Já entraram a do contratos-zod (F1-AUTH-00) e o registro do HITL-035 (P4 a P8, P18 e P19) no spike-metrics §4, marcados nos itens abaixo.
- **ADR-001:**
  - §5.0.1, linha "Autenticação": "Decidido no [ADR-004-extension-auth](ADR-004-extension-auth.md): opção (a), PKCE S256 no SW, troca e refresh por BFF sem estado com refresh selado. A (b) fica como contingência C2.";
  - linhas "CSP" (meta do D10 B4) e "Mensagens internas" (porta única, conforme §1.2 e `background.ts` L3-4);
  - linha "Permissões" (a `key` já está lá): `key` só em builds unpacked, conforme D13; `contextMenus` segue com o gatilho do S-3;
  - linha "`externally_connectable`": fechada como vazio; "state aleatório": o recuo do P5 (Q6);
  - §5.1: nova ordem dos hooks (D4, "Ordem na borda"); §13 (l.481): a pendência passa para o spike S-3 (P1 a P20).
- **ADR-007 D6 e ADR-021 D8.3:** conforme D8 item 2 e a tabela do D4 (`bodyLimit` de 2.048 e `no-store` nas 3 rotas).
  - **Aplicadas (F1-API-07, commit 07g, 2026-11-07, `b516fd0`):** as 3 rotas na `EXTENSION_ROUTES`, `EXTENSION_ONLY_ROUTES` com a origem de web em 403 e `ORIGIN_REQUIRED_ROUTES` com o `Origin` obrigatório nas públicas, comparando o caminho cru e o padrão casado; `bodyLimit` de 2.048 e `no-store` nas 3 rotas (D8, "Emenda do 07g").
- **ADR-010:** conforme D8 item 7 e o relatório do D15 (só no spike).
  - **D1 e D2 aplicadas (F1-API-07, commit 07g, 2026-11-07, `b516fd0`):** as 10 mensagens do D8 item 7 no catálogo e a chave `suprimidas` na tabela do D1. O relatório do D15 continua com o spike.
- **ADR-013:** D2 conforme D8 item 1 e a nova ordem dos hooks; D1 com `keysReady()` e a verificação antes de repassar (D6); D4 com o `amr` (D6); §5 conferido no P9; `ACCESS_TOKEN_MAX_CHARS` em `@trampo/contracts/limits`, no lugar dos 3 lugares do D7.
  - **Emenda do HITL-035 (2026-11-06):** a constante já está no `limits.ts` (F1-AUTH-00). A troca dos 3 literais `8_192` da API (`presentation/edge/auth.ts` L20, `application/criteria/criteria-guard.ts` L23, `infrastructure/supabase/postgrest-user-client.ts` L25) pelo import de `@trampo/contracts/limits` vai para a F1-API-07, como primeiro passo, só nessas 3 linhas. Os `8_192` do `llm-output-guard` e da telemetria são outros limites.
  - **Aplicada (F1-API-07, commit 07a, 2026-11-07):** só a parte do `ACCESS_TOKEN_MAX_CHARS` (ADR-013 D3, emenda datada). D1 (`keysReady()`), D2 (rotas públicas) e D4 (`amr`) ficam com os commits 07d e 07g.
  - **D1 e D4 aplicadas (F1-API-07, commit 07d, 2026-11-07, `7e6c5d5`):** `keysReady()` na porta e no adapter `jose` (D1) e o `amr` no schema das claims (D4), com as emendas datadas no ADR-013 e as decisões no D6 ("Emenda do 07d"). A D2 (rotas públicas) fica com o 07g.
  - **D2 aplicada (F1-API-07, commit 07g, 2026-11-07, `b516fd0`):** a lista pública com a troca e a renovação, que nunca leem `Authorization`, e a ordem efetiva dos hooks (D4, "Emenda do 07g").
  - **D1, `lifetime` (F1-API-07, commit 07f, 2026-11-07, `e1af5d0`):** o `ok` do `verify` leva o `iat` e o `exp` num campo à parte do `Principal` (D6, "Emenda do 07f").
- **ADR-014:** D10 novo conforme D8 itens 4 e 5; D8 com a nova ordem dos hooks e a nota de que o limitador local não é o *ephemeral cache* do T39 (não substitui o Redis e falha para o lado restritivo); §3 com a decisão de 2026-10-21 de pé; D4 com o logout na classe `padrao`.
  - **D10, D8 e §3 aplicadas (F1-API-07, commit 07e, 2026-11-07, `ac3c2c7`):** D10 novo (limitador local, `API_BEHIND_PROXY`, orçamento de saída e *bulkhead*), nota de ordem no D8 e a decisão de 2026-10-21 de pé no §3. As decisões de implementação estão no D8 deste ADR ("Emenda do 07e"). O D4 (logout na classe `padrao`) fica com o 07g, junto da rota.
  - **D4 aplicada (F1-API-07, commit 07g, 2026-11-07, `b516fd0`):** o logout declara a classe `padrao`.
- **ADR-018:** D4 generalizado conforme D5 (AEAD por finalidade, anéis separados); D5 com o cliente do GoTrue conforme D4 ("Peças novas"). A *secret* continua só no `DeleteAccount`.
  - **D4 aplicada (F1-API-07, commit 07b, 2026-11-07):** `aead-envelope.ts` com o prefixo de AAD amarrado à versão, `salary-cipher.ts` sobre ele com o formato `s1` provado por vetor gravado, e `aead-refresh-sealer.ts` (`r1`). A D5 (cliente do GoTrue) fica com o 07c.
  - **D5 aplicada (F1-API-07, commit 07c, 2026-11-07):** o cliente do GoTrue (`gotrue-token-client.ts`) entrou como terceira linha da tabela de clientes Supabase do ADR-018 D5: *publishable*, sem SDK, Bearer só no logout, lista fechada de cabeçalhos. A *secret* continua só no `DeleteAccount`.
- **ADR-019:** job `db` conforme §4.3; regra de segredos do §4.8.
- **ADR-024:** D1 e §4 com `auth.attach` no `onReady`; D2 com o teste "depois do login"; depcruise do D10 B3; D6 com os motivos de log do D3.
- **ADR-025:** D2 a D5 conforme D12 (handshake, mensagens, `PanelState`, `SESSION_TEXTS`, botões, "Reconectar") e D10 (meta CSP, lint B1).
- **threat-model v2:** §3 com TB10 e TB11; §4 e §5 com T41 a T48 (§3 deste ADR); T9 conforme D1 item 3 e D5, mitigação 3 com single-flight e geração (D11.2); T8 e T22 conforme D10; T20.1 passa a "porta única"; §6, linha da CSP, resolvida pela (a); §7 com SR-18 a SR-24 (§4.9); §9 com os residuais do §3, inclusive o M do T9 (AT8); revisão adversarial própria de auth.
- **contratos-zod.md:** seção `auth`; export `./auth` no `packages/contracts/package.json`; `CONTRACTS_ALLOWED` (`eslint.config.js` L6) e o depcruise da extensão ganham `auth`.
  - **Emenda do HITL-035 (2026-11-06):** seção `auth`, export `./auth` e reexport na raiz aplicados na F1-AUTH-00 (`47abd8c`). `CONTRACTS_ALLOWED` e o depcruise da extensão (com o painel proibido de importar `@trampo/contracts/auth`, regra B3) ficam com a F1-EXT-05a.
- **BACKLOG:** S-3 item 3 ganha o recuo do `state` (P5); tarefas novas do §6.3. **Emenda do HITL-035 (2026-11-06):** o recuo do `state` não é necessário (P5 aprovado).
- **spike-metrics §4:** P1 a P20 e o relatório de conformidade do P9. **Emenda do HITL-035 (2026-11-06):** P4 a P8, P18 e P19 registrados.

### 6.2 HITLs e o que o humano precisa fazer
- **HITL-034 (marco de aprovação):** responder as perguntas do §7. É o único aberto agora na fila (nota de 2026-11-06: texto histórico, da redação; o HITL-034 fechou em 2026-11-04 e o HITL-035 em 2026-11-06, e o aberto agora é o *HITL-QUEUE §HITL-036*).
- **HITL-035 (ação externa única):** o `[SCRIBE]` o abre depois da aprovação do HITL-034. Os comandos ficam no runbook `base/03-infra-runbook/auth-extensao.md`, sem nenhum valor de segredo.
  - **Parte 1, credenciais:** gerar o par RSA da extensão fora do repositório e guardar a privada no gerenciador de senhas; pôr só a pública (DER em base64) em `TRAMPO_EXTENSION_KEY`; acrescentar `chrome-extension://<id>` em `CORS_ALLOWED_ORIGINS`; gerar 32 bytes aleatórios em base64url para `AUTH_REFRESH_SEAL_KEYS` e escolher o `kid` de `AUTH_REFRESH_SEAL_ACTIVE_KEY`, no `.env` da API e no gerenciador de segredos.
  - **Parte 2, painel do Supabase:** aplicar e confirmar os itens do D15, sem copiar valor para o cofre, e dizer se o runbook `supabase-setup` foi movido ou apagado (§1.2).
  - **Emenda do HITL-035 (2026-11-06):** fechado com ressalvas: Site URL A, P18 disponível, P19 anotado, P4/P7/P8 aprovados, P6 inconclusivo → *HITL-QUEUE §HITL-036* (P6 com os casos E e F, novos cadastros, anotações do pré-spike, chave no Google Drive e runbooks ausentes). O pré-spike rodou como parte 3 dele (§1.4).
- **HITL condicional:** ativar C1 ou C2 (D14), só se o spike disparar o gatilho.
- **Ordem:** HITL-034 → HITL-035 → pré-spike manual (P4, P5, P6, P7, P8, sem código de produto) → F1-AUTH-00 … F1-EXT-05c → spike completo → aceite.
  - **Emenda do HITL-035 (2026-11-06):** HITL-034 → HITL-035 (fechado com ressalvas em 2026-11-06) → HITL-036 (complementar, em paralelo às trilhas) → F1-AUTH-00 (concluída, `47abd8c`) → F1-API-07 → F1-EXT-05a → F1-EXT-05b → F1-EXT-05c → F1-SEC-01. A F1-DB-02 (hook) entra antes do aceite, com HITL de aplicação. Depois, o spike completo e o aceite. O HITL-036 bloqueia o spike S-3 contra o projeto real e o aceite; não bloqueia a F1-API-07, as F1-EXT-05a, b e c nem a F1-DB-02.
- **Spike manual:** login real com GitHub e com Google no Chrome e no Edge 155, pelo roteiro guiado. A equipe não tem credencial desses provedores.

### 6.3 Trilhas de implementação (uma por vez, AGENTS §4.1)
1. **F1-AUTH-00:** `packages/contracts/src/auth.ts`, export `./auth` e `ACCESS_TOKEN_MAX_CHARS` em `limits.ts`. 100% de cobertura. **Concluída em 2026-11-06** (`47abd8c`): reexport no `index.ts`; não tocou `apps/api` nem `apps/extension`.
2. **F1-API-07:** porta e adapter do GoTrue, `RefreshSealer` e `aead-envelope`, casos de uso, limitador local, orçamento de saída, *bulkhead*, `keysReady()`, `amr`, rotas, emendas de borda (ADR-007, ADR-013, ADR-014) e o teste de contrato no job `db` (ADR-019). **Emenda do HITL-035 (2026-11-06):** troca dos 3 literais do teto do token (primeiro passo, §6.1) e classificação do 404 (D7).
   - **Partição em commits atômicos (`[ARCHITECT]` + `[APPSEC]`, 2026-11-07; AGENTS §4.1, molde da F1-API-05).** Um commit por vez, cada um com 100% de cobertura, a mutação do §4.7 que couber, turbo em série e depcruise. Nenhum toca o Supabase real nem provedor de LLM. Até o 07g, nenhuma rota nova existe, então a API em produção não muda de comportamento (exceto o `amr` no 07d, que vale para todas as rotas protegidas).
     - **07a, teto do token:** os 3 literais `8_192` (`presentation/edge/auth.ts`, `application/criteria/criteria-guard.ts` e `infrastructure/supabase/postgrest-user-client.ts`) viram o `ACCESS_TOKEN_MAX_CHARS` de `@trampo/contracts/limits`. Um teste varre o `src/` da API e prova que nenhum `8_192` sobra fora dos dois limites alheios (`llm-output-guard` e telemetria). Emenda do ADR-013 (constante).
     - **07b, envelope AEAD:** `infrastructure/crypto/aead-envelope.ts` (AES-256-GCM por finalidade, prefixo e AAD próprios, base64url canônica no `open`, `kid` na regex do contrato) e o `salary-cipher` passando a usá-lo sem mudar o formato `s1` (provado pelos testes atuais e por um vetor gravado); porta `application/ports/refresh-sealer.ts` e adapter `infrastructure/crypto/aead-refresh-sealer.ts` (texto claro `strictObject` com até 768 bytes, AAD `trampo:auth.refresh:r1:<Origin>`); leitura em falha fechada de `AUTH_REFRESH_SEAL_KEYS`, `AUTH_REFRESH_SEAL_ACTIVE_KEY`, `AUTH_SESSION_MAX_AGE_SECONDS` e `AUTH_SESSION_IDLE_SECONDS` (`infrastructure/auth/auth-session-env.ts`), sem ecoar valor; as variáveis entram sem valor no `apps/api/.env.example`. A leitura no boot (composição) entra no 07g, junto do primeiro consumidor. M-12. Emenda do ADR-018 D4.
     - **07c, GoTrue:** porta `application/ports/auth-token-gateway.ts` e adapter `infrastructure/supabase/gotrue-token-client.ts` (sem SDK; recusa `sb_secret_` e `eyJ`; URL fixa de `SUPABASE_URL`; `redirect: "error"`, 5 s, 32 KiB, sem retry; corpo `{ auth_code, code_verifier }`; projeção de 4 campos; o 404 só é `recusado` com o corpo JSON do GoTrue e `error_code` string; **nunca envia `X-Forwarded-For`, `X-Real-IP`, `Forwarded` nem cabeçalho do cliente**, com lista fechada de cabeçalhos provada no simulado). GoTrue simulado em socket real em `127.0.0.1` (`test/support/fake-gotrue.ts`, QA-02). M-13. Emenda do ADR-018 D5.
     - **07d, verificador:** `keysReady()` na porta e no adapter `jose` (nunca rejeita; P15) e o `amr` exigido (`AUTH_ALLOWED_AMR`, padrão `oauth`; `password` só com `NODE_ENV=test`, recusado no boot de produção). M-17. Emenda do ADR-013 D1 e D4.
     - **07e, contenção de tráfego:** limitador local pré-JWT em memória (`presentation/edge/pre-auth-limit.ts`: janela deslizante, chave HMAC com o `RATE_KEY_PEPPER`, IPv6 por /64, `auth_troca` 10/min e `auth_renovacao` 30/min, 10.000 baldes com transbordo sem despejo, `API_BEHIND_PROXY`); orçamento de saída em janela deslizante de 300 s (`application/auth/gotrue-egress.ts`: `troca` até 14, total no `/token` até 74, `renovacao` com reserva mínima de 50%, consumido só depois do Zod e do `open`) e *bulkhead* de 4 com `retryAfterSeconds: 5`. Os tetos do P19 (150 e 30 por 5 min por IP) ficam presos por teste. M-16. Emenda do ADR-014 (D10 novo).
     - **07f, casos de uso:** `ExchangeSession`, `RefreshSession` e `EndSession` em `application/auth/`, código puro com portas injetadas, na ordem exata do D4 (formato → `keysReady()` → orçamento e *bulkhead* → GoTrue → verificação → selagem), com o `expiresIn` inteiro e < 1 dando 503. M-09, M-10 e M-11. **Concluído em 2026-11-07 (`e1af5d0`)**, com as decisões no D4 ("Emenda do 07f") e o `lifetime` no D6; mutação 50/50.
     - **07g, rotas e borda:** `presentation/routes/auth.ts`, `PUBLIC_ROUTES` exata, `EXTENSION_ONLY_ROUTES` com `Origin` obrigatório e sem curinga, `bodyLimit` de 2.048, `Cache-Control: no-store` em toda resposta (inclusive erro), mapa do D7, logs de catálogo amostrados (D8 item 7), e a composição no boot (anel, idades, `amr`, `API_BEHIND_PROXY`). M-14 e M-15. Emendas do ADR-007 D6, ADR-013 D2, ADR-021 D8.3 e ADR-010. **Concluído em 2026-11-07 (`b516fd0`)**, com as decisões no D4, no D5 e no D8 ("Emenda do 07g") e a emenda do ADR-014 D4; mutação 50/50. Pendente: as métricas do D8 item 7 (07i).
     - **07h, contrato no job `db`:** §4.3 (`jwt_expiry = 900`, chave ES256 gerada no job, verificador real, `GotrueTokenClient` contra o GoTrue local, P10 e P11 em CI) e a conferência de **em que balde do limite por IP cai o `grant_type=pkce` e se o `/logout` conta**, no GoTrue local, que tem os mesmos limites do projeto real. Até lá vale o pior caso do D8 item 5. Regra `trampo-auth-seal-keys` no `.gitleaks.toml` com teste no `packages/ci-policy` (§4.8). Emenda do ADR-019. **Concluído em 2026-11-07 (`4efd96c`)**, com as decisões no §4.3, no §4.8, no D7 (logout repetido com 403 `session_not_found`) e no D8 item 5 ("Emenda do 07h"), e a emenda do ADR-019 §3.4; mutação 56/57 (1 equivalente). Pendentes: o 07i (métricas do D8 item 7) e o 07j novo (teto de rajada no `GotrueEgress`). Nenhum dos dois bloqueia a F1-EXT-05a.
   - **`[APPSEC]` sobre a partição:** sem veto. Condições: (1) nenhum commit intermediário expõe rota pública nova; (2) o adapter do GoTrue nasce com a lista fechada de cabeçalhos de saída, e o simulado registra os cabeçalhos recebidos para provar a ausência de `X-Forwarded-For`, `X-Real-IP` e `Forwarded` (*Egress Budget Drain*: um cliente que forjasse o IP repassado ao GoTrue faria o limite por IP do Supabase contar contra outro balde, ou contra a própria API); (3) o balde do `pkce` e do `/logout` não pode ser "confirmado" num simulado, que só repete a nossa hipótese: a prova é o GoTrue local do 07h.
3. **F1-EXT-05a:** `src/auth/**` e `src/api/api-client.ts` no SW, manifesto (`identity`, `key`), lint B2 e depcruise.
   - **Partição em commits atômicos (`[ARCHITECT]` + `[APPSEC]`, 2026-11-07; AGENTS §4.1, molde da F1-API-07).** Um commit por vez, cada um com 100% de cobertura em `src/{auth,api}/**`, a mutação do §4.7 que couber, turbo em série e depcruise. Nenhum toca o Supabase real nem o painel (protocolo, `SessaoView` e B1 são da F1-EXT-05b).
     - **05a-1, funções puras do fluxo e fronteiras:** `pkce.ts` (S256 com o vetor do RFC 7636, entropia injetada, sem `crypto.subtle` lança), `authorize-url.ts` (4 parâmetros exatos, `s256`, sem `response_type`, origem https exata ou lança) e `redirect.ts` (`parseAuthRedirect` em falha fechada: base byte a byte, fragmento só com o erro do IdP, `error` vira cancelamento sem ecoar, query só `{ code, st }`). `AUTH_PROVIDERS` no `protocol.ts` (só a constante: o painel também precisa da lista e nunca importa `src/auth`). `@trampo/contracts/auth` só em `src/auth`, `src/api` e nos testes (lint com fixtures negativas) e as 4 regras do B3 no depcruise. M-01 e M-02. **Concluído em 2026-11-07 (`78be3f2`).**
     - **05a-2, sessão guardada e cliente HTTP:** `session-schema.ts` (`StoredSessionSchema` do D9, revalidado na leitura pelo `sessionStore`) e `src/api/api-client.ts` (B9: origem e caminhos de lista fechada, Bearer só em `/v1/analyze` e `/v1/auth/logout`, `credentials: "omit"`, `redirect: "error"`, `cache: "no-store"`, `referrerPolicy: "no-referrer"`, 10 s e teto de resposta), com a regra do B2 "`fetch` só no `api-client`". M-07. **Concluído em 2026-11-07 (`ec9c915`)**, com as decisões no D9 e no D10 B9 ("Emenda do 05a-2"); mutação 55/55.
     - **05a-3, `auth-service.ts`:** porta `AuthCodeSource`, login do D3 (um fluxo por vez, prazo de 5 min, verifier apagado depois do envio), renovação preguiçosa com *single-flight* e geração (D11.1 a D11.3), logout local primeiro (D11.5), `onUnauthorized()` (D11.4) e cada linha do SW na tabela do D12 como teste nomeado (CA-14). Emite a `SessaoView` por *callback*; a ligação à porta do painel é da F1-EXT-05b. M-03 a M-06. **Concluído em 2026-11-07 (`db98323`)**, com as decisões no D3, no D11 e no D12 ("Emenda do 05a-3"); mutação 57/57.
     - **05a-4, SW e manifesto:** `web-auth-flow-source.ts` (o único arquivo com `browser.identity`), ligação no `background.ts`, `wxt.config.ts` (`identity`, `key` só com `TRAMPO_EXTENSION_KEY` validada como SPKI, `TRAMPO_SUPABASE_ORIGIN` validada e fora da CSP), `manifest.test.ts` do D13 com os dois builds (CA-01) e o resto do lint B2. **Concluído em 2026-11-08 (`cd141d2`)**, com as decisões no D3, no D10 B2 e no D13 ("Emenda do 05a-4"); mutação 55/55. Com ele, a F1-EXT-05a está concluída; a prova em runtime do P3 segue para o 1º E2E da F1-EXT-05c.
   - **P3 (`[ARCHITECT]` + `[APPSEC]`, 2026-11-07):** a prova do P3 é um login completo com o manifesto do D13, e isso exige o IdP falso e o E2E do §4.4 (F1-EXT-05c). O 05a-4 prova a parte estática (CA-01, sem `host_permissions` e com o `connect-src` só na API); a prova em runtime do P3 vai para o primeiro E2E da F1-EXT-05c. A condição do veto do §3 não muda: o F1-EXT-05 não fecha sem ela, e, se o P3 falhar lá, abre-se o HITL do D14.
4. **F1-EXT-05b:** painel (protocolo, `SessaoView`, botões, textos, "Reconectar"), meta CSP, lint B1 e grep do artefato.
   - **Partição em commits atômicos (`[ARCHITECT]` + `[APPSEC]`, 2026-11-08; AGENTS §4.1, molde da F1-EXT-05a).** Um commit por vez, cada um com 100% de cobertura, a mutação do §4.7 que couber, turbo em série e depcruise, e o E2E local no fim da trilha (CA-16). Nenhum toca o Supabase real nem provedor de LLM, e nenhum envia vaga à API (F1-EXT-04 parte 2).
     - **05b-1, isolamento e handshake:** no `protocol.ts`, o `SessaoErroSchema`, o `SessaoViewSchema` (strictObject com o `refine` do M-08, escrito como guarda de tipo para a saída ser a união do D12) e o `toSessaoView`, que copia só `autenticado` e `erro` e revalida antes de a visão sair do SW (valor fora do schema vira `{ false, ERRO_INTERNO }`); `entrar` e `sair` no `PanelToWorkerSchema` e `sessao` no `WorkerToPanelSchema`; o `worker-port` entrega `entrar` e `sair` ao SW; `src/messaging/session-channel.ts`, o hub da sessão (emissão saneada para todas as portas e um handshake que não sobrescreve um estado novo com um velho); o `createWorkerAuth` liga o canal e devolve o `attach`; o `background.ts` guarda a referência, liga `entrar` e `sair` e fecha o handshake `[ready, captura, consentimento, sessao]`; o `panel-state` guarda a `sessao`, ainda sem UI. Lint B1 num bloco próprio do painel, com fixtures negativas; meta CSP do B4 injetada por um plugin do Vite só no `mode` de produção (P16); no `manifest.test.ts`, a meta exata antes de qualquer script e o fecho exato do B5 a partir do `sidepanel.html`. No E2E, o handshake com 4 mensagens e a emenda do `csp.e2e.test.ts` (o painel perde a API, o SW continua só nela; `form-action` e Trusted Types), puxada da F1-EXT-05c porque a meta entra aqui. M-08 e mutação dirigida do saneamento, do canal, do B1, do B4 e do B5. **Concluído em 2026-11-08 (`abafafb`)**, com as decisões no D10 B1, B4 e B5 e no D12 ("Emenda do 05b-1"); mutação 83/83 na 2ª rodada.
     - **05b-2, estado e textos da sessão (lógica pura):** no `panel-state`, o "entrando" (liga no clique, desliga na próxima `sessao`, teto de 310 s com relógio injetado), o último clique em "Sair" para o texto da falha remota, o "Reconectar" (só a partir de `porta_fechada`; `resposta_invalida` continua definitiva) e o portão do "Analisar" (API, sessão e consentimento); no `texts.ts`, o `SESSION_TEXTS` exaustivo do D12. Testes do `panel-state` do §4.1. Emenda do ADR-025 D3. **Concluído em 2026-11-09 (`c61f50d`)**, com as decisões no D12 ("Emenda do 05b-2") e a emenda do ADR-025 D3; mutação 64/65 na 2ª rodada (1 equivalente, provado por teste de invariante).
     - **05b-3, botões e "Reconectar" no React, e E2E do painel:** "Entrar com GitHub", "Entrar com Google", "Sair da conta", "Tentar sair de novo" e "Reconectar" (novo `runtime.connect` e novo `hello`), sem identidade nem provedor na tela; E2E com a porta falsa (mensagens exatas enviadas, texto de cada `SessaoView`, "Reconectar" refaz o handshake) e o E2E local inteiro (CA-16). Emenda do ADR-025 D4 e D5. **Concluído em 2026-11-09 (`4b1259a`)**, com as decisões no D12 ("Emenda do 05b-3") e a emenda do ADR-025 D4, D5 e D6; mutação 32/33 (1 equivalente); E2E local 59/59 no Edge 157 (CA-16, registro no SESSION-LOG). **A F1-EXT-05b fechou.**
   - **`[APPSEC]` sobre a partição:** sem veto. Condições: (1) a `SessaoView` não ganha campo livre, e o SW só emite pelo `toSessaoView`; (2) a meta do B4 nunca chega ao dev (HMR) e sempre chega ao build de produção, com prova nos dois builds do `manifest.test.ts`; (3) o "Reconectar" é só ação do usuário, sem laço automático; (4) nenhuma mensagem nova leva texto livre, nem do SW ao painel nem do painel ao SW (B6).
5. **F1-EXT-05c:** E2E local com IdP falso, provas negativas e emenda do `csp.e2e.test.ts`.
   - **Partição em commits atômicos (`[ARCHITECT]` + `[APPSEC]`, 2026-11-09; AGENTS §4.1, molde da F1-EXT-05a e da F1-EXT-05b).** Um commit por vez, cada um com 100% de cobertura no que for lógica (os falsos do E2E entram na cobertura da extensão), a mutação dirigida que couber, turbo em série, depcruise e o E2E local inteiro (CA-16). Nenhum toca o Supabase real nem provedor de LLM, e nenhum envia vaga à API (F1-EXT-04 parte 2). Chave, tokens e canários com cara de segredo nascem em tempo de execução desde o 1º commit ([ADR-019-ci-github-actions](ADR-019-ci-github-actions.md) D6). Os cenários 3, 4, 5 e 12 do §4.4 esperam a F1-EXT-04 parte 2 e seguem provados pela unidade do `auth-service` (§4.1).
     - **05c-1, IdP falso, chave efêmera e P3 em runtime:** em `test/e2e/support/`, os canários (o access com `sub` e `session_id` canários e os 3 segmentos, o envelope `r1.e2e.<iv>.CANARIO_RT_<hex>.<tag>` e o cifrado, o código `CANARIO-CODE-<uuid>` e o verifier recebido; o coletor nas três formas), o estado do IdP falso (`authorize` com os 4 parâmetros exatos, `s256`, challenge de 43 e `redirect_to` exato; troca com `S256(verifier)`, uso único e 5 min; renovação que gira o par; logout só com o Bearer vivo) e os servidores (BFF falso em 47443, só para a origem exata da extensão; Supabase falso em 47444, que conta o `Origin: chrome-extension://` em qualquer caminho; chromiumapp local pelo `--host-resolver-rules`; canal de controle com segredo), todos no `global-setup`. A chave RSA efêmera fica em memória (só a SPKI pública sai) e vira o build `auth`, com as duas origens e a `key` (P17). O modo do P20 fica fixo por navegador (`p20.ts`). O `build-env.ts` recusa `TRAMPO_E2E_FAKE_IDENTITY` com ou sem `TRAMPO_E2E=1`, e o `manifest.test.ts` prova o build que falha e os artefatos sem marcador. O `csp.e2e.test.ts` passa ao BFF falso, e o SW não alcança o Supabase. O `auth.e2e.test.ts` traz o P17, o P20, o manifesto do D13 carregado, o controle positivo do chromiumapp e os cenários 1 (P3), 2 e 10, com os itens 2, 8 (`local` e `sync`) e 10 do §4.5 neles. O passo do QA-04 entra no harness: a espera da aba anterior no `clickAction` e a mensagem da rejeição do `executeScript` guardada só pelo teste, sem URL. Mutação dirigida nos falsos, no guarda do build, na tabela do P20 e no E2E do login. **Concluído em 2026-11-09 (`2861c6a`)**, com as decisões no §1.4 e no §4.4 ("Emenda do 05c-1"), no §4.5 e no §4.6; mutação 51/52 na 2ª rodada (o E-03, `interactive: false`, sobrevive só ao E2E, por desenho, e morre na unidade do adapter); E2E local 67/67 no Edge 157 em 3 rodadas e o login no Chrome 156 (CA-16, registro no SESSION-LOG).
     - **05c-2, cenários adversariais e de ciclo de vida:** os falsos ganham roteiro: o 302 segurado, o retorno com `error_description=CANARIO-ERR-<uuid>`, o retorno com outro caminho, com `#access_token=` e com o código de outro challenge, e o 503 no logout. Cenários 6 (recarga e relançamento com o perfil preservado; P13 e CA-10), 7, 8, 9, 13 (o resto: a sessão sobrevive ao handshake, e o 302 segurado dá 0 trocas e `sessao{ false, null }` depois de "Reconectar") e 14. **Concluído em 2026-11-09 (`8c59e5a`)**, com as decisões no §1.4 (P13) e no §4.4 ("Emenda do 05c-2"); mutação 34/34; E2E local 82/82 no Edge 157 em 3 rodadas e 43/43 no Chrome 156, com 1 pulado pela tabela do `runtime.reload()` (CA-16, registro no SESSION-LOG).
     - **05c-3, provas negativas do §4.5 depois de todos os cenários (SR-23, CA-04):** o espião no painel por `addInitScript` (item 1), o heap snapshot do painel e da aba (3), a rede do painel por *auto-attach* (4), a aba da vaga nos mundos MAIN e ISOLATED e o `storage.session` recusado no ISOLATED (6 e 7), a origem da extensão sem resto (8 inteiro: localStorage, IndexedDB e CacheStorage), o console por *auto-attach* (9) e o que os falsos receberam no total (10). O E2E local inteiro fecha a trilha (CA-16). Com ele, a F1-EXT-05c fecha e a F1-SEC-01 fica liberada. **Concluído em 2026-11-09 (`af7f03c`)**, com as decisões no §4.5 ("Emenda do 05c-3") e a CA-04 cumprida no E2E local; mutação 36/37 (o mutante que desliga o `waitForDebuggerOnStart` do coletor é equivalente no harness); E2E local 100/100 no Edge 157 em 3 rodadas e 61/61 no Chrome 156, com 1 pulado pela tabela do `runtime.reload()` (CA-16, registro no SESSION-LOG). **A F1-EXT-05c fechou.**
   - **`[APPSEC]` sobre a partição:** sem veto. Condições: (1) nenhum código de teste entra em `src/` nem no build: o modo 3 do P20 não existe enquanto nenhum navegador precisar dele, e a volta dele passa por HITL e pelo `[APPSEC]`; (2) os falsos nunca ficam mais permissivos que o BFF real (origem exata, código de uso único, S256 conferido, Bearer só no logout) e nunca guardam valor de cabeçalho; (3) todo "0" do E2E (Supabase com `Origin` de extensão, renovação depois do "Sair") tem um controle positivo que prova que o contador conta, na unidade dos falsos ou no próprio E2E; o chromiumapp local é medido, não zerado (§4.4, "Emenda do 05c-1"); (4) nenhum valor com cara de segredo nasce como literal no git, e o gitleaks 8.30.1 conferido varre os arquivos novos antes do commit.
6. **F1-SEC-01:** threat model v2 (TB10, TB11, T41 a T48, SR-18 a SR-24, §9) e revisão adversarial de auth. **Entregue em 2026-11-11 (sessão 19)**, com a emenda no §3 e a aprovação no *HITL-QUEUE §HITL-039*. Abriu a *BACKLOG §F1-API-08* e a *BACKLOG §F1-EXT-07*.
7. **F1-DB-02** (nova, emenda do HITL-035, 2026-11-06): Custom Access Token Hook por migration (D5), que recusa a emissão com `http_code` 403 quando a sessão passa de `AUTH_SESSION_MAX_AGE_SECONDS`; `config.toml` local com o hook ligado e `test:db` da recusa (§4.3). HITL de aplicação no projeto real (molde do HITL-023). Entra antes do aceite e não depende da F1-AUTH-00.
- O F1-EXT-04 parte 2 (envio à API) passa a depender da F1-EXT-05a.

### 6.4 Custos
- Dinheiro: zero. Nenhuma dependência nova (`node:crypto`, `fetch`, `crypto.subtle` e `jose` já existem).
- Complexidade: 3 rotas, um anel de chaves, um limitador local, um orçamento de saída, um *bulkhead* e 2 HITLs. É a opção mais pesada das avaliadas, e o peso compra o fechamento do gap do T9 e o `connect-src` intacto.

## 7. Perguntas para o humano (HITL-034)

**Q1. Direção da autenticação.**
- (a) `launchWebAuthFlow` + PKCE S256 com BFF sem estado e refresh selado (este ADR).
- (c) SW falando direto com o Supabase Auth, com `connect-src` em dois caminhos exatos.
- (b) Login no portal e *handoff*.
- **Recomendação: (a).** É a única que fecha o gap do T9 para as sessões do BFF sem o plano Pro e mantém o `connect-src` e o `externally_connectable` como estão. O fechamento por inteiro depende do hook (Q10).

**Q2. Idade máxima de sessão (`AUTH_SESSION_MAX_AGE_SECONDS`).**
- 12 h; **24 h**; 7 dias.
- **Recomendação: 24 h.** O reinício do navegador já zera a sessão na prática. 24 h limita um envelope roubado a um dia.

**Q3. Inatividade sem estado (`AUTH_SESSION_IDLE_SECONDS`).**
- 1 h; **4 h**; igual à idade máxima (sem inatividade própria).
- **Recomendação: 4 h.** Corta, sem rede, o *replay* de um envelope genuíno parado (RFC 9700 §4.14.2). O reinício do navegador já zera a sessão.

**Q4. Escopo do logout da extensão.**
- `global`: derruba também o portal e outros dispositivos.
- `local`: só a sessão da extensão, com emenda ao T9.4.
- **Recomendação: `global`.** Segue o T9.4 e o Blueprint (l.226). No MVP há um usuário e nenhum portal com login.

**Q5. Proteção das rotas públicas antes do S-5.**
- Limitador local de entrada pré-JWT sem Redis, orçamento de saída particionado e *bulkhead* (ADR-014 D10).
- Rate limit pré-JWT no Redis (contra a decisão de 2026-10-21).
- Esperar a Cloudflare do S-5 antes de abrir as rotas.
- **Recomendação: limitador local com orçamento de saída.** Preserva a decisão de 2026-10-21, reserva metade do orçamento para a renovação e não trava o S-3 no S-5.

**Q6. Se o P5 falhar (o Supabase recusar `?st=` no `redirect_to` exato).**
- Tirar o `state` e confiar no PKCE imposto pelo servidor (RFC 9700 §4.7.1), com emenda ao ADR-001.
- Usar curinga na Redirect URL (vetado pelo `[APPSEC]`).
- **Recomendação: tirar o `state`**, condicionado ao P8.
- **Emenda do HITL-035 (2026-11-06):** não acionada (P5 aprovado); rearmada para o S-5 (D15).

**Q7. JWKS fora no meio da renovação.**
- Falha fechada com pré-checagem de chaves (D6): a sessão sobrevive à queda comum, e o caso raro custa um novo login.
- Repasse sem verificação (falha aberta).
- **Recomendação: falha fechada.**

**Q8. Onde o spike real roda.**
- API local com certificado de teste, num perfil descartável do navegador, só durante o spike.
- Esperar a hospedagem do S-5.
- **Recomendação: API local.** Não acopla o S-3 ao S-5. O perfil descartável nunca é o do dia a dia.

**Q9. Novos cadastros no Supabase na Fase 1.**
- Desligar depois de criar a conta do autor; manter ligados.
- **Recomendação: desligar.** Impede contas descartáveis consumindo cota.
- **Emenda do HITL-035 (2026-11-06):** aprovada e ainda não aplicada (runbook §2.2 sem marca; *HITL-QUEUE §HITL-036*).

**Q10. T9 para sessões criadas fora do BFF.**
- Custom Access Token Hook como condição para fechar o T9 por inteiro, se o P18 confirmar no Free (migration por HITL); sem ele, residual T48 declarado e aceito aqui.
- Aceitar o residual já, sem avaliar o hook.
- **Recomendação: hook como condição, se existir no Free.** Ele cobre todas as sessões, inclusive as do atacante (T48), a chave vazada e a sessão órfã.
- **Emenda do HITL-035 (2026-11-06):** resolvida pelo P18: o hook é condição de aceite (D5, F1-DB-02).

**Q11. Expor o provedor no painel.**
- Manter a `SessaoView` só com booleano e códigos (requisito 3) e aceitar o residual "conta trocada não detectável no painel".
- Pôr `provedor` (`github` ou `google`) na `SessaoView` e mostrar "Conectado com GitHub", com emenda ao requisito 3.
- **Recomendação: manter só booleano e códigos.** O residual fica no §3.

**Q12. Contingências do D14.**
- Registrar C1 e C2 como contingências, cada uma ativada só por HITL próprio; descartar.
- **Recomendação: registrar, sem ativar.**

**Q13. Riscos residuais do §3.**
- Aceitar a lista, com o residual M do T9 (AT8) entrando no §9 do threat model; pedir mitigação adicional em algum item.
- **Recomendação: aceitar.** Cada item tem dono, prazo (portão da Fase 2 ou S-5) ou prova automática.

**Q14. Ordem entre login e consentimento.**
- Independentes (qualquer ordem, ambos exigidos para enviar); login antes; consentimento antes.
- **Recomendação: independentes.** A troca não leva dado do usuário, e o envio exige os dois (ADR-025 D2).
