---
tipo: adr
id: ADR-028
titulo: "Critérios no portal (F1-PORTAL-02): o servidor do portal lê e grava pela API (GET e PUT /v1/criteria) com o Bearer da sessão, sem Origin; página Server Component sem JS próprio; gravação por Route Handler POST com Origin exato; rascunho selado de uso único; nenhum texto do Zod na tela"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC], sem veto, 14 condições). Não muda contrato público nem a API. A gravação contra o projeto real é HITL (o roteiro do 1º salvamento real)."
data: 2026-11-14
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "apps/web-portal (src/server, src/app/conta, src/proxy.ts, test/), packages/config/dependency-cruiser.cjs"
substitui: null
relacionados: ["[ADR-027-portal-login](ADR-027-portal-login.md)", "[ADR-021-criteria-routes](ADR-021-criteria-routes.md)", "[ADR-018-postgres-schema-rls-and-criteria](ADR-018-postgres-schema-rls-and-criteria.md)", "[ADR-007-api-edge](ADR-007-api-edge.md)", "[ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md)", "[ADR-013-jwt-verification](ADR-013-jwt-verification.md)", "[ADR-026-custom-access-token-hook](ADR-026-custom-access-token-hook.md)", "[threat-model](../threat-model.md)", "[contratos-zod](../contratos-zod.md)", "*BACKLOG §F1-PORTAL-02*"]
---

# ADR-028: Critérios no portal

## 1. Contexto

O [ADR-021-criteria-routes](ADR-021-criteria-routes.md) entregou o `GET` e o `PUT /v1/criteria` na API e deixou o caminho do portal para depois (L18: "Falta o caminho do portal para gravar e ler"). O [ADR-027-portal-login](ADR-027-portal-login.md) deu ao portal o login no servidor, com a sessão num cookie `__Host-` selado, e deixou os critérios fora (D12). Esta trilha liga as duas pontas: o usuário logado no portal lê e grava o `UserCriteria` num formulário estruturado, sem JavaScript de cliente.

### 1.1 Fatos conferidos antes do desenho

Fonte do Next.js: a documentação **da versão instalada** (`node_modules/next/dist/docs`, 16.4.2) e, onde ela cala, o código do próprio pacote (marcado [SRC]). Fonte da API: o código do `spike/s1-extraction` em `b033a79`. Nada de memória.

