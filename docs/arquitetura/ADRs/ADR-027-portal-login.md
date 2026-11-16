---
tipo: adr
id: ADR-027
titulo: "Login do portal (F1-PORTAL-01): PKCE iniciado e trocado no servidor do Next.js, sessão num cookie __Host- selado (AES-256-GCM), HttpOnly, Secure e SameSite=Lax, renovação no proxy, logout local por POST com Origin conferido e CSP com nonce e frame-ancestors 'none'"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC], sem veto, 12 condições). Não muda contrato público, a API nem a extensão. O 1º login contra o projeto real é o HITL-041."
data: 2026-11-13
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "apps/web-portal (src/server, src/app, src/proxy.ts, next.config.ts, test/), packages/config/dependency-cruiser.cjs, .gitleaks.toml"
substitui: null
relacionados: ["[ADR-004-extension-auth](ADR-004-extension-auth.md)", "[ADR-013-jwt-verification](ADR-013-jwt-verification.md)", "[ADR-026-custom-access-token-hook](ADR-026-custom-access-token-hook.md)", "[ADR-007-api-edge](ADR-007-api-edge.md)", "[ADR-018-postgres-schema-rls-and-criteria](ADR-018-postgres-schema-rls-and-criteria.md)", "[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[threat-model](../threat-model.md)", "*BACKLOG §F1-PORTAL-01*", "*HITL-QUEUE §HITL-041*", "*auth-portal*"]
---

# ADR-027: Login do portal

## 1. Contexto

O [ADR-004-extension-auth](ADR-004-extension-auth.md) deixou o login do portal fora do escopo (L9) e decidiu que **o portal não usa o BFF da extensão**: a origem web leva 403 em `/v1/auth/*` (D8, L463; [ADR-007-api-edge](ADR-007-api-edge.md) L90). O [threat-model](../threat-model.md) só tem, para o portal, a ficha T33 (CSRF e clickjacking, sem verificação nem residual) e a TB5 (portal → API). O [ADR-026-custom-access-token-hook](ADR-026-custom-access-token-hook.md) §3 avisa que o hook vale para **toda** sessão do projeto: a do portal morre 24 h depois do login, com qualquer atividade, e a recusa da renovação precisa virar "entre de novo".

`apps/web-portal` é o scaffold do `create-next-app` (Next.js 16.4.2, React 19.3), com `cacheComponents` e `partialPrefetching` ligados, sem login, sem CSP e sem `@supabase/*` no lock.

### 1.1 Fatos conferidos antes do desenho

Fonte do Next.js: a documentação oficial **da versão instalada**, que o pacote traz em `node_modules/next/dist/docs` (16.4.2). Fonte do Supabase: o MCP `search_docs` (2026-11-13). Nada de memória.

| # | Fato | Fonte |
|---|---|---|
| N1 | Nonce na CSP exige renderização dinâmica; o Next extrai o nonce do cabeçalho `Content-Security-Policy` **do pedido** (posto pelo proxy) e o aplica sozinho aos scripts do framework, aos bundles e aos inline que ele gera | `01-app/02-guides/content-security-policy.md` ("How nonces work in Next.js") |
| N2 | "**Partial Prerendering (PPR) is incompatible** with nonce-based CSP since static shell scripts won't have access to the nonce" | idem, "Static vs Dynamic Rendering with CSP" |
| N3 | `cacheComponents` implementa o PPR como padrão do App Router | `03-api-reference/05-config/01-next-config-js/cacheComponents.md` |
| N4 | A alternativa por hash (SRI) é **experimental** e não cobre script gerado em tempo de execução | `content-security-policy.md` ("Subresource Integrity (Experimental)", "Limitations of SRI") |
| N5 | O exemplo oficial da CSP com nonce: `default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic'; style-src 'self' 'nonce-…'; img-src 'self' blob: data:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests`; `'unsafe-eval'` só em desenvolvimento | idem, "Adding a nonce with Proxy" |
| N6 | O `proxy.ts` (antigo `middleware`) roda no runtime Node.js por padrão, em **toda rota** sem `matcher`, inclusive estáticos; pode ler e gravar cookies e cabeçalhos do pedido e da resposta. Ordem: `headers` do `next.config` primeiro, depois o proxy | `03-file-conventions/proxy.md` ("Matcher", "Runtime", "Execution order", "Using Cookies") |
| N7 | O proxy **não basta** como controle de acesso: a autenticação se confere de novo perto do dado (Data Access Layer), e só a DAL lê `process.env` | `proxy.md` (Good to know da ordem) e `02-guides/data-security.md` ("Data Access Layer") |
| N8 | `cookies()` só **lê** em Server Component; **gravar** só em Route Handler ou Server Function. Opções: `httpOnly`, `secure`, `sameSite`, `maxAge` (0 apaga) | `03-api-reference/04-functions/cookies.md` |
| N9 | Dois `headers()` do `next.config` com a mesma chave: vale o último | `05-config/01-next-config-js/headers.md` |
| N10 | `poweredByHeader: false` tira o `x-powered-by` | `05-config/01-next-config-js/poweredByHeader.md` |
| S1 | Os cookies do `@supabase/ssr` **não** são `HttpOnly` por desenho ("How do I make the cookies `HttpOnly`? This is not necessary… The browser-based side of your application needs access to the refresh token") | `supabase.com/docs/guides/auth/server-side/advanced-guide` |
| S2 | Cookie `HttpOnly` com os tokens "é possível, mas só para apps server-only"; as bibliotecas JS dão "suporte limitado" | `supabase.com/docs/guides/auth/sessions` ("Using HTTP-only cookies…") |
| S3 | Logout com escopo `global` (padrão: todas as sessões do usuário), `local` (só a sessão corrente) ou `others`; o access de sessão revogada vale até o `exp` | `supabase.com/docs/guides/auth/signout` |
| S4 | Rotação do refresh ligada, com reuso tolerado por 10 s (o mesmo refresh pode ser trocado de novo nesse intervalo) | `supabase/config.toml` (`refresh_token_reuse_interval = 10`); runbook `auth-extensao` §2.3 (projeto real) |
| S5 | O `redirect_to` com `?st=<state>` volta intacto com a Redirect URL exata, sem curinga (P5 aprovado) | *HITL-QUEUE §HITL-035*; runbook `auth-extensao` §2.1 e §3 |
| S6 | Troca: `POST /auth/v1/token?grant_type=pkce` com `{ auth_code, code_verifier }`; recusa só com o corpo do GoTrue e `error_code` string; o 403 do hook sai com `error_code` `unknown` | [ADR-004-extension-auth](ADR-004-extension-auth.md) D4, D7 (F1-API-08); [ADR-026-custom-access-token-hook](ADR-026-custom-access-token-hook.md) D3 |

## 2. Decisões

### D1. Cliente próprio, sem SDK
O portal fala com o GoTrue por um cliente próprio em `src/server/gotrue.ts`, **no molde** do `gotrue-token-client` da API (lista fechada de cabeçalhos, `redirect: "error"`, prazo de 5 s, teto de 32 KiB, UTF-8 estrito, JSON sem chave de protótipo, classificação `recusado | nao_recebido | pode_ter_rotacionado`, nunca rejeita), **reescrito e não importado** (aresta proibida `clients-not-to-api`, [ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md) §10.3).
- **Por que não o `@supabase/ssr`:** os cookies dele são legíveis pelo JS (S1), contra o requisito do T33 e do BACKLOG; o `HttpOnly` só tem "suporte limitado" (S2); e o ADR-018 D5 já recusou o `@supabase/supabase-js` por não impor teto nem prazo. Também evita dependência nova (T26).
- **Dependências do portal:** `jose` (já no catálogo e no lock, versão 6.2.12 da API; nenhum pacote novo) e, só em teste, `vitest`, `@vitest/coverage-v8`, `vite` e `playwright-core` (todos do catálogo). O `pnpm-lock` muda só pelas ligações do workspace.

