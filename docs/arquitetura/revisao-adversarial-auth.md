---
tipo: revisao
id: F1-SEC-01
data: 2026-11-11
revisores: ["[APPSEC]", "[ARCHITECT]", "[QA_EVALS]"]
escopo: "Código de auth depois da implementação: BFF da API (F1-API-07: application/auth, portas, gotrue-token-client, aead-envelope e aead-refresh-sealer, borda e rotas) e extensão (F1-EXT-05a, b e c: src/auth, src/api, mensageria, painel, lint, depcruise e build)"
status: aprovado
aprovacao: "HITL-039, aprovado em 2026-11-11 junto com o threat model v2 (ADR-004 CA-13 cumprida)"
relacionados: ["[ADR-004-extension-auth](ADRs/ADR-004-extension-auth.md)", "[threat-model](threat-model.md)", "[revisao-adversarial-M1](revisao-adversarial-M1.md)", "*BACKLOG §F1-API-08*", "*BACKLOG §F1-EXT-07*"]
---

# Revisão adversarial de auth (F1-SEC-01)

> [!info] Método
> Duas lentes independentes, só leitura: o BFF da API e a extensão. Cada uma atacou o código como atacante (forja e *replay* do envelope, injeção de código, caminhos codificados, *preflight*, limitador, orçamento, mapa de erros, logs, corridas do ciclo de vida, lint e build), conferiu cada suspeita no código e procurou o teste que a prova. Os residuais já aceitos no [ADR-004-extension-auth](ADRs/ADR-004-extension-auth.md) §3 ficaram de fora. A equipe reconferiu cada achado abaixo no código antes de registrar: os do lint por `eslint --stdin` num arquivo de `src/auth`, os outros pela leitura das linhas citadas. Nada chamou o Supabase real nem provedor de LLM.

## Veredito

**Aprovado com tarefas, sem veto do `[APPSEC]`.** Nenhum achado crítico ou alto. Dois médios (A-01 e A-02) têm a mesma causa: uma recusa sem o corpo do GoTrue é tratada como recusa legítima, quando a emenda do HITL-035 ao 404 manda tratá-la como "não recebeu". Os dois e os baixos que pedem código viram tarefas próprias, uma por vez: *BACKLOG §F1-API-08* (API) e *BACKLOG §F1-EXT-07* (extensão). O A-03 e o A-04 ganharam teste nesta trilha.

**Atualização (F1-EXT-07, 2026-11-11, sessão 21):** o E-01, o E-02 e o E-03 foram fechados no `08149f0` (emendas do D10 e do D11 no [ADR-004-extension-auth](ADRs/ADR-004-extension-auth.md)). Todos os achados desta revisão estão fechados. O prompt da sessão chamou esses três de A-04, A-05 e A-07; os IDs desta nota não mudaram.

**Atualização (F1-API-08, 2026-11-11):** o humano aprovou esta revisão e o threat model v2 no *HITL-QUEUE §HITL-039*. O A-01, o A-02 e o A-03 foram fechados na *BACKLOG §F1-API-08* (emendas do D7 e do D8 item 5 no [ADR-004-extension-auth](ADRs/ADR-004-extension-auth.md)). O E-01, o E-02 e o E-03 seguem na *BACKLOG §F1-EXT-07*.

## Achados