| # | Fato | Fonte |
|---|---|---|
| N11 | Server Action só por `POST`; compara o `Origin` com o `Host` (ou `X-Forwarded-Host`). **Pedido sem `Origin` passa, com um aviso no log** | `02-guides/data-security.md` ("Allowed origins"); `05-config/01-next-config-js/serverActions.md` (`allowedOrigins`); [SRC] `server/app-render/action-handler.js` L423 a L481 |
| N12 | A Server Action sem JS só roda em `multipart/form-data` com o campo `$ACTION_ID_<id>`; um `POST` urlencoded para uma página **não roda ação nenhuma** e só renderiza a página | [SRC] `server/lib/server-action-request-meta.js` e `action-handler.js` L403 ("We don't currently support URL encoded actions") |
| N13 | O erro de validação de uma Server Action volta à tela pelo `useActionState`, que exige um Client Component | `02-guides/forms.md` ("Validation errors") |
| N14 | Não pode haver `route.js` no mesmo segmento de um `page.js` | `01-getting-started/15-route-handlers.md` L39 e L155 |
| N15 | Route Handler é endpoint público; o Next não tem limite de corpo nem conferência de `Origin` para ele ("Validate content type and size") | `02-guides/backend-for-frontend.md` ("Public Endpoints", "Verify payloads") |
| N16 | `NextResponse.redirect` usa 307 por padrão; o 303 precisa ser explícito para o `POST` virar `GET` | [SRC] `server/web/spec-extension/response.js` L95 |
| N17 | `fetch` não tem cache por padrão; a rota dinâmica (que lê `headers()`) busca a cada pedido; `cache: "no-store"` deixa isso explícito | `01-getting-started/06-fetching-data.md`; `04-functions/fetch.md` (`options.cache`) |
| N18 | `react-dom/server` não roda na camada do servidor de componentes (o Next traz `server.react-server.js`, que lança): um Route Handler não renderiza React | [SRC] `compiled/react-dom/server.react-server.js` |
| A1 | `GET /v1/criteria`: classe `padrao` (60 por usuário e 120 por IP por minuto); 200 com o `UserCriteria` **com a pretensão decifrada**, validado na saída; 409 `CRITERIOS_NAO_CONFIGURADOS` sem linha | `apps/api/src/presentation/routes/criteria.ts` L70 a L75 e L100 a L114; `limit-policy.ts` L7 a L16 |
| A2 | `PUT /v1/criteria`: classe `criterios` (10 por usuário e 30 por IP por minuto), `bodyLimit` de 16.384, `UserCriteriaSchema` estrito, 204 sem corpo, substituição inteira e idempotente | `criteria.ts` L84 e L100 a L114; [ADR-021-criteria-routes](ADR-021-criteria-routes.md) D7 |
| A3 | Ordem da borda: CORS, tipo de mídia, JWT, limite de taxa e só então o corpo. **O 401 sai antes de qualquer gravação** | `apps/api/src/presentation/build-app.ts` L138 a L140; [ADR-021-criteria-routes](ADR-021-criteria-routes.md) D8.1 |
| A4 | **Pedido sem `Origin` passa pela borda sem CORS** ("não é navegador… o JWT protege"); `/v1/criteria` não está em nenhuma lista de rota só da extensão ou de `Origin` obrigatório | `apps/api/src/presentation/edge/cors.ts` L29 a L44 e L102 a L106; [ADR-007-api-edge](ADR-007-api-edge.md) D6 |
| A5 | Erros: 401 `NAO_AUTENTICADO` (com `WWW-Authenticate`), 400 e 415 `PAYLOAD_INVALIDO`, 413 `PAYLOAD_GRANDE_DEMAIS`, 429 `LIMITE_DE_TAXA` com `Retry-After`, 503 `SERVICO_INDISPONIVEL`, 500 `ERRO_INTERNO`. O corpo é o `ApiErrorSchema` (4 chaves, texto fixo, nunca o Zod). A mensagem do 429 fala de "análises": **o portal decide pelo `code`** | `api-error.ts` L7 a L18 e L55; `criteria.ts` L91 a L95; [ADR-021-criteria-routes](ADR-021-criteria-routes.md) D2 (L67) |
| A6 | Os baldes por IP usam o `request.ip`; o portal não é salto confiável (`TRUST_PROXY`), então todos os usuários do portal caem no balde do IP de saída dele | `rate-limit.ts` L28 a L31; `client-address.ts` L30 a L39; [ADR-007-api-edge](ADR-007-api-edge.md) D5 |
| A7 | O verificador da API não distingue sessão do portal e da extensão: só `userId` e `sessionId` saem dele. A API não confere revogação de sessão (JWT sem estado, [ADR-013-jwt-verification](ADR-013-jwt-verification.md)); o hook age só na emissão de token ([ADR-026-custom-access-token-hook](ADR-026-custom-access-token-hook.md)) | `jose-access-token-verifier.ts` L20 a L79 |
| A8 | No `PUT`, o `CriteriaGuard` corta em 1.000 ms e responde 503, mas a escrita no PostgREST pode terminar depois: **um 503 do `PUT` não prova que nada foi gravado** | [ADR-021-criteria-routes](ADR-021-criteria-routes.md) D5 e D7 ("o portal pode repetir ou reler") |

## 2. Decisões

### D1. Caminho dos dados: o portal chama a API, servidor a servidor (opção A)
O servidor do portal chama o `GET` e o `PUT /v1/criteria` da API com o **Bearer do access do cookie selado**. A API continua dona da pretensão cifrada (`s1`, o anel só na API), do `CriteriaGuard`, da RLS pelo PostgREST e do `bodyLimit`.
- **Opção B recusada (veto do `[APPSEC]`):** falar direto com o PostgREST pelo cliente de usuário do [ADR-018-postgres-schema-rls-and-criteria](ADR-018-postgres-schema-rls-and-criteria.md) D5 exigiria o anel da pretensão (`CRITERIA_SALARY_KEYS`) no processo do portal. Seriam duas cópias do mesmo material de chave em dois processos, contra a regra dos anéis por finalidade (ADR-004 D5) e o D4 do ADR-018 ("só no `.env` da API"). A regra de negócio do guarda (prazo, revalidação, falha fechada) também seria duplicada.
- **Sem `Origin`** (A4): o pedido do portal não é de navegador, e o CORS não se aplica; o JWT do usuário é a proteção. O `CORS_ALLOWED_ORIGINS` da API **não** ganha a origem do portal.
- **Nenhuma mudança na API** nesta trilha.

