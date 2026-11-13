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
- `PORTAL_SEAL_KEYS` e `PORTAL_SEAL_ACTIVE_KEY` (D4).
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