| ID | Sev. | Onde | Achado | Cenário de falha | Prova ou tarefa |
|---|---|---|---|---|---|
| A-01 | 🟠 média | `gotrue-token-client.ts` (logout, ramo do 401) | No logout, qualquer 401 vira "encerrada" sem ler o corpo, e o BFF responde 204. O GoTrue real responde **403 `session_not_found`** à sessão encerrada (contrato do 07h); o 401 sem corpo do GoTrue vem do gateway (`Invalid API key`). | A *publishable* é rotacionada ou desligada no painel. O usuário clica "Sair", vê "saiu", e a sessão segue viva no GoTrue: um envelope roubado renova até a inatividade ou a idade máxima, e o aviso do D11.5 não aparece. | Os testes de hoje prendem o comportamento (`gotrue-token-client.test.ts`, "o 401 vale sem corpo"; `auth-session-stack.test.ts`, "sessão já revogada (401)"). Tarefa **F1-API-08**, com emenda do D7. **Fechado (F1-API-08, 2026-11-11):** o 401 nunca é encerrada; testes trocados e novos (`gotrue-token-client.test.ts`, `auth-session-stack.test.ts`, *publishable* errada nas 3 chamadas) e mutantes C-16 a C-22 do `mut08.py`. |
| A-02 | 🟠 média | `gotrue-token-client.ts` (`REFUSAL_STATUSES`) | Na troca e na renovação, 400, 401, 403 e 422 viram `recusado` sem corpo. O motivo da emenda do 404 (desvio de configuração não vira laço de relogin, T30) vale igual para o 401 do gateway e para um 403 em HTML de WAF ou proxy. | *Publishable* revogada ou WAF na frente do Supabase: toda renovação dá 401 e o SW apaga a sessão de todos os usuários; toda troca dá 401, num laço de relogin. Devia ser 503. | Teste de hoje prende o comportamento (`gotrue-token-client.test.ts`, "%d é recusa mesmo sem corpo"). Tarefa **F1-API-08**: antes do código, conferir no job `db` se o GoTrue sempre manda `error_code` nesses status. **Fechado (F1-API-08, 2026-11-11):** conferido no código-fonte do GoTrue v2.197.0 (o da CLI do CI) e preso por 9 casos no job `db`; os 5 status sem o corpo do GoTrue dão `nao_recebido`; mutantes C-01 a C-15. O 401 do gateway real fica no S-3 (P21). |
| A-03 | 🟢 baixa | `gotrue-egress.ts` (`run`) | O orçamento reserva 50% para a renovação, mas o *bulkhead* de 4 vagas é um só para troca, renovação e logout. | GoTrue lento: 4 trocas anônimas com código de formato válido ocupam as 4 vagas, e as renovações levam 503 `bulkhead_cheio` por até 5 s. O 503 não apaga a sessão (D11.3), e o limitador local e o teto de 14 trocas limitam o estrago. | **Teste novo:** `gotrue-egress.test.ts`, "bulkhead sem partição (A-03)". Decisão (reservar 1 vaga para a renovação ou aceitar no §3) na **F1-API-08**. **Fechado (F1-API-08, 2026-11-11):** a troca ocupa no máximo 3 das 4 vagas, e a última fica para a renovação e o logout (ADR-004 D8 item 5); o teste do A-03 foi trocado; mutantes E-01 a E-12. |
| A-04 | ⚪ info | `cors.ts` (*preflight*) | O *preflight* só confere o caminho cru: `OPTIONS /v1/%61uth/exchange` de origem web recebe 204. O pedido real é barrado pelo padrão casado. | Nenhum impacto: o pedido real leva 403 antes do limitador e do caso de uso. | **Teste novo:** `auth-routes.test.ts`, "preflight de `%61uth` da origem de web passa (…), mas o pedido real leva 403". Fechado. |
| E-01 | 🟢 baixa | `eslint.config.js` (`storageSelectors`) | A proibição de `setAccessLevel` só pega a forma literal. `browser.storage.session["setAccessLevel"](…)` e `const { setAccessLevel } = browser.storage.session` passam no lint do SW (conferido por `eslint --stdin` em `src/auth`); o grep do B5 não procura a palavra. | Um commit no SW abre o `storage.session` para content scripts, e o token fica legível no mundo ISOLATED da aba. O E2E (`auth-negative`, item 7) pegaria, mas só nos cenários exercitados. | Tarefa **F1-EXT-07**: `setAccessLevel` no `FORBIDDEN_PROPERTIES` (pega computado e desestruturação), fixtures negativas no `worker-modules-lint.test.ts` e o marcador no artefato inteiro, `background.js` incluído. O alias de `storage` (`const s = browser.storage; s.local`) fica como residual de lint coberto pelo E2E, registrado no D10. **Fechado (F1-EXT-07, 2026-11-11):** 5 seletores em todo `.ts`/`.tsx` (nome, acesso computado por string e por template, desestruturação com ou sem outro nome) e a regra de propriedades em `src/`; 14 formas × 15 arquivos de fixture e o marcador no artefato inteiro; mutantes Z-01 a Z-13 do `mut_ext07.py`. Residual: o nome montado em tempo de execução e o alias de `storage`. |
| E-02 | 🟢 baixa | `auth-service.ts` (`onUnauthorized`) | O `onUnauthorized(2)` apaga a sessão gravada naquele momento, sem conferir a geração nem o token que levou o 401. | Análise em voo com o token da sessão A; "Sair" e novo login em segundos (sessão B); o 401 atrasado da A apaga a B, que é válida. Hoje não há quem chame (F1-EXT-04 parte 2). | Tarefa **F1-EXT-07**: o `onUnauthorized` recebe a geração (ou o token) capturada no envio e só apaga a sessão atual. Teste: "o 2º 401 de uma sessão anterior não apaga a sessão de um login novo". Pré-requisito da F1-EXT-04 parte 2. **Fechado (F1-EXT-07, 2026-11-11):** `onUnauthorized(tentativa, usado)` recebe o token que levou o 401; se não é o da sessão gravada, nada é renovado nem apagado, e só o token que a renovação desta mesma geração trocou recebe o atual; mutantes X-01 a X-11. |
| E-03 | 🟢 baixa | `auth-service.ts` (troca descartada pela geração) | Com "Sair" durante a troca em voo, a sessão que chega é descartada só no local; ninguém chama o logout remoto com o access recebido. | Uma sessão órfã em `auth.sessions` a cada "Sair" que cai durante a troca (no Free, o refresh não expira). | Tarefa **F1-EXT-07**: logout remoto em melhor esforço com o access recebido, sem gravar nada. Até lá, o caso entra no residual "Sessão órfã" do ADR-004 §3. O hook (F1-DB-02) também o limita a 24 h. **Fechado (F1-EXT-07, 2026-11-11):** `POST /v1/auth/logout` em melhor esforço com o access recebido, uma tentativa, em segundo plano, sem gravar nem emitir; a falha só registra `auth_logout_remoto_falhou`; mutantes Y-01 a Y-15. Segue no residual "Sessão órfã" o caso em que esse logout falha. |