### D2. Cliente HTTP da API no portal (`src/server/api-client.ts`, molde do `gotrue.ts`, reescrito)
- **URL fixa** derivada de `API_ORIGIN` mais o caminho `/v1/criteria`. Nada do pedido vira URL, host ou caminho (sem SSRF).
- **Lista fechada de cabeçalhos:** `authorization: Bearer <access>` e `accept: application/json`; no `PUT`, também `content-type: application/json`. **Nunca** o `cookie` do navegador, `origin`, `referer`, `x-forwarded-for`, `x-real-ip`, `forwarded` ou qualquer cabeçalho do pedido do usuário. A interface do cliente não recebe cabeçalho.
- `redirect: "error"` (seguir um 3xx levaria o Bearer a outro host), prazo de 5 s, teto de resposta de 32 KiB, UTF-8 estrito, JSON sem chave de protótipo, `cache: "no-store"` (N17). **Nunca rejeita.**
- **Corpo do `PUT`:** `JSON.stringify` do `UserCriteria` já validado; acima de `CRITERIA_BODY_MAX_BYTES` (16.384) não sai (resultado `invalido`).
- **Classificação** (o corpo da API conferido pelo `ApiErrorSchema`; sem ele, o status sozinho nunca apaga sessão, T30):

| Resposta | `GET` | `PUT` |
|---|---|---|
| 200 com `UserCriteria` válido | `ok` com os critérios | (fora da forma: `pode_ter_gravado`) |
| 204 | (fora da forma: `nao_recebido`) | `ok` |
| 409 `CRITERIOS_NAO_CONFIGURADOS` | `ok` com `null` (nunca salvou) | `nao_recebido` |
| 401 `NAO_AUTENTICADO` com o corpo da API | `recusado` | `recusado` (A3: nada foi gravado) |
| 400 ou 415 `PAYLOAD_INVALIDO`, 413 `PAYLOAD_GRANDE_DEMAIS` | `nao_recebido` | `invalido` (nada foi gravado) |
| 429 `LIMITE_DE_TAXA` | `nao_recebido` | `nao_recebido` (o limite vem antes do corpo, A3) |
| conexão recusada, DNS, redirecionamento | `nao_recebido` | `nao_recebido` |
| 503, 500 e qualquer outro status; corpo que não é da API | `nao_recebido` | `pode_ter_gravado` (A8) |
| prazo, aborto, socket cortado depois do envio | `nao_recebido` | `pode_ter_gravado` |

- **Sem nova tentativa no `PUT`**, em caso nenhum. O `GET` também não repete (a página só lê).

### D3. Configuração: `API_ORIGIN`
Variável nova, lida só no `src/server/config.ts` (ADR-027 D9), obrigatória, em falha fechada e sem ecoar: **origem exata em https, ou http só em loopback** (a mesma regra do `PORTAL_ORIGIN`). Entra no `.env.example` do portal, sem valor, e no D9 do ADR-027 por emenda. O build continua sem ler variável nenhuma.

### D4. A sessão para a API: renovar antes, e o 401 da API
- A DAL ganha `apiAccess(cookie, modo)` no `src/server/session.ts`, que devolve o access (e o `userId`) ou o estado da sessão, reaproveitando a renovação do D6 do ADR-027:
  - **`leitura`** (a página, um Server Component, que não grava cookie, N8 do ADR-027): abre e verifica o access; **não renova**. O proxy já renovou o access com até 60 s pela frente no mesmo pedido (D6 do ADR-027). Renovar aqui giraria o refresh sem gravar o novo, e a sessão morreria depois dos 10 s de reuso;
  - **`gravacao`** (a rota de gravação, que grava cookie): com até 60 s pela frente, renova antes, como o logout (D7 do ADR-027). Recusa vira "entre de novo" com o cookie apagado; não recebido vira "indisponível" com o cookie mantido;
  - **`forcada`** (só depois de um 401 da API na gravação): renova mesmo com tempo de sobra.