### D2. Fluxo: PKCE no servidor
1. **`GET /auth/entrar?provedor=<google|github>`** (Route Handler). Link comum, não formulário: a CSP `form-action` vale também para os redirecionamentos depois do envio, e a cadeia passaria pelo Supabase e pelo IdP.
   - Exige `Sec-Fetch-Site` igual a `same-origin` (clique no portal) ou `none` (URL digitada). `cross-site`, `same-site` ou ausente: 303 para `/?aviso=entrada_recusada`, **sem cookie e sem rede**. Isso tira do atacante o login silencioso disparado de fora (P14 do T48) e a troca do fluxo em curso da vítima.
   - Provedor fora da lista fechada `google | github` ([ADR-004-extension-auth](ADR-004-extension-auth.md) D2): o mesmo aviso.
   - Gera o verifier (32 bytes, base64url, 43 caracteres) e o `state` (16 bytes, 22), o challenge S256, e grava o **cookie do fluxo** (D3). Responde **303** para `${SUPABASE_URL}/auth/v1/authorize?provider=…&redirect_to=${PORTAL_ORIGIN}/auth/retorno?st=<state>&code_challenge=…&code_challenge_method=s256`, com os 4 parâmetros na ordem e codificados um a um, sem `response_type` (molde do `authorize-url.ts` da extensão).
   - Um fluxo por vez por navegador: um novo `entrar` sobrescreve o cookie do fluxo anterior.
2. **`GET /auth/retorno?code=…&st=…`**, em falha fechada, nesta ordem e sem rede até o passo 4:
   1. a query tem **exatamente** as chaves `code` e `st`, cada uma uma vez (o retorno de erro do GoTrue, `error`, `error_code`, `error_description`, cai aqui: nunca exibido nem registrado);
   2. o cookie do fluxo existe, abre (AEAD) e tem até 300 s;
   3. `st` é igual ao `state` do cookie (comparação em tempo constante);
   4. o cookie do fluxo é **apagado** na resposta, dê certo ou não (uso único);
   5. troca `{ auth_code, code_verifier }` no GoTrue, **sem nova tentativa** (o código é de uso único, D4 do ADR-004);
   6. o access recebido passa pelo verificador (D5) e precisa trazer `session_id`;
   7. grava o **cookie da sessão** (D3) e responde 303 para **`/conta`**, destino fixo.
   - Qualquer falha: 303 para `/?aviso=<código>` com o código do catálogo fechado (D7). Recusa do GoTrue ou do verificador: `login_falhou`; GoTrue que não recebeu ou pode ter processado, JWKS fora ou token fora da política: `servico_indisponivel` (T30).
   - **Sessão órfã** (o GoTrue emitiu e o verificador recusou ou o selo falhou): um logout `local` em segundo plano, uma tentativa, com o access recebido (molde do E-03 da revisão adversarial).
3. **Nenhuma rota lê destino do pedido.** Não há `redirect_to`, `next`, `returnTo` nem `Referer` como destino: os destinos são as constantes `/`, `/conta` e o `authorize` montado de `SUPABASE_URL`. O `redirect_to` que vai ao GoTrue sai de `PORTAL_ORIGIN` (variável validada no boot) mais o caminho fixo. Proibido por desenho, e o teste prova que nenhum parâmetro muda o destino (D15 do ADR-004: "o portal fica proibido de ter open redirect").

### D3. Cookies
Dois cookies, ambos com o prefixo **`__Host-`** (exige `Secure`, `Path=/` e nenhum `Domain`: um subdomínio não consegue plantar nem sobrescrever o cookie), `HttpOnly`, `Secure` e `SameSite=Lax`:

| Cookie | Conteúdo (selado, D4) | `Max-Age` |
|---|---|---|
| `__Host-trampo-fluxo` | `{ v: verifier, st: state, p: provedor, iat }` | 300 (o prazo do código, D2 do ADR-004) |
| `__Host-trampo-sessao` | `{ at: access, rt: refresh, sid, sst: início da sessão, iat: última selagem }` | o que falta para `sst + 86.400`, arredondado para baixo |

- **`Lax`, não `Strict`:** o retorno do IdP é uma navegação de topo vinda de outro site; com `Strict`, o cookie do fluxo não chegaria ao `/auth/retorno` e o login nunca fecharia. O `Lax` não manda o cookie em POST, `iframe` nem `fetch` de outro site.
- **Um cookie só para a sessão:** access e refresh nunca se dessincronizam (gravação atômica). O teto do navegador é cerca de 4.096 bytes por cookie; o access do portal fica limitado a **2.300 caracteres** e o texto claro a 2.950 bytes: o pior caso (access no teto, refresh de 512) cabe no selo, e o par nome=valor do cookie fica abaixo de 4.096 mesmo com o `kid` de 16 caracteres (provado por teste). Access maior: `servico_indisponivel` com a sessão órfã encerrada (D2), nunca um cookie cortado. O tamanho real do access do projeto é **medido no HITL-041** (só o número). Se passar, a decisão volta ao `[ARCHITECT]` (dividir em dois cookies selados).
  - **Emenda do HITL-041 (sessão 30, 2026-11-14):** o login real passou com o Google e com o GitHub, mas o humano **não anotou o Size**. Pelo próprio teto deste D3, o login que funcionou prova **access ≤ 2.300 caracteres nos dois provedores** (acima disso, o selo recusa com `servico_indisponivel`). O número exato e o gatilho de 2.000 (a margem para dividir em dois cookies) ficam **sem medida**. Decisão do `[ARCHITECT]`: **não dividir agora.** O risco é de disponibilidade, não de segurança: um access maior nega o login com aviso, nunca corta o cookie. A F1-PORTAL-02 não acrescenta nada ao JSON da sessão (os critérios vêm da API a cada página e nunca vão para cookie). O próximo login real (o roteiro do 1º salvamento real de critérios, ou o S-5) anota o Size pelo *auth-portal* §3.2. Detalhe na §8.
- **`Max-Age` da sessão preso às 24 h:** o navegador descarta o cookie quando o hook já recusaria a renovação; o portal não promete "manter conectado" acima disso (ADR-026 §3).
- Nenhum outro cookie. Nenhum token, código, verifier, `state` ou e-mail em `localStorage`, `sessionStorage`, query, HTML ou JS do cliente.

### D4. Selo dos cookies (AES-256-GCM)
- **Formato:** `<versão>.<kid>.<iv>.<cifrado>.<tag>` em base64url canônica, com versão `s1` (sessão) ou `f1` (fluxo), IV de 96 bits e tag de 128 bits (molde do `aead-envelope` do ADR-004 D5, reescrito no portal).
- **AAD por finalidade:** `trampo:portal.sessao:s1:<PORTAL_ORIGIN>` e `trampo:portal.fluxo:f1:<PORTAL_ORIGIN>`. O cookie do fluxo nunca abre como sessão, e vice-versa.
- **Anel:** `PORTAL_SEAL_KEYS` (1 a 4 `kid:<32 bytes em base64url>`, `kid` em `[a-z0-9]{1,16}`) e `PORTAL_SEAL_ACTIVE_KEY`. O boot recusa forma errada, `kid` repetido, material repetido e chave ativa fora do anel. **Material próprio do portal**: nunca o mesmo do `AUTH_REFRESH_SEAL_KEYS` da API (o portal não tem como conferir outro processo; regra no runbook e regra do gitleaks para a variável nova).
- **Texto claro** em `strictObject`, conferido depois de abrir; envelope que não abre, fora da forma ou com base64url não canônica vale como "sem cookie".
- **Por que selar o refresh, e não guardá-lo cru** (efeito no T44 e no T47):
  - **T44 (roubo e replay):** com o cookie cru, quem o lê (cópia do perfil do navegador, backup, malware com acesso ao disco) usa o refresh **direto no GoTrue**, de qualquer lugar, sem idade máxima local nem inatividade. Selado, o cookie só serve **através do portal**, que impõe a idade (`sst`), a inatividade e o `sid`; e a rotação de chave (troca do `PORTAL_SEAL_ACTIVE_KEY` e retirada da antiga) invalida todos os cookies de uma vez.
  - **T47 (chave vazada):** o selo cria um segredo novo do portal. A chave sozinha não dá nada (o cookie é `HttpOnly`); chave e cookie juntos dão o refresh cru, que o hook limita a 24 h. É o mesmo residual do T47 da extensão, num anel separado.