## Verificações que passaram (sem achado)

- **Envelope:** AAD com a origem (outra origem não abre), prefixo amarrado à versão, `kid` desconhecido não abre, IV aleatório por selagem, base64url não canônica recusada, `__proto__` e chave extra recusados, teto de 768 bytes exato, anéis sem material comum (`aead-envelope.test.ts`, `aead-refresh-sealer.test.ts`).
- **Renovação:** ordem formato → `open` → idade → inatividade → chaves → orçamento, com 0 chamadas ao GoTrue para envelope forjado ou vencido; `sid` divergente dá 401 sem selar; no máximo uma nova tentativa, com orçamento próprio (`refresh-session.test.ts`).
- **Troca:** Zod antes do `keysReady`, do orçamento e do GoTrue; sem nova tentativa; resposta com exatamente 4 chaves (`exchange-session.test.ts`, `auth-routes.test.ts`).
- **Cliente do GoTrue:** URL fixa, `redirect: "error"`, lista fechada de cabeçalhos sem `X-Forwarded-For`, teto de 32 KiB, UTF-8 estrito, 404 sem o corpo do GoTrue vira `nao_recebido`, `error_code` fora do log (`gotrue-token-client.test.ts`).
- **Contenção:** partições e reserva do orçamento, negação que não consome, vaga do *bulkhead* que volta na rejeição (`gotrue-egress.test.ts`); IPv6 por /64, `X-Forwarded-For` só de proxy confiável, transbordo sem despejo, 0 comandos Redis antes do JWT (`pre-auth-limit.test.ts`, `auth-routes.test.ts`).
- **Borda:** `Origin` obrigatório, `%61uth`, barra final, GET e PUT fora, `bodyLimit` de 2.048, `no-store` também nos erros, logs amostrados e SR-12 com canários (`auth-routes.test.ts`, `cors-routes.test.ts`).
- **PKCE e retorno:** 32 bytes de `getRandomValues`, só S256, verifier apagado logo depois do envio; `authorize` com 4 parâmetros; `parseAuthRedirect` byte a byte (caixa, userinfo, porta, `..`, `%61uth`, raiz do host, sufixo), fragmento só com `error*`, `code` e `st` repetidos recusados, `error` sem eco (`auth-pkce.test.ts`, `auth-redirect.test.ts`).
- **Ciclo de vida:** um fluxo por vez, prazo de 5 min, *single-flight* por geração, 401 só com `NAO_AUTENTICADO` apaga, logout local primeiro (`auth-service.test.ts`).
- **Armazenamento, cliente e mensagens:** `StoredSessionSchema` estrito revalidado na leitura; `api-client` com 4 caminhos, Bearer só em 2, `credentials: "omit"` e leitura única contra *getter*; só `runtime.onConnect`, com nome da porta, ID, origem e `/sidepanel.html` conferidos e `externally_connectable` vazio (`session-store.test.ts`, `api-client.test.ts`, `messaging.test.ts`, `manifest.test.ts`).
- **Painel e build:** `SessaoView` saneada, lint B1, depcruise B3, fecho do B5 sem código de auth, meta CSP antes de qualquer script, origens https exatas, `key` RSA canônica e `TRAMPO_E2E_FAKE_IDENTITY` derrubando o build (`worker-modules-lint.test.ts`, `manifest.test.ts`, `panel-csp.test.ts`, `build-env.test.ts`).

## Ligação com o threat model

| Achado | Ameaça | SR |
|---|---|---|
| A-01 | T44, T9 (logout global que não sai) | SR-24 |
| A-02 | T30, T43 | SR-21 |
| A-03 | T43 | SR-20 |
| A-04 | T43 | SR-19 |
| E-01 | T22, T46 | SR-23 |
| E-02 | T9 (ciclo de vida) | SR-24 |
| E-03 | T48 (sessão fora do controle do BFF) | SR-24 |

> 🛡️ **Análise de Segurança (AppSec):** nenhum achado abre token, envelope, código ou verifier a um contexto não confiável. O pior caso da API (A-01) é um logout que finge ter saído quando o gateway recusa a chave; o da extensão (E-01) é o lint deixar passar uma forma que o E2E ainda pegaria. As correções ficam na F1-API-08 e na F1-EXT-07, cada uma com teste antes do código, mutação dirigida e o `[APPSEC]` revisando a emenda do D7.