- **O 401 da API não prova sessão morta** (A7: a API não confere revogação; o hook age só na emissão). Apagar a sessão por ele sozinho reabriria o laço de relogin do T30 num desvio de configuração (emissor, `amr`, relógio). Então:
  - **na gravação:** o 401 leva a **uma renovação forçada**. Se o GoTrue recusa (sessão revogada, o hook das 24 h, `sid` divergente), é "entre de novo" e o cookie é apagado. Se aceita, o cookie novo é gravado e a resposta é "indisponível" com o rascunho, **sem repetir o `PUT`** (o usuário salva de novo);
  - **na página:** o 401 vira "indisponível" (sem gravar cookie). A sessão morta de verdade já é pega pelo proxy, na renovação de toda navegação.
- O 503, o 429 e o resto do "não recebido" mostram "indisponível" e **nunca** apagam a sessão (T30).

### D5. Página `/conta/criterios` (Server Component, sem JS próprio)
- Pede a sessão pela DAL (`leitura`); sem sessão, `redirect` para a página inicial com o aviso do estado (o mesmo `homeFor` da `/conta`).
- Lê `GET /v1/criteria` **a cada pedido** e monta o formulário a partir do valor salvo; com 409, a partir dos **padrões explícitos** (D7). Sem os critérios (indisponível), **não mostra o formulário**: um formulário de padrões salvo por cima apagaria os critérios reais do usuário. Com um rascunho válido (D8), mostra o rascunho.
- Avisos de um catálogo fechado próprio (`?aviso=` só escolhe o texto). Erro de campo: o **nome do campo** e um **texto fixo do catálogo**, nunca o texto do Zod nem o valor recebido.
- `Cache-Control: no-store` (a página é dinâmica; o teste confere). Nonce em todo `<script>` (o Next aplica, D8 do ADR-027).
- `/conta` ganha o link "Seus critérios".

### D6. Gravação: Route Handler `POST /conta/criterios/salvar` (não Server Action)
- **Por que não Server Action:** sem `Origin` ela passa (N11), e a regra do portal é `Origin` exato (D7 do ADR-027, condição 5); sem JS, só funciona em `multipart` (N12); e o erro de validação só volta à tela por `useActionState`, que exige `"use client"` (N13), proibido nesta trilha.
- **Por que outro caminho:** `route.ts` não convive com o `page.tsx` do mesmo segmento (N14). O formulário da página posta em `/conta/criterios/salvar`; o `GET` dele é 405.
- **Ordem, em falha fechada:**
  1. `Origin` **exatamente** igual a `PORTAL_ORIGIN` **e** `Sec-Fetch-Site` `same-origin`; senão 403 com o corpo fixo, sem tocar em cookie nem rede (como o logout);
  2. `Content-Type` `application/x-www-form-urlencoded` (com `charset=utf-8` opcional), corpo lido com teto de `HTTP_BODY_MAX_BYTES` (65.536, N15) e UTF-8 estrito; fora disso, 303 para o aviso `formulario_recusado`;
  3. só os nomes de campo da lista fechada (D7), cada um uma vez, menos as listas de marcação; nome desconhecido ou repetido: `formulario_recusado`, sem rascunho;
  4. sessão pela DAL (`gravacao`): sem sessão, para a página inicial com o aviso do estado; indisponível, rascunho e aviso de indisponível;
  5. o formulário vira `UserCriteria` e passa pelo `UserCriteriaSchema` do `@trampo/contracts`. Falhou: rascunho com os campos marcados e o aviso `criterios_invalidos`, **sem chamar a API**;
  6. `PUT` pelo cliente (D2), uma vez: `ok` → 303 para `/conta/criterios?aviso=criterios_salvos`; `invalido` → rascunho e `criterios_recusados`; `nao_recebido` → rascunho e `criterios_indisponiveis`; `pode_ter_gravado` → rascunho e `criterios_nao_confirmados`; `recusado` → o D4.
- **Todo destino é constante** (`/conta/criterios`, com um aviso do catálogo, ou a página inicial): nada do pedido muda o destino (sem open redirect). Toda resposta leva `Cache-Control: no-store` e 303.