- **Idade e inatividade sem rede**, como o D5 do ADR-004: `sst + 86.400` (a mesma constante do hook) e `iat + 14.400` (4 h sem renovação). Vencidas: sessão `expirada`, cookie apagado, sem chamar o GoTrue.

### D5. Verificação do access (o portal não confia no cookie)
- Toda página protegida chama a DAL (`src/server/session.ts`), que abre o cookie e **verifica o access** com o `jose`: ES256 fixo, `typ` JWT, `kid` obrigatório, `issuer` `${SUPABASE_URL}/auth/v1`, `clockTolerance` 10 s, `maxTokenAge` 900 s, e depois da assinatura `aud` e `role` iguais a `authenticated`, `sub` UUID, `is_anonymous` `false`, **`session_id` UUID obrigatório e igual ao `sid` do selo**, e `amr` lista de `{ method }` não vazia com **todo** método `oauth` ([ADR-013-jwt-verification](ADR-013-jwt-verification.md) D4; [ADR-004-extension-auth](ADR-004-extension-auth.md) D6). `password`, `otp`, `magiclink` e `anonymous` são recusados; o portal não tem variável `AUTH_ALLOWED_AMR` (só `oauth`, fixo).
- JWKS de `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`, com timeout de 3 s, cache de 10 min, cooldown de 30 s e teto de 64 KiB ([ADR-013-jwt-verification](ADR-013-jwt-verification.md) D5). JWKS fora, vazio ou sem EC P-256: `indisponivel`, nunca "entre de novo" (T30).
- Da verificação só saem `userId`, `sessionId` e `expiresAt`. E-mail, `user_metadata` e `app_metadata` nunca entram no portal nesta trilha.

### D6. Renovação no proxy
O `src/proxy.ts` roda em todo pedido (N6) e, **só nos `GET` de página** (fora de `/auth/*`, `/_next/*` e arquivos com extensão):
1. abre o cookie da sessão; sem cookie ou sem abrir: estado `ausente` (o cookie inválido é apagado);
2. idade ou inatividade vencidas: `expirada`, cookie apagado;
3. access com mais de 60 s pela frente: segue;
4. senão, renova no GoTrue com o `rt`:
   - **200** e o access novo passa no verificador com o mesmo `sid`: sela de novo (mesmo `sst`, `iat` novo), grava o cookie na resposta **e** troca o cookie do pedido (a página já vê a sessão nova);
   - **`recusado`** (inclusive o **403 `error_code` `unknown` do hook**, ADR-026 D3, e o `sid` divergente): `expirada`, cookie apagado. A página diz "Sua sessão expirou. Entre de novo." **Nunca** nova tentativa em laço;
   - **`nao_recebido`** (429, 5xx, conexão recusada, redirecionamento, recusa sem o corpo do GoTrue) e JWKS fora: `indisponivel`, **o cookie fica** (T30: o 503 nunca apaga a sessão);
   - **`pode_ter_rotacionado`**: **uma** nova tentativa com o mesmo `rt` em até 2 s (o reuso de 10 s do GoTrue devolve a sessão, S4); falhando de novo, `indisponivel` com o cookie.
- O estado vai à página num cabeçalho **do pedido**, `x-trampo-sessao` (`ativa | ausente | expirada | indisponivel`), que o proxy **sempre apaga e reescreve** (um valor mandado pelo cliente nunca chega à página). Ele só escolhe o aviso: a DAL verifica o access de novo (N7) e nunca dá acesso por causa do cabeçalho.
- Corrida: duas abas renovando juntas trocam o mesmo `rt` dentro dos 10 s de reuso (S4); a última gravação vence, e as duas sessões resultantes são a mesma.
- **Orçamento do GoTrue:** o portal sai do mesmo projeto e, em produção, de outro IP que a API; os tetos por IP do D8 do ADR-004 (L481) não se dividem com ele, a não ser que os dois fiquem no mesmo IP (S-5). Sem limitador local nesta trilha: cada renovação é provocada pela navegação do próprio usuário, no máximo uma a cada 14 min por sessão. Fica como residual (§3).

### D7. Logout e avisos
- **`POST /auth/sair`** por formulário, com o `Origin` **exatamente** igual a `PORTAL_ORIGIN` **e** `Sec-Fetch-Site` `same-origin`. Sem isso: 403 com corpo fixo, sem tocar no cookie nem na rede. `GET /auth/sair` não existe (405).
- **Escopo `local`** (S3): encerra só a sessão do portal. **Por quê:** o "Sair" do portal não deve derrubar a extensão do mesmo usuário (outra sessão, outro dispositivo); o `global` da extensão continua derrubando o portal ([ADR-004-extension-auth](ADR-004-extension-auth.md) D11.5, L649), e isso fica documentado. "Sair de todos os dispositivos" (escopo `global`) vira item novo do *BACKLOG* (F1-PORTAL-04), com o próprio `[APPSEC]`.
- **Ordem:** o cookie é apagado **sempre**, primeiro (o logout local é imediato e incondicional, como o D11.5). Com access a menos de 60 s do fim, renova antes (D6) para o Bearer valer. Depois, `POST ${SUPABASE_URL}/auth/v1/logout?scope=local` com o Bearer, uma tentativa. Só o 2xx e o 403 `session_not_found` (contrato do 07h) são sessão encerrada: destino `/?aviso=saiu`. Qualquer outro resultado: `/?aviso=saiu_local`, que diz "Você saiu deste navegador, mas não conseguimos confirmar com o servidor. A sessão expira sozinha em até 24 h."
- **Catálogo fechado dos avisos** (`?aviso=` só escolhe um texto fixo; valor fora do catálogo é ignorado): `entrada_recusada`, `login_falhou`, `servico_indisponivel`, `sessao_expirada`, `saiu`, `saiu_local`. Nenhum texto do GoTrue, do IdP ou do pedido vai à tela.

### D8. Cabeçalhos de segurança e CSP
- **CSP com nonce, pelo proxy, em toda resposta** (N1, N5, N6). Por pedido, nonce de 16 bytes aleatórios em base64:
  `default-src 'self'; script-src 'self' 'nonce-<n>' 'strict-dynamic'; style-src 'self' 'nonce-<n>'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` e, com `PORTAL_ORIGIN` em https, `upgrade-insecure-requests`. `'unsafe-eval'` só com `NODE_ENV=development` (N5). O `base-uri 'none'` é mais estrito que o exemplo (o portal não usa `<base>`).