### D7. O formulário (campo a campo para o `UserCriteriaSchema`)
- **Sem novo contrato em `packages/contracts`:** o formato do formulário (nomes de campo, caixas de marcação) é detalhe de apresentação do portal. O contrato entre o portal e a API continua sendo só o `UserCriteria`, validado pelo mesmo `UserCriteriaSchema` dos dois lados. O DOC-01 não muda.
- **Opções só dos enums fechados** do contrato, lidas dos próprios schemas do `@trampo/contracts/user-criteria` (sem cópia de lista no portal).
- Importância num `<select>` só: `eliminatorio`, `obrigatorio`, `ponderado_1` a `ponderado_5` e `ignorar`.
- **Campos:**
  - `workModel.accepted`, `seniority.accepted`, `contractType.accepted` e `benefits.desired`: caixas de marcação;
  - `salary.*`, `location.*`, `languages.*` e `benefits.*`: uma caixa "usar este critério" (`*.enabled`); desmarcada, `null`;
  - `salary.minimum`: número decimal (`^\d{1,8}([.,]\d{1,2})?$`), além da moeda e do período por `<select>`;
  - `location.ufs` por caixas; `location.cities`, uma por linha;
  - `stack.mustHave`, `stack.niceToHave` e `stack.dealBreakers`: uma tecnologia por linha. São **marcas validadas pelo contrato** (`TechTag`), não texto livre. O `stack.dealBreakerScope` e o `stack.niceToHaveWeight` vão por `<select>`;
  - `languages.level.<idioma>` por `<select>`, com "não exigir";
  - `redFlagTolerance.<sinal>` por `<select>`, um por sinal (o contrato é exaustivo);
  - `notes`: o único texto livre, até 500 caracteres. **Não alimenta regra** (contrato, Blueprint §3).
- **Padrões explícitos** para quem nunca salvou: todas as opções aceitas com importância `ignorar`; as seções que aceitam `null` desligadas; as listas da stack vazias com o escopo `somente_obrigatoria` e o peso 1; todos os sinais em `alertar`; sem observações.
- **Normalização** antes do schema: `\r\n` vira `\n`; as linhas são aparadas e as vazias saem; a observação vazia vira `null`. Nada mais: o schema decide.
- **Erros:** cada `issue` do Zod vira só o seu **primeiro segmento de caminho** (o nome do campo do contrato), e o texto vem do catálogo `CRITERIA_FIELD_ERRORS`. O caminho vazio (o teto de 12.288 bytes) tem o seu texto. O texto do Zod e o valor recebido nunca saem.

### D8. Rascunho: cookie selado de uso único (`__Host-trampo-rascunho`)
- **O problema:** sem JS e sem `"use client"`, o único processo que tem o rascunho que falhou é o da gravação, e a página que o mostra é outro pedido (o 303). Um Route Handler não renderiza React (N18). Guardar no servidor quebraria a ausência de estado do portal (várias instâncias no S-5).
- **Decisão:** em falha (validação, recusa, indisponível ou não confirmado), a rota grava um **cookie selado** com o rascunho, e a página do 303 o mostra.
  - **Selo próprio** (D4 do ADR-027): versão `r1`, AAD `trampo:portal.rascunho:r1:<PORTAL_ORIGIN>`. Nunca abre como sessão nem como fluxo.
  - **Conteúdo:** `{ sid, iat, aviso, campos, pares }`. Os `pares` são os campos do formulário já aceitos pela lista fechada; os `campos` são os nomes com erro. O `sid` é o da sessão que gravou.
  - Atributos do D3 do ADR-027 (`__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`) e **`Max-Age=120`**.
  - **Uso único:** o proxy o apaga na resposta de toda página (`GET`) em que ele chega, e a página o lê no mesmo pedido. A página só o usa com o **`sid` igual** ao da sessão verificada e **até 120 s** de idade. Senão ele é ignorado.
  - **Teto:** o texto claro tem até 2.950 bytes (o mesmo da sessão), e o par nome=valor fica abaixo de 4.096. Rascunho maior **não é guardado**: o aviso ganha a frase "não deu para guardar o rascunho", e a página mostra o que está salvo.
- **LGPD:** a pretensão do rascunho sai do servidor só selada, no navegador do próprio dono, por até 120 s, e some na primeira página. Nunca vai a URL, log, aviso ou `localStorage`. A página com a pretensão em claro é só a `/conta/criterios` do dono, com `no-store`.

### D9. Borda da API: o balde do limite de taxa por IP (decisão)
Todos os usuários do portal dividem os baldes por IP do portal (A6): `padrao` 120 por minuto (o `GET`) e `criterios` 30 por minuto (o `PUT`). Os baldes por usuário seguem por `sub`: 60 e 10.
- **Decisão: aceitar como residual nesta trilha**, sem mudar a API. Hoje há um usuário. O portal só lê ao abrir a página e só grava ao clicar em "Salvar". O 429 vira "indisponível" sem perder a sessão nem o rascunho.
- **No S-5 (hospedagem), uma das duas, com o `[APPSEC]`:**
  - o IP de saída do portal no `TRUST_PROXY` da API, e o portal mandando o `X-Forwarded-For` do usuário, lido do proxy confiável **dele**;
  - ou uma classe própria por usuário para chamada servidor a servidor.
  Até lá, o portal **nunca** manda `X-Forwarded-For` (lista fechada do D2).
- Linha nova na §9 do [threat-model](../threat-model.md).

### D10. O portal como *confused deputy* (ameaça nova, T51)
O servidor do portal repassa o Bearer do usuário. Mitigações:
- o destino é **fixo** (`API_ORIGIN` mais o caminho constante), validado no boot, nunca vindo do pedido (sem SSRF);
- o Bearer é o access **do próprio cookie selado**, verificado pela DAL antes de sair. O portal nunca escolhe o `userId`: a API tira o dono do token, e a RLS confere ([ADR-021-criteria-routes](ADR-021-criteria-routes.md) D4);
- a lista de cabeçalhos é fechada, sem o cookie do navegador;
- o `redirect: "error"` impede que o Bearer siga para outro host;
- a gravação exige `Origin` exato e `Sec-Fetch-Site`, então outro site não usa o portal para gravar em nome do usuário (CSRF).

### D11. Fronteiras do código
- O portal passa a depender de `@trampo/contracts` (`workspace:*`) e importa **só** os subcaminhos `user-criteria`, `limits` e `api`. A regra nova `portal-contracts-subpaths` do depcruise prende isso, com prova negativa. A extensão continua sem os critérios (F-02), e o portal continua sem importar a API (`clients-not-to-api`).
- A lógica fica em `src/server` (100% nas 4 métricas pela unidade): `api-client.ts`, `criteria-form.ts`, `criteria.ts` (a DAL da página e da gravação) e as emendas em `session.ts`, `cookies.ts`, `seal.ts`, `config.ts`, `notices.ts` e `edge.ts`. A página e a rota só traduzem.
- **Varredura na unidade:** nenhum `"use client"` em `src/` e nenhum `console.` em `src/server`, com controle positivo. Hoje isso é só regra escrita (condição 10 do ADR-027).

### D12. O que NÃO entra nesta trilha
Exportar e excluir a conta (F1-PORTAL-03), "Sair de todos os dispositivos" (F1-PORTAL-04), JS de cliente, edição parcial (o `PUT` é sempre o documento inteiro), histórico de versões e qualquer mudança na API.

## 3. Auditoria do `[APPSEC]` (sem veto, 14 condições)

**Fronteiras:** TB5 (portal → API) **passa a existir**: HTTPS, Bearer do usuário e nenhum cookie; TB12 (navegador → portal) ganha a gravação. **Ameaças:** T33 (CSRF), T49 (o cookie novo do rascunho), T50 (a página nova), T30 (falha que não pode virar "entre de novo"), SR-12 e a nova **T51** (*confused deputy*). **SR novo:** SR-27.