- **`cacheComponents` e `partialPrefetching` desligados no portal.** O PPR é incompatível com o nonce (N2, N3) e o hash por SRI é experimental (N4). O portal é uma área logada: toda página já é dinâmica (lê cookie), e o shell estático não traz ganho. Fica registrado para quem religar: religar exige outra estratégia de CSP e novo `[APPSEC]`.
- **Os demais cabeçalhos pelo `headers()` do `next.config`**, em `/:path*` (antes do proxy, N6), uma vez cada: `X-Frame-Options: DENY` (navegador antigo sem `frame-ancestors`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` (a URL do retorno leva o código), `Permissions-Policy` fechada (`camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()`), `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin` e `Strict-Transport-Security: max-age=63072000; includeSubDomains` (ignorado em http; sem `preload` até o domínio existir). `poweredByHeader: false` (N10).
- **`Cache-Control: no-store`** nas rotas `/auth/*` e na `/conta`.
- **Prova:** teste de integração contra o `next start` de verdade que confere **cada** cabeçalho, **exatamente uma vez**, em página, rota de auth, erro, 404 e estático. Se o Next não aplicar algum deles em algum desses caminhos, o teste cai e a decisão volta aqui (fato a sondar na Etapa 2).

### D9. Configuração
Lida só na DAL do servidor (`src/server/config.ts`, N7), validada com Zod na primeira leitura, em falha fechada e com mensagens que nunca repetem o valor:
- `PORTAL_ORIGIN`: origem exata em https, ou http só em loopback (como o `isSupabaseOrigin` da API);
- `SUPABASE_URL` (mesma regra) e `SUPABASE_PUBLISHABLE_KEY` (só `sb_publishable_…`; `sb_secret_` e `eyJ` recusadas);
- `PORTAL_SEAL_KEYS` e `PORTAL_SEAL_ACTIVE_KEY` (D4);
- **emenda da F1-PORTAL-02 (sessão 30, [ADR-028-portal-criteria](ADR-028-portal-criteria.md) D3):** `API_ORIGIN`, a origem exata da API (https, ou http só em loopback), obrigatória. São 6 variáveis no `.env.example` do portal.
- Turbo: nenhuma delas em `globalEnv` ([ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md) L389). O build do portal não lê nenhuma (tudo em tempo de execução); o `.env.example` do portal documenta as 5, sem valor.

### D10. Logs
Nenhum `console.*` nos módulos de `src/server`, de rota e do proxy (lint). Nenhum código, verifier, `state`, token, envelope, `error_code`, e-mail ou `sub` sai do portal (SR-12). O E2E captura a saída do processo do `next start` e procura os canários.

### D11. Fronteiras do código
- `src/server/` só é importado por `src/app/**` (páginas e rotas) e por `src/proxy.ts`. Componente de cliente, se um dia existir, fica em `src/client/` e **não** importa `src/server/` (regra nova de depcruise, `portal-client-not-to-server`, com fixture de prova negativa).
- Nenhum `"use client"` nesta trilha: as páginas são Server Components com HTML e formulários.
- O portal não importa `apps/api` nem `apps/extension` (regras de hoje).

### D12. O que o portal NÃO faz nesta trilha
Critérios (F1-PORTAL-02), exportar e excluir a conta (F1-PORTAL-03), "Sair de todos os dispositivos" (F1-PORTAL-04), handoff para a extensão (`externally_connectable`, [ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md) §5.0.1), chamada à API ou ao PostgREST, e-mail ou nome na tela, e qualquer página além de `/` e `/conta`.

## 3. Auditoria do `[APPSEC]` (sem veto, 12 condições)

**Ameaças:** T33 (CSRF e clickjacking), T41 (CSRF de login), T42 (downgrade e redirect), T44 (roubo e replay da sessão, agora do cookie), T47 (chave do selo), T48 (fluxo do atacante: a sessão do portal também morre em 24 h pelo hook) e SR-12. Fronteiras novas no [threat-model](../threat-model.md): **TB12** (navegador ↔ servidor do portal, cookie selado) e **TB13** (servidor do portal → Supabase Auth); fichas novas **T49** (cookie da sessão do portal lido ou reaproveitado) e **T50** (desvio da CSP ou dos cabeçalhos do portal); SR novos **SR-25** e **SR-26**.

**Condições (cada uma com teste):**
1. **Nenhum token legível pelo JS:** no E2E, o `document.cookie` da página logada não tem `trampo` nem nenhum canário, e o HTML e os scripts da página não trazem o access, o refresh nem o `sub`.
2. **Atributos exatos:** os dois `Set-Cookie` com `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, sem `Domain` e com o `Max-Age` do D3; o apagar com `Max-Age=0` e os mesmos atributos.
3. **`state` e PKCE:** `st` diferente, ausente, repetido, chave extra na query, cookie de fluxo ausente, vencido, adulterado ou de outra finalidade: nenhuma chamada ao GoTrue. O verifier nunca sai do servidor (nem no HTML, nem na URL do `authorize`, que só leva o challenge).
4. **Sem open redirect:** nenhum parâmetro, cabeçalho ou `Referer` muda o destino de nenhuma rota; teste por tabela de entradas hostis.
5. **Origin no logout:** sem `Origin`, com outra origem, com `null` ou com `Sec-Fetch-Site` diferente de `same-origin`: 403, cookie intacto e nenhuma chamada ao GoTrue.
6. **Recusa e indisponível nunca se confundem:** o 403 `unknown` do hook vira "entre de novo" com o cookie apagado; o 503, o 429, a conexão recusada, a recusa sem o corpo do GoTrue e o JWKS fora mantêm o cookie e mostram o aviso de indisponível. Nunca nova tentativa em laço.
7. **`amr`:** `password`, misto `oauth` + `password`, lista vazia e a forma RFC 8176 recusados; o `sid` divergente recusado.
8. **Clickjacking:** no E2E, a página do portal num `iframe` de outra origem não carrega; os cabeçalhos do D8 em toda resposta, uma vez cada.
9. **SR-12:** nenhum canário do GoTrue simulado (código, verifier, tokens, e-mail, `error_code`) na saída do processo do portal.
10. **Fronteiras:** a regra nova de depcruise com prova negativa; nenhum `"use client"`; nenhum `console.*` em `src/server`.
11. **Mutação dirigida** (`mut_portal01.py`, §4.3) antes do push.
12. **O 1º login real só por HITL** (*HITL-QUEUE §HITL-041*), com a Redirect URL do portal na allow-list exata. Enquanto o portal não tiver hospedagem (S-5), a entrada de loopback é **temporária**: some da allow-list no fim do roteiro, e o humano confirma.

**Residuais (vão para a §9 do [threat-model](../threat-model.md)):**
- **Cookie roubado (T49):** quem tiver o cookie selado (malware no perfil do navegador) usa a sessão **pelo portal** até a inatividade (4 h) ou a idade (24 h). Vinculação ao dispositivo fica para a Fase 2, como na extensão (T44).
- **Access revogado:** vale até o `exp` (900 s) depois do logout (S3).
- **Sem limitador local da renovação** (D6): um script com um cookie válido pode navegar em laço e gastar o balde do `/token` do IP do portal; cada renovação exige um cookie com refresh vivo. Revisar no S-5 (balde real, P19).
- **Sondagem do `Secure` em loopback:** o E2E roda o portal em `http://127.0.0.1`. Se o navegador recusar cookie `Secure` nessa origem, o E2E sobe atrás de TLS local, e o fato vai para a Etapa 2.
- **Hospedagem e domínio** (S-5): HSTS com `preload`, a Redirect URL definitiva e o Site URL (D15 do ADR-004) mudam juntos; até lá, só o roteiro temporário do HITL-041.

## 4. Plano de testes (`[QA_EVALS]`)

### 4.1 Unidade (Vitest, `apps/web-portal/test/unit`), 100% nas 4 métricas em `src/server`
- `config`: cada variável, cada forma recusada, mensagens sem o valor.
- `seal`: ida e volta; AAD de outra finalidade e de outra origem; adulteração de cada parte; base64url não canônica; `kid` desconhecido; texto claro acima do teto; anel com material ou `kid` repetidos.
- `pkce`: verifier e `state` (tamanhos, alfabeto), S256 contra o vetor do RFC 7636 apêndice B.
- `cookies`: atributos exatos, `Max-Age` da sessão pelo `sst`, apagar.
- `gotrue`: classificação de cada status, corpo e falha de rede, cabeçalhos de saída em lista fechada, `scope=local` fixo, projeção dos 4 campos.
- `verifier`: cada claim do D5, `amr` hostil, `sid` divergente, JWKS fora.
- `session` (renovação e DAL): a tabela do D6 inteira, inclusive a recusa do hook e o `pode_ter_rotacionado` com uma nova tentativa só.
- `headers`: a CSP montada (nonce, `upgrade-insecure-requests` só em https, `unsafe-eval` só em dev).

### 4.2 Integração (socket real, `test/integration`)
- GoTrue simulado próprio do portal (molde do `fake-gotrue.ts` da API, sem import): `authorize` que confere o challenge e responde 302 para o `redirect_to` com o código; `token` PKCE com S256 conferido e uso único; renovação com rotação, reuso de 10 s e a **recusa do hook** (403 `{ code: 403, error_code: "unknown", msg }`); modos 503, 429, HTML 403, lento e corta; JWKS ES256 com chave gerada no teste; canários.
- As rotas (`entrar`, `retorno`, `sair`) e o proxy chamados como funções com `Request` de verdade contra o simulado.
- **Contra o `next start`** em 127.0.0.1: os cabeçalhos do D8 em toda resposta (página, auth, erro, 404, estático), uma vez cada.

### 4.3 E2E (Playwright, Edge do sistema, `test/e2e`) e mutação
- Login completo pelo simulado; `/conta` com a sessão; `document.cookie` sem nada da sessão (condição 1); renovação recusada pelo hook vira "entre de novo"; 503 mantém a sessão; logout; o portal num `iframe` não carrega; saída do processo sem canário. Três rodadas.
- **`mut_portal01.py`** (molde do `mutlib.py` da sessão 23), cada mutante precisa derrubar a unidade, a integração ou o E2E: cookie sem `HttpOnly`; `SameSite=None`; sem `Secure`; `st` não conferido; verifier no cliente (na URL ou no HTML); `frame-ancestors` retirado; `Origin` não conferido no logout; a recusa do hook tratada como 503; o 503 tratado como recusa; `amr` `password` aceito; destino lido do pedido (`redirect_to` aberto); `sid` não conferido; cookie do fluxo não apagado; nova tentativa na troca.

## 5. Partição em commits
1. `feat(web-portal)`: núcleo do servidor (`config`, `seal`, `pkce`, `cookies`, `gotrue`, `verifier`, `session`, `headers`) com a unidade e o Vitest do portal.
2. `feat(web-portal)`: rotas, proxy, páginas, `next.config` e a integração (inclusive o `next start`), com a regra nova de depcruise.
3. `test(web-portal)`: E2E no Edge e a mutação.
4. `docs(next-step)`: no fim da sessão.

## 6. Emendas da implementação (sessão 25, 2026-11-13)

- **Commits 1 e 2 entregues:** `787b8a5` (núcleo) e `82b6a51` (rotas, proxy, páginas, `next.config` e integração). O commit 3 (E2E e o resto da mutação) fica para a sessão seguinte.
- **Tetos do D3 pela conta do pior caso:** access de **2.300** caracteres e texto claro de **2.950** bytes. Com o refresh no teto (512), o selo nunca falha, e o par nome=valor do cookie fica abaixo de 4.096 com o `kid` de 16 caracteres (dois testes no `seal.test.ts`).
- **D8 provado contra o `next start`:** os cabeçalhos do `next.config` e a CSP do proxy saem uma vez cada em página, rota de auth, 403, 405, 404, estático (`/_next/static`) e favicon. O `/_not-found` saía estático no build (sem nonce nos scripts): o `not-found.tsx` agora chama `connection()` e é dinâmico, e o teste confere o nonce de todo `<script>` da página e do 404.
- **Fato do Next 16.4.2 (código, não documentação):** `server/lib/router-utils/resolve-routes.js` (L446 a L465) copia **todo cabeçalho que o proxy põe na resposta** para `req.headers`. A CSP da resposta já leva o nonce ao render, e o CSP no pedido (o caminho da documentação) é redundante nesta versão: o mutante E-03 (tirar o CSP do pedido) é equivalente. O pedido continua levando o CSP, porque é o caminho documentado e não depende do detalhe interno. Efeito colateral conferido: o `x-trampo-sessao` só vai no pedido, nunca na resposta, então não volta ao navegador.
- **O teste do portal depende do build** (`apps/web-portal/turbo.json`): a integração sobe o `next start` do `.next` construído, sem nenhuma variável no build.
- **gitleaks:** regra `trampo-portal-seal-keys` (a mesma forma da `trampo-auth-seal-keys`, num id próprio), com casos no `@trampo/ci-policy`.
- **Mutação da borda:** o E-05 na 1ª forma (`Origin` ausente trocado pela origem do `request.url`) sobreviveu porque, no harness, essa origem não casa com o `PORTAL_ORIGIN` (o 403 continua). Foi trocado pelo defeito real (a rota ignora o `Origin` do pedido), que morre.

## 7. Emenda do E2E (sessão 29, 2026-11-13): desenho do §4.3, antes do código

**Sondagem (fato, não suposição):** o Edge 157.0.4341.46 e o Chrome 157.0.8103.78 **aceitam** o cookie `__Host-` com `Secure` vindo de `http://127.0.0.1` e de `http://localhost` e o devolvem no pedido seguinte, porque o loopback conta como origem confiável. O script ficou fora do repositório, no scratchpad da sessão 29. **O D3 não muda.** O E2E e o roteiro manual do *HITL-QUEUE §HITL-041* rodam em http no loopback, sem TLS local. O residual "Sondagem do `Secure` em loopback" da §3 está fechado (§9 do [threat-model](../threat-model.md)). Navegador novo (ou versão nova que mude o tratamento do loopback) repete a sondagem: o E2E cai na prova (a) se o cookie não voltar.

**Arnês** (`apps/web-portal/test/e2e`, molde do harness da extensão, **sem importar nada dela**):
- `vitest.e2e.config.mts` próprio e o script `test:e2e`. O E2E fica fora do `turbo test` e do CI, como o da extensão, porque exige o navegador instalado. O `test/e2e` sai do `include` do Vitest padrão.
- O `global-setup.ts` só confere as pré-condições: o `.next/BUILD_ID` (o build é do `pnpm build` ou do turbo, e quem muta reconstrói, cuidado 33) e o executável do navegador (`TRAMPO_E2E_BROWSER` ou o Edge do sistema).
- **A pilha sobe no `beforeAll` do arquivo** (`test/e2e/support/stack.ts`): o GoTrue simulado do portal (`test/support/fake-gotrue.ts`), o `next start` e o navegador. Diferente da extensão, o portal lê toda a configuração em tempo de execução: nenhuma porta entra no build, e o teste controla o simulado direto, no mesmo processo, sem canal de controle.
- `next start -H 127.0.0.1 -p <porta livre>` com o ambiente **fechado**: `PATH`, `SYSTEMROOT`, `NODE_ENV=production`, `NEXT_TELEMETRY_DISABLED` e as 5 variáveis do D9. O `SUPABASE_URL` é a origem do simulado, e o anel de selo é efêmero, gerado no teste. O apoio recusa subir com origem que não seja `http://127.0.0.1` (nunca o projeto real). A allow-list do simulado é **exatamente** `${portal}/auth/retorno`.
- **Navegador:** o `chromium.launch` do `playwright-core` do catálogo, com o `executablePath` do Edge do sistema, *headless*, sem download. O contexto é novo a cada teste, e o perfil temporário do Playwright é apagado no `close`. O transporte é `--remote-debugging-pipe` (`coreBundle.js` L44741 do 1.64.1): **nenhuma porta de depuração abre**. Sem `--ignore-certificate-errors`, porque não há TLS.
- Um servidor http de **outra origem** (127.0.0.1, outra porta) serve só a página com o `iframe` e a página de controle, sem cabeçalhos.
- **Coletores:** o console e o `pageerror` de toda página, as URLs de todo pedido e de toda navegação do contexto, o HTML e o corpo de todo script do portal, e a saída (stdout e stderr) do processo do `next start`. Os segredos de cada teste vêm do simulado: o access e o refresh emitidos, o `code`, o `code_verifier` (do corpo da troca), o valor do cookie selado e os canários fixos.

**Provas** (cada "0" com controle positivo, cuidado 24):
- (a) **Login pelos botões** ("Entrar com GitHub" e "Entrar com Google") até a `/conta` com "Você está conectado.".
- (b) **Nada legível pelo JS:**
  - o `document.cookie` da `/conta` não tem `trampo` nem nenhum segredo. **Controle:** um cookie sem `HttpOnly` gravado pelo teste aparece nele, e o `context.cookies()` mostra o `__Host-trampo-sessao` com `httpOnly` e `secure`;
  - o HTML e o corpo de todo script não têm o access, o refresh, o `sub`, o e-mail canário, o `code`, o verifier nem o valor do cookie. **Controle:** o mesmo detector acha um segredo plantado no texto.
- (b') **O verifier nunca chega ao navegador:** nenhuma URL pedida ou navegada o contém. **Controle:** o coletor vê o `code_challenge` no `authorize` e o `code` no retorno.
- (c) **Clickjacking:** o portal num `iframe` de outra origem não carrega. O frame fica em `chrome-error://chromewebdata/`, sem o conteúdo do portal, e o console registra a violação do `frame-ancestors`. **Controle:** a página aberta do mesmo servidor carrega no `iframe`.
- (d) **Recusa do hook:** com o access a 30 s do fim e o simulado recusando como o hook, a navegação para a `/conta` termina em `/?aviso=sessao_expirada`, com "Sua sessão expirou. Entre de novo." e o botão de entrar, e o cookie some do contexto.
- (e) **503:** o mesmo access, com o simulado em 503. A `/` mostra o aviso de indisponível, e o cookie do contexto continua o mesmo. **Controle:** de volta ao normal, a `/conta` abre com a sessão.
- (f) **Logout pelo botão "Sair":** termina em `/?aviso=saiu`, com "Você saiu.". O cookie some, e a sessão do simulado é encerrada.
- (g) **CSP aplicada pelo navegador:** nenhuma mensagem de CSP (`Content Security Policy`, `Refused to`) e nenhum `pageerror` nas páginas do portal, e os scripts do Next rodaram (`self.__next_f` é uma lista), ou seja, o nonce valeu. **Controle:** o mesmo coletor registra a violação do `frame-ancestors` da prova (c).
- (h) **SR-12:** a saída do processo não tem nenhum segredo coletado. **Controle:** o conjunto não está vazio, e o detector acha um segredo plantado.
- **Três rodadas** em série, cada uma com a pilha nova.

**Mutação, grupo Q-** (`mut_portal01.py`, pelo E2E, com rebuild a cada mutante, em primeiro plano, em lotes de 3 ou 4): Q-01 cookie sem `HttpOnly`; Q-02 `frame-ancestors` e `X-Frame-Options` retirados juntos; Q-03 nonce fora da CSP; Q-04 recusa do hook tratada como 503; Q-05 503 tratado como recusa; Q-06 logout por `GET`; Q-07 o verifier na URL do botão de entrar (fragmento herdado pelos redirecionamentos). Depois da rodada, o portal é reconstruído.

**`[APPSEC]` (sem veto):**
- nenhuma porta de depuração (pipe);
- contexto descartável, com o perfil apagado no fim;
- o `next start` só recebe origens de loopback, e o apoio recusa outra;
- nenhum `.env` é lido (ambiente fechado no `spawn`);
- o anel de selo e a chave do JWKS são efêmeros, gerados em memória;
- o E2E não toca no Supabase real.

**Resultado (sessão 29, 2026-11-13):**
- **Commits:** `7798a19` (correção), `f24325c` (E2E) e `830c259` (a conta do Size). O commit 3 do §5 está entregue.
- **Achado do E2E: o botão "Sair" nunca funcionou num navegador de verdade.** Com `Referrer-Policy: no-referrer` (o D8 original), a especificação Fetch manda `Origin: null` no POST do formulário, e o logout responde 403, corretamente pela condição 5. A integração mandava o `Origin` à mão.
- **Emenda do D8:** `Referrer-Policy: same-origin`, no cabeçalho e na `<meta>` do layout, que precisam mudar juntos: a `<meta>` vale por cima do cabeçalho no documento.
  - Nenhum Referer sai para outra origem, como antes.
  - O `/auth/retorno` responde sempre 303, então a URL com o código nunca é o Referer de nada.
  - O POST do próprio portal volta a levar o `Origin` exato.
  - Aceitar `Origin: null` foi recusado pelo `[APPSEC]` (condição 5).
  - Para o futuro: a página estática do retorno da extensão (ADR-004 D15, `/extensao/retorno/<id>`) precisa de `no-referrer` próprio, por um `headers()` mais específico, que vence pelo N9.
- **Provas:** 8 casos, as (a) a (h) mais a (b') e a (f') (`GET /auth/sair` dá 405 e mantém a sessão). **3 rodadas de 8/8 no Edge 157**, e de novo 3 de 8/8 sobre o build do portão. Uma rodada de 8/8 no Chrome 157.
- **Mutação Q-:** Q-01 a Q-08, 8/8, cada um morto pela prova esperada (saída de cada mutante no `mutlogs/` do scratchpad da sessão 29). O Q-08 é a `<meta>` de volta a `no-referrer`, morto pela (f). O H-04 é o cabeçalho de volta, morto pela unidade e pela integração. O núcleo foi rodado de novo, com 62/62, e a borda deu 6/7 (o E-03 segue equivalente).
- **O tamanho do access no HITL-041:** o humano não vê o access (ele fica selado no cookie). O runbook *auth-portal* tira o número da coluna Size do DevTools, pela conta `⌊3·(Size − 64 − kid)/4⌋ − refresh − 113` (o envelope do D4 e o JSON do D3). O E2E prova essa conta contra os tokens de verdade.
- **[APPSEC]:** condições 1, 6, 8 e 9 provadas no navegador; a 11 (mutação) cumprida; a 12 vira o *HITL-QUEUE §HITL-041*. **A F1-PORTAL-01 fica fechada no código**; a parte do projeto real (o login com os IdPs reais e o tamanho do access) fecha com o HITL-041.

## 8. Emenda do HITL-041 (sessão 30, 2026-11-14): o 1º login real

**Resposta do humano** (declarada no prompt da sessão 30, a equipe não toca no projeto real), igual para o GitHub e o Google:
- login ok, e o "Sair" deu o resultado esperado, com o cookie sumindo;
- `Set-Cookie` da sessão: `Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax` (o `Max-Age` exato do login novo, `sst` igual ao agora);
- cookie do fluxo apagado; `document.cookie.includes("trampo")` `false` e `document.cookie.length` `0`; nenhum erro de CSP no console;
- **a entrada de loopback saiu da allow-list e foi conferida.** A condição 12 da §3 está cumprida, e a linha da §9 do [threat-model](../threat-model.md) fecha.

**O que faltou:** o Size ("não anotei, mas foi conforme esperado"). A conta do §3.2 do *auth-portal* não tem entrada.
- **O que se sabe sem o número:** o selo recusa access acima de 2.300 caracteres (D3) com `servico_indisponivel`. O login que fechou com os dois provedores prova access ≤ 2.300 em cada um. O cookie também coube nos 4.096 bytes do navegador.
- **O que não se sabe:** se algum provedor passa de 2.000, o gatilho que levaria a dividir a sessão em dois cookies selados.
- **Decisão do `[ARCHITECT]` (com o `[APPSEC]`, sem veto):** **não dividir agora**, e seguir com a F1-PORTAL-02.
  - O modo de falha de um access grande é **negar o login com aviso**, nunca cortar o cookie nem abrir a sessão pela metade. O risco é de disponibilidade.
  - A F1-PORTAL-02 **não muda o JSON da sessão** do D3: os critérios e a pretensão nunca vão para cookie, e são lidos da API a cada página ([ADR-028-portal-criteria](ADR-028-portal-criteria.md)). A margem não é consumida.
  - O número entra no **próximo login real** (o roteiro do 1º salvamento real de critérios, que já precisa de um login, ou a hospedagem do S-5), pelo mesmo §3.2. Se der acima de 2.000, a decisão volta ao `[ARCHITECT]` antes de qualquer outra trilha do portal.
- **Efeito:** a *BACKLOG §F1-PORTAL-01* fecha por inteiro (código, E2E e o login real). O residual do número vira linha da §9 do [threat-model](../threat-model.md).

**Emenda do HITL-043 (sessão 32, 2026-11-15): o número do access.** O 1º salvamento real de critérios (*auth-portal* §8) anotou o **Size 1312** do `__Host-trampo-sessao` (declarado pelo humano; login pelo GitHub).
- **Conta:** access = ⌊3·(Size − 66)/4⌋ − 125 = ⌊3·1246/4⌋ − 125 = 934 − 125 = **809 caracteres**. É a conta do §7 (`⌊3·(Size − 64 − kid)/4⌋ − refresh − 113`) com o `kid` `p1` (2 caracteres) e o refresh de 12 caracteres do GoTrue. Com um refresh mais longo, o access seria menor: **809 é um teto**.
- **Leitura:** 809 fica a 1.191 do gatilho de 2.000 e a 1.491 do teto de 2.300 do D3. **A sessão segue num cookie só**, e a decisão de dividir em dois cookies selados **não volta** ao `[ARCHITECT]`. O número só foi medido com o GitHub; o HITL-041 já provou que o Google também fica abaixo de 2.300.
- **Quando medir de novo:** se o hook passar a acrescentar claims ao access, se o projeto ligar MFA (o `amr` cresce) ou na hospedagem do S-5. A linha da §9 do [threat-model](../threat-model.md) fecha.

## 9. Emenda da F1-PORTAL-04 (sessão 31, 2026-11-15): "Sair de todos os dispositivos", só o desenho

Emenda ao D7. **Nenhum código nesta sessão.** `[ARCHITECT]` + `[APPSEC]`, sem veto, 9 condições. O "Sair" comum (D7) não muda: continua `local`.

### 9.1 Fatos e o que falta conferir

| # | Fato | Fonte |
|---|---|---|
| S3 | O logout tem escopo `global` (todas as sessões do usuário), `local` e `others`; o access de sessão revogada vale até o `exp` | §1.1 (já conferido na sessão 25) |
| A7 | A API não confere revogação de sessão: o JWT vale até o `exp` (900 s) | [ADR-028-portal-criteria](ADR-028-portal-criteria.md) §1.1 |
| E1 | Na extensão, a renovação recusada pelo GoTrue leva ao estado deslogado, sem nova tentativa em laço | [ADR-004-extension-auth](ADR-004-extension-auth.md) D11.5 |
| F1 (**medido na sessão 32**, antes do código) | O `POST /auth/v1/logout?scope=global` com o Bearer de uma sessão já encerrada dá **403 `session_not_found` e não revoga nada**: a outra sessão do mesmo usuário renova com 200 logo depois. Com o Bearer vivo, o `global` dá 204, e a renovação de **toda** sessão do usuário passa a dar 400 `refresh_token_not_found`; o `local` só derruba a do Bearer; o `global` de um usuário não toca nas sessões de outro | pilha local (Docker, CLI 2.120.0, GoTrue v2.197.0), duas sessões do mesmo usuário por cadastro e login com senha; a hipótese valeu, e o desenho não mudou (§10) |

### 9.2 Decisões

- **Dois passos, sem JS:** a `/conta` ganha o link "Sair de todos os dispositivos" para a página **`/conta/sair-de-tudo`** (Server Component, a DAL em `leitura`, `no-store`). A página explica o efeito e tem **o próprio formulário**, que posta em **`POST /auth/sair-de-tudo`** (Route Handler; o `GET` é 405), e o link "Voltar". O `GET` da página nunca encerra nada.
  - A rota fica em `/auth/*` para o proxy não renovar nela (D6), como o `/auth/sair`.
  - Sem campo escondido de confirmação: a prova de intenção é o `Origin` exato com o `Sec-Fetch-Site` (D7), o cookie `SameSite=Lax` (um `POST` de outro site não o leva) e o `frame-ancestors 'none'` (a página de confirmação não entra em `iframe`).
- **O escopo nunca vem do pedido.** O cliente do GoTrue passa a ter dois endereços fixos, montados no boot (`?scope=local` e `?scope=global`), e a interface vira `logout(accessToken, scope)` com a união fechada `"local" | "global"`. A DAL ganha `logoutEverywhere`, **o único chamador** do `global`. O `logout` do D7 e o logout da sessão órfã (D2) continuam `local`.
- **Ordem (igual ao D7, com uma diferença):**
  1. `Origin` exatamente igual a `PORTAL_ORIGIN` **e** `Sec-Fetch-Site` `same-origin`; senão 403 com o corpo fixo, sem tocar em cookie nem rede;
  2. o cookie da sessão é apagado **sempre**, primeiro (a saída local é incondicional);
  3. sem sessão que abra: `/?aviso=saiu_sem_confirmar` (não há Bearer para pedir o `global`);
  4. access com até 60 s pela frente: renova antes; a renovação que falha segue com o access que há;
  5. `POST ${SUPABASE_URL}/auth/v1/logout?scope=global` com o Bearer, **uma** tentativa;
  6. **só o 2xx é "saiu de tudo"** (`/?aviso=saiu_de_tudo`). **A diferença para o D7:** o 403 `session_not_found` **não** conta como sucesso aqui. No `local`, sessão que não existe é sessão encerrada; no `global`, ela não prova nada sobre as outras sessões (F1). Qualquer outro resultado: `/?aviso=saiu_sem_confirmar`.
- **Avisos novos no catálogo fechado:**
  - `saiu_de_tudo`: "Você saiu de todos os dispositivos. A extensão e os outros navegadores param de funcionar em até 15 minutos.";
  - `saiu_sem_confirmar`: "Você saiu deste navegador, mas não conseguimos confirmar a saída dos outros dispositivos. Entre de novo e repita. Sem isso, as outras sessões expiram sozinhas em até 24 horas."
- **O texto da página de confirmação** (fixo, do catálogo) diz o efeito real, sem prometer corte imediato: a extensão e os outros navegadores saem **na próxima renovação**, em até 15 minutos (o access já emitido vale até o `exp`, S3 e A7), e será preciso entrar de novo em cada um.
- **A extensão não muda** (E1): a sessão dela cai na renovação seguinte, pelo caminho que já existe. Nenhum contrato novo.
- **Todo destino é constante** (a página inicial com um aviso do catálogo). Toda resposta da rota é 303 com `no-store`.

### 9.3 Auditoria do `[APPSEC]` (sem veto, 9 condições)

**Ameaças revistas:**
- **T41 (CSRF de login):** se a vítima estiver na conta do atacante e clicar em "sair de tudo", quem perde as sessões é o atacante. Sem ganho para ele.
- **T44 e T49 (envelope ou cookie roubado):** o botão vira o **remédio do usuário**: revoga o refresh de toda sessão, e o que sobra ao ladrão é o access já emitido, por até 900 s. O residual da §9 do [threat-model](../threat-model.md) ganha essa frase quando o código entrar.
- **T48 (sessão do fluxo do atacante):** o `global` também a derruba.
- **T33 (CSRF):** um `POST` forjado derrubaria todas as sessões do usuário (negação de serviço barata). Por isso o `Origin` exato com o `Sec-Fetch-Site`, o `SameSite=Lax` e nenhum `GET` que execute.
- **T30 (falha que não pode virar promessa):** "saiu de tudo" só com o 2xx. Dizer isso sem a confirmação do servidor seria pior que não ter o botão.

**Condições (cada uma com teste):**
1. **O escopo só muda nesse botão:** o `POST /auth/sair` e o logout da sessão órfã chamam `scope=local`; só o `POST /auth/sair-de-tudo` chama `scope=global`. O GoTrue simulado registra o escopo de cada logout.
2. **Nada do pedido escolhe o escopo:** query, corpo e cabeçalhos hostis (`?scope=global` no `/auth/sair`, `?scope=local` no `/auth/sair-de-tudo`) não mudam o endereço chamado.
3. **CSRF:** sem `Origin`, com outra origem, com `null` ou com `Sec-Fetch-Site` diferente de `same-origin`: 403, cookie intacto e nenhuma chamada ao GoTrue. `GET /auth/sair-de-tudo` dá 405 e não encerra nada.
4. **O `GET` da página de confirmação não encerra nada:** abrir `/conta/sair-de-tudo` não chama o logout; sem sessão, ela vai para a página inicial.
5. **Só o 2xx confirma:** o 403 `session_not_found`, o 401, o 429, o 5xx, o prazo, a conexão recusada e o redirecionamento dão `saiu_sem_confirmar`. Em todos, o cookie do navegador some.
6. **Efeito de verdade:** com duas sessões do mesmo usuário no GoTrue simulado (a 2ª faz o papel da extensão), o "sair de tudo" da 1ª faz a renovação da 2ª ser recusada, e a 2ª cai em "Sua sessão expirou". Com o "Sair" comum, a 2ª continua viva.
7. **Uma tentativa, sem laço:** exatamente um `POST` de logout por clique, em todo modo de falha.
8. **Sem JS e sem `"use client"`;** os cabeçalhos do D8 uma vez cada na página e na rota; `no-store`; a tabela de open redirect.
9. **Mutação dirigida** (`mut_portal04.py`) antes do push: o escopo trocado nos dois sentidos, o 403 `session_not_found` contado como sucesso no `global`, o `Origin` não conferido, o cookie mantido na falha, a página de confirmação postando em `/auth/sair` e o link da `/conta` apontando direto para a rota.

**Residuais:** o access já emitido vale até 900 s depois do "sair de tudo" (S3, A7; o mesmo residual do D7). O 1º uso contra o projeto real é HITL, no mesmo roteiro do 1º salvamento real de critérios.

### 9.4 Plano de testes e partição

- **Unidade:** `gotrue.logout` com os dois escopos (endereço exato), `session.logoutEverywhere` (a tabela do 9.2), os avisos novos e o texto da página.
- **GoTrue simulado:** passa a guardar as sessões por usuário e o escopo de cada logout; o `global` revoga todas, e o `local` só a do Bearer.
- **Integração e E2E:** as condições 1 a 8; no E2E, duas abas em contextos separados, pelo botão real (cuidado 36), 3 rodadas.
- **Commits:** (1) núcleo (`gotrue`, `session`, `notices`) com a unidade e o GoTrue simulado; (2) a página, a rota, o link, a integração e o E2E; (3) `docs`.

## 10. Emenda da implementação da F1-PORTAL-04 (sessão 32, 2026-11-15)

O desenho da §9 entrou no código sem mudança de decisão. Commits: `fa45a63` (o núcleo) e `2844291` (a página, a rota e o E2E).

- **Cliente do GoTrue (`gotrue.ts`):** `logout(accessToken, scope)` com a união fechada `GotrueLogoutScope = "local" | "global"` e dois endereços fixos, montados no boot num objeto congelado. O escopo é obrigatório (nenhum padrão escolhe por quem chama). Um escopo fora da união (só por coerção de tipo) devolve `nao_recebido` sem rede: nenhum texto vira endereço. No `global`, o 403 `session_not_found` é `recusado`; no `local`, continua sessão encerrada.
- **DAL (`session.ts`):** `logoutEverywhere` é o único chamador do `global`. O "Sair" comum e ele dividem o `logoutBearer` (renova antes com até 60 s pela frente; a renovação que falha segue com o access que há). **Uma decisão que o desenho não tinha:** o cookie com a idade ou a inatividade **local** vencidas (D4) ainda tenta o `global`. O refresh pode estar vivo no servidor, e quem clicou quer derrubar as outras sessões; o cookie é apagado de qualquer jeito.
- **Avisos e textos (`notices.ts`):** `saiu_de_tudo` e `saiu_sem_confirmar` no catálogo fechado, e o `LOGOUT_EVERYWHERE_TEXTS` (título, efeito, prazo, botão e "Voltar") da página de confirmação. Um teste recusa "imediato" e afins: o texto nunca promete corte na hora.
- **Página e rota:** `src/app/conta/sair-de-tudo/page.tsx` (Server Component; `readSession`, sem sessão vai para a página inicial; um formulário só, sem campo nenhum) e `src/app/auth/sair-de-tudo/route.ts` (`POST`; o `GET` é 405). A `/conta` ganhou **um link** para a página; o único formulário dela continua o "Sair" comum.
- **GoTrue simulado:** sessões por usuário (`addSession({ userId })`), o `global` revogando todas as do usuário e o `local` só a do Bearer, o 403 `session_not_found` sem revogar (como o F1 medido) e o registro `logouts` (escopo, sessão do Bearer e o que cada logout revogou).

**Provas (`[QA_EVALS]`):**
- Unidade: 446 casos, 100% nas 4 métricas em `src/server`. Integração contra o `next start`: 22 casos novos, com as condições 1 a 8 numeradas no nome do teste (493 casos no pacote).
- **E2E no Edge com dois contextos** (`logout-everywhere.e2e.test.ts`, 6 casos; o 2º contexto faz o papel da extensão, com o access de 30 s para renovar a cada navegação): pelo link e pelo botão reais, o 1º sai com "Você saiu de todos os dispositivos…" e o 2º cai em "Sua sessão expirou. Entre de novo." na navegação seguinte; com o "Sair" comum, o 2º continua; com o GoTrue em 503, o aviso é o `saiu_sem_confirmar` e o 2º continua; o `GET` na rota dá 405. **3 rodadas de 20/20** (8 do login, 6 dos critérios e 6 novos).
- **Mutação** (`mut_portal04.py` e `mut_portal04_edge.py`, scratchpad da sessão 32):
  - U- 30/31 pela unidade. O U-08 (escopo fora da união caindo no `global` por `??`) é **equivalente**: a guarda `Object.hasOwn` devolve antes, e o U-07 (sem a guarda) morre;
  - P- 5/5: os mutantes do logout comum das sessões 29 e 30 com as âncoras novas (S-10, L-01, L-02 e G-03 nos dois escopos);
  - I- 13/13 pela integração com rebuild: a página postando em `/auth/sair`, o link da `/conta` direto para a rota, a `/conta` postando direto na rota, o escopo trocado nos dois sentidos, o `GET` executando, o `Origin` e o `Sec-Fetch-Site` tirados do pedido, a página sem conferir a sessão, o formulário por `GET`, o escopo lido da query, o `GET` da página já encerrando tudo e o cookie errado;
  - Q- 7/7 pelo E2E com rebuild, inclusive a `<meta>` em `no-referrer` (o `Origin: null` do cuidado 36).
  - O `mut_portal01_s30.py` (25) e o `mut_portal02.py` (48) rodados de novo, sem sobrevivente.

**`[APPSEC]`:** as condições 1 a 9 da §9.3 estão cumpridas. O 1º uso contra o projeto real é o *HITL-QUEUE §HITL-044* (runbook *auth-portal* §9). **A F1-PORTAL-04 fica fechada no código.**

## 11. Emenda da F1-PORTAL-03 (sessão 32, 2026-11-15): o início da sessão e o aviso novo ([ADR-029-account-export-and-delete](ADR-029-account-export-and-delete.md))

- **D3:** o `sst` do cookie (o instante do login no portal) passou a sair pelo `apiAccess` como `startedAt`. A exclusão da conta o usa para espelhar a regra do login recente do banco (600 s). **A renovação nunca o muda** (o D6 já selava o mesmo `sst`), e um teste prende isso: sessão renovada não fica recente.
- **D7:** o catálogo da página inicial ganhou `conta_excluida`. Os avisos das páginas de dados ficam num catálogo próprio (`ACCOUNT_NOTICES`), como os dos critérios.
- **D12:** exportar e excluir a conta saíram da lista do que o portal não faz. Continua de fora o handoff para a extensão.
- **Borda (`edge.ts`):** o `toResponse` ganhou a terceira intenção, o anexo da exportação (200 em JSON, `Content-Disposition: attachment` com nome fixo, `no-store`).

## 12. Emenda do HITL-044 (sessão 33, 2026-11-16): o 1º "sair de tudo" real

**Resultado (declarado pelo humano, *HITL-QUEUE §HITL-044*):** dois perfis do Edge com a mesma conta no projeto real; o "Sair de todos os dispositivos" pelo perfil A apagou o cookie dele, e **o perfil B caiu em "Sua sessão expirou" em 15 minutos**. Com o "Sair" comum no perfil A, o B continuou conectado depois de 16 minutos. A loopback foi removida e conferida.

- **O tempo bate com o desenho:** o access do projeto real vale 900 s, e o B só perde a sessão na 1ª renovação depois disso. 15 minutos está dentro do limite de 16 do runbook, então **o tempo de vida do access não volta ao `[ARCHITECT]`**. O residual da §9.3 (o access já emitido vale até 900 s) fica confirmado no projeto real.
- **O escopo `local` também se confirmou no real:** o "Sair" comum não derrubou o B.
- **O aviso anotado não é literal:** o humano escreveu `saiu_todos`, e o catálogo só tem `saiu_de_tudo` e `saiu_sem_confirmar`. A queda do B só se explica pela revogação `global`, então a equipe lê `saiu_de_tudo`. O spike S-3 pede o `?aviso=` copiado da barra de endereço.
- **Latência (relato sem número):** a troca e a renovação junto ao GoTrue e a recarga depois da revogação pareceram lentas ao humano, dentro do aceite. Hipótese da equipe, a medir: no roteiro, o portal e a API rodam em `127.0.0.1` no Brasil e o projeto fica em `us-east-1`, então cada página da `/conta` paga ao menos uma viagem de ida e volta ao GoTrue (a verificação do access pelo JWKS em cache não paga), e a renovação no proxy paga mais uma. A medida vai para o spike S-3 (o tempo de cada pedido pela aba Rede, só números) e a decisão da região para o S-5 ([ADR-030-hosting](ADR-030-hosting.md)).
- ***BACKLOG §F1-PORTAL-04* fechada também no projeto real.**