**Condições (cada uma com teste):**
1. **Destino fixo:** nenhuma entrada do pedido muda a URL da API; o cliente só fala com `API_ORIGIN` + `/v1/criteria`, e o 3xx da API é `nao_recebido`, sem seguir.
2. **Lista fechada de cabeçalhos:** na integração, a API simulada registra os cabeçalhos de cada pedido do portal. Só `authorization`, `accept`, `content-type` (no `PUT`) e os do próprio `fetch` (`host`, `connection`, `content-length`, `user-agent`, `accept-encoding`, `accept-language`, `sec-fetch-mode`), **nunca** `cookie`, `origin`, `referer` ou `x-forwarded-for`, mesmo com o navegador mandando todos eles ao portal.
3. **CSRF na gravação:** sem `Origin`, com outra origem, com `null` ou com `Sec-Fetch-Site` diferente de `same-origin`: 403, nenhum `PUT` e nenhum cookie.
4. **O 401 da API não apaga sozinho:** na gravação, renovação forçada; o GoTrue recusa → "entre de novo" com o cookie apagado; o GoTrue aceita → "indisponível" com o cookie novo e o rascunho, sem repetir o `PUT`. Na página, "indisponível" sem gravar cookie.
5. **O 503, o 429, o 500, o prazo e a conexão recusada** nunca apagam a sessão; o rascunho volta.
6. **Sem nova tentativa no `PUT`:** em cada modo de falha da API simulada, exatamente um `PUT` chega a ela.
7. **Validação antes da rede:** formulário inválido não chama a API; o aviso traz só nomes de campo do contrato e textos do catálogo, nunca o texto do Zod nem o valor recebido (prova com um valor canário).
8. **Formulário fechado:** nome desconhecido, campo único repetido, `Content-Type` diferente, corpo acima de 65.536 bytes e UTF-8 inválido dão `formulario_recusado`, sem rede e sem rascunho.
9. **Rascunho:** selado com a finalidade própria, `__Host-`, `HttpOnly`, `Max-Age=120`; o de outra sessão (`sid` diferente), vencido, adulterado ou de outra finalidade é ignorado; o proxy o apaga na primeira página; acima do teto não é gravado.
10. **A pretensão nunca vai a URL, log ou aviso:** no E2E, nenhuma URL do navegador e nenhuma saída do processo trazem o valor canário da pretensão; o formulário é `method="post"`.
11. **Página sem os critérios não mostra o formulário de padrões** (o 503 do `GET` não deixa salvar por cima).
12. **Fronteiras:** a regra nova do depcruise com prova negativa; nenhum `"use client"`; nenhum `console.` em `src/server` (varredura com controle).
13. **Mutação dirigida** (`mut_portal02.py`, U-, I- e Q-) antes do push.
14. **A gravação contra o projeto real só por HITL**, com o Size do cookie anotado no mesmo roteiro ([ADR-027-portal-login](ADR-027-portal-login.md) §8).

**Residuais (vão para a §9 do [threat-model](../threat-model.md)):**
- **Balde por IP dividido** (D9), até o S-5.
- **Rascunho no navegador** (D8): a pretensão selada fica até 120 s num cookie `HttpOnly` do dono. Quem tem o perfil (AT8) já tem a sessão (T49).
- **Escrita depois do 503** (A8): o usuário vê "não confirmado" e pode salvar de novo; a substituição é idempotente.

## 4. Plano de testes (`[QA_EVALS]`)

### 4.1 Unidade (100% nas 4 métricas em `src/server`)
- `api-client`: cada linha da tabela do D2, os cabeçalhos exatos, o teto de resposta, o UTF-8 estrito, a chave de protótipo, o corpo acima do teto, o `ApiError` sem a forma, o aborto antes de sair.
- `criteria-form`: ida e volta (`UserCriteria` → campos → `UserCriteria`), os padrões, cada campo, a importância, a normalização, os erros por campo, o nome desconhecido, o repetido, o tipo de mídia, o teto e o UTF-8.
- `criteria` (DAL): a tabela do D6 inteira, o D4 (renovação antes, forçada e o 401), o rascunho (selo, `sid`, idade e teto) e a página (com e sem critérios, com rascunho, indisponível).
- `session.apiAccess`: os três modos.
- A varredura de `"use client"` e `console.`.

### 4.2 Integração (socket real, contra o `next start`)
- **API simulada nova** (`test/support/fake-api.ts`): `GET` e `PUT /v1/criteria`; o Bearer conferido contra os access emitidos pelo GoTrue simulado; o `UserCriteriaSchema` no `PUT` (400), o 415, o 413 e o 409; modos `responde` (401, 403, 429, 500 e 503 com o `ApiError`), `lento`, `corta`, `trava` e `redireciona`; o registro dos pedidos, com os cabeçalhos.
- Os cabeçalhos de segurança uma vez cada na página nova e na rota; `no-store`; o `Origin` e o `Sec-Fetch-Site` na gravação; a tabela de open redirect; a saída do processo sem segredo e sem a pretensão canário.

### 4.3 E2E (Edge, pelo botão real, cuidado 36)
Preencher e salvar pelo botão; o valor salvo volta ao abrir de novo; a pretensão canário nunca vai a URL; o 401 da API com o GoTrue recusando vira "entre de novo", e com o GoTrue aceitando vira "indisponível" com o rascunho; o 503 mantém a sessão e o rascunho; nenhum erro de CSP. Três rodadas.

### 4.4 Mutação (`mut_portal02.py`)
U- pela unidade (cabeçalho a mais, classificação trocada, o `PUT` repetindo, o 401 apagando a sessão, o rascunho sem o `sid`, o erro com o texto do Zod, a lista fechada aberta); I- pela integração (o `Origin` não conferido, o `no-store` retirado, o proxy sem apagar o rascunho); Q- pelo E2E com rebuild (o formulário por `GET`, o rascunho que não volta, o 503 apagando a sessão).

## 5. Partição em commits
1. `feat(web-portal)`: núcleo (`api-client`, `criteria-form`, a DAL, as emendas de `session`, `seal`, `cookies`, `config` e `notices`), a API simulada e a unidade (Etapa 3).
2. `feat(web-portal)`: a página, a rota, o proxy, o link na `/conta`, a regra do depcruise, a integração e o E2E (Etapa 4).
3. `docs`: o `next-step.md` e o `docs/`.

## 6. Emendas da implementação (sessões 30 e 31, 2026-11-14 e 2026-11-15)

- **Commits:** `53b4f69` (o núcleo, sessão 30) e `45670b9` (a página, a rota, o depcruise, a integração e o E2E, sessão 31). A sessão 30 caiu por cota no meio da mutação da borda; a sessão 31 conferiu a árvore (nenhum mutante no disco), terminou a mutação e fechou a etapa.
- **Arquivo que o D11 não previa:** `src/server/criteria-labels.ts`, o catálogo fixo dos rótulos (um título por campo e um texto por opção dos enums do contrato). O tipo exige um rótulo por opção: um enum novo no contrato derruba o typecheck e a unidade. A página e o formulário (`page.tsx` e `form.tsx`) só leem desse catálogo e do `notices.ts`; nenhum texto vem do pedido.
- **`src/server/http.ts`:** os auxiliares de leitura com teto, UTF-8 estrito e JSON sem chave de protótipo saíram do `gotrue.ts` e servem aos dois clientes.
- **O formulário em dois arquivos:** `page.tsx` (a sessão, a leitura, os avisos) e `form.tsx` (o HTML dos campos). Os dois são Server Components sem hook; a varredura da unidade confirma que não há `"use client"`.
- **Resultados:**
  - unidade: 426 casos, 100% nas 4 métricas em `src/server`;
  - integração (25 casos contra o `next start`): as condições 1 a 9, 11 e a saída do processo;
  - E2E no Edge: 6 casos dos critérios (salvar e reabrir, o 503, o 401 com o GoTrue recusando e aceitando, o erro de validação e a saída do processo), 14/14 com os do login, 3 rodadas;
  - mutação: U- 36/36, G- 7/7 e H- 6/6 (sessão 30); I- 8/8 e Q- 7/7 (sessão 31). O plano do §4.4 pedia três mutantes que o primeiro roteiro da borda não tinha (o `no-store` retirado, o proxy sem apagar o rascunho e o 503 apagando a sessão): entraram no `mut_portal02_edge2.py`, e os três morreram;
  - depcruise: a regra `portal-contracts-subpaths` com a prova negativa (um arquivo plantado importando a raiz do `@trampo/contracts` deu 1 erro).
- **Condição 14 (o projeto real):** aberta no *HITL-QUEUE §HITL-043*, com o roteiro no *auth-portal* §8. O mesmo roteiro anota o Size do cookie ([ADR-027-portal-login](ADR-027-portal-login.md) §8).
