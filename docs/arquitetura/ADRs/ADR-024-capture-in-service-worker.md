---
tipo: adr
id: ADR-024
titulo: "Captura no Service Worker (F1-EXT-03 parte 1): extrator genérico injetado sob clique no frame principal e no mundo ISOLATED, retorno validado como dado hostil, limpeza de controles e surrogates órfãos antes do corte por code point, última captura em storage.session, painel só com a visão sem texto e fallback 'colar o texto'"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]) dentro do F1-EXT-03 e do ADR-001 §5.0. Não muda contrato público (packages/contracts), nem EXTRACTION_PROMPT_VERSION, nem LLM_OUTPUT_GUARD_VERSION, nem o extrator ge1."
data: 2026-10-27
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "apps/extension/src/capture/**, src/messaging/{protocol,worker-port}.ts, src/entrypoints/{background.ts,sidepanel/App.tsx}, test/capture*.test.ts, test/e2e/capture.e2e.test.ts"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-023-generic-dom-extractor](ADR-023-generic-dom-extractor.md)", "[ADR-005-job-text-normalizer](ADR-005-job-text-normalizer.md)", "[threat-model](../threat-model.md)", "[contratos-zod](../contratos-zod.md)", "*BACKLOG §F1-EXT-03*"]
---

# ADR-024: captura no Service Worker

## 1. Contexto

O [ADR-023-generic-dom-extractor](ADR-023-generic-dom-extractor.md) entregou o extrator genérico `ge1`, provado no Edge com fixtures sintéticas, mas sem ligação no Service Worker. O ADR-001 §5.0 (passos 1 a 5) define o fluxo:
- clique no ícone;
- `sidePanel.open` como primeira instrução;
- `executeScript` com a função autocontida;
- validação, limpeza e truncamento no Service Worker;
- última extração em `storage.session`;
- fallback "colar o texto" (D10).

A parte 1 do F1-EXT-03 liga **só o genérico**. Os extratores do LinkedIn e da Gupy esperam as fixtures reais (*HITL-QUEUE §HITL-030*).

Sondagem no Edge 155 (2026-10-27, scratchpad), feita antes do desenho:
- `Extensions.triggerAction` (CDP), sobre o alvo do tipo `tab`, dispara `action.onClicked` **com gesto**. O `sidePanel.open` passa e o `activeTab` é concedido de verdade. Isso permite o E2E com o fluxo real, sem `host_permissions` de teste.
- O `executeScript` **rejeita** numa página restrita (`edge://`: "Cannot access chrome:// and edge:// URLs") e numa página de outra extensão ("Extension manifest must request permission…"). A mensagem pode trazer a URL.
- Se a função injetada lança, o retorno é `[{ frameId: 0, result: null }]`, sem a mensagem.
- O build de produção do WXT **minifica** o Service Worker. O nome `extractGenericJobText` some, e a função vai serializada pelo `toString()` do código minificado.

## 2. Decisões

### D1. Local
- O código do Service Worker fica em `src/capture/`, fora de `src/extraction/`. O lint de só-leitura do ADR-023 D8 proíbe `browser`/`chrome` e imports de runtime lá, e continua valendo só para o extrator.
- Módulos:
  - `job-text.ts` faz a limpeza;
  - `capture.ts` faz a injeção, a validação e o texto colado;
  - `capture-service.ts` cuida do estado e das portas.
- O `background.ts` só liga as peças.

### D2. Injeção
- `browser.scripting.executeScript({ target: { tabId }, world: "ISOLATED", injectImmediately: false, func: extractGenericJobText, args: [limites] })`:
  - só o frame principal (sem `allFrames` nem `frameIds`);
  - o mundo é explícito, embora ISOLATED já seja o padrão;
  - um teste de unidade trava a forma exata da injeção.
- Ordem no `action.onClicked`:
  1. `sidePanel.open` como primeira instrução, sem `await` antes;
  2. depois a captura, com o `activeTab` já concedido pelo clique.
- **Limites:**
  - `maxChars = 2 × JOB_TEXT_MAX_CHARS` (30.000 unidades UTF-16). Esse teto garante pelo menos 15.000 code points, para que o corte que decide seja o do Service Worker, e não o do extrator;
  - `maxNodes = 50.000`, a calibrar na D2 com as páginas reais;
  - `minChars = JOB_TEXT_MIN_CHARS`, refeito em code points depois da limpeza.

### D3. Validação e limpeza (passo 5 do ADR-001 §5.0)
- **O retorno é dado hostil.** O `InjectionResult[]` precisa ser uma tupla de exatamente 1 item, com `frameId` 0. Chaves extras do Chrome, como `documentId`, são ignoradas.
- O `result` passa por um Zod **estrito**:
  - `ok`, a `versao` literal `ge1`, a `raiz` do enum, o `texto` até `maxChars` e o `truncado` booleano;
  - os **12 contadores** exatos, inteiros de 0 a `maxNodes`. Um tipo de exaustividade quebra a compilação se o extrator ganhar contador novo;
  - o `ok: false` só com os dois motivos conhecidos.
- **Limpeza (`cleanJobText`), nesta ordem:**
  1. CRLF e CR viram `\n`;
  2. **surrogates órfãos saem antes dos controles**: um controle entre duas metades soltas, como `\uDB40\u0007\uDC41`, não pode juntá-las num Unicode Tag depois da remoção (ASCII smuggling);
  3. C0 sai (menos `\t` e `\n`), e saem também o DEL e o C1;
  4. trim;
  5. corte em `JOB_TEXT_MAX_CHARS` code points (`truncateCodePoints` do contrato), e as pontas são aparadas de novo.
- **Os invisíveis Cf ficam**: zero-width, bidi, Unicode Tags, *variation selectors*, U+00A0 e U+FEFF. Quem remove e conta é o `JobTextNormalizer` (ADR-023 D5, T2).
- O `truncated` final vale `truncado do extrator OU corte do Service Worker`.
- Pior caso do corpo: 15.000 code points × 4 bytes, sem escapes `\uXXXX` de controle. Cabe nos 64 KiB do servidor (pressuposto do `HTTP_BODY_MAX_BYTES`).

### D4. Estado e painel
- Uma chave em `storage.session`, `trampo/captura/v1`, com uma união estrita:
  - `lendo` (aba);
  - `pronto` (`CapturedJob`: aba ou `null`, `capturedAt`, `platform` `generico`/`texto_colado`, `extractorVersion`, texto de 200 a 15.000 code points e `truncated`);
  - `falhou` (aba ou `null`, motivo).
- A leitura revalida com Zod: valor adulterado é apagado e lido como ausente (`sessionStore`). Só a última captura existe.
- **O painel recebe só a visão:** `ocioso`, `lendo`, `pronto` (origem `pagina`/`texto_colado`, contagem em code points e `truncado`) ou `falhou` (motivo). **Nunca recebe o texto**, que fica no Service Worker até o envio à API (F1-EXT-04/05). O schema da visão é estrito, e um teste prova que a visão com `texto` é recusada.
- A porta confiável recebe o estado atual logo depois do `ready` e as mudanças seguintes. Uma porta que cai, ou que lança no envio, sai da lista sem derrubar as outras.
- **Corrida:** cada clique e cada texto colado incrementam uma geração. Uma leitura que termina depois de outra mais nova é descartada.
- **Aba fechada** (`tabs.onRemoved`, que não exige a permissão `tabs`): a captura daquela aba é apagada, e uma leitura em curso dela é descartada. O texto colado não pertence a aba nenhuma e fica.

### D5. Fallback "colar o texto" (ADR-001 D10)
- A falha da captura vale para os 3 casos que o next-step pedia. O painel mostra um campo de texto (`textarea`, só texto via React) e o botão "Usar este texto":

| Caso | Motivo |
|---|---|
| Rejeição do `executeScript` (página restrita, concessão do `activeTab` ausente ou caída) | `sem_acesso`. A mensagem do navegador **não é lida**, porque pode ter a URL da aba |
| Retorno nulo (o extrator lançou) ou fora da forma | `erro` |
| `ok: false` do extrator, ou texto abaixo de 200 code points depois da limpeza | `texto_insuficiente` |
| `limites_invalidos` (bug nosso) | `erro` |

- A mensagem nova da porta é `{ kind: "colar", texto }`, estrita, com teto de 30.000 unidades UTF-16. O `maxLength` do campo usa o mesmo teto. Acima dele, a porta cai (SR-10).
- O texto colado passa pela **mesma limpeza e pelo mesmo mínimo**. Ele vira `platform: "texto_colado"`, `extractorVersion: "colado-1"`, sem aba.

### D6. Logs
- O Service Worker registra só motivos de lista fechada:
  - `[trampo] captura falhou: <motivo>`;
  - `[trampo] falha interna na captura`;
  - os motivos de recusa da porta, que já existiam.
- Nenhum texto de vaga, URL ou mensagem de erro do navegador vai para log (T23). Testes de unidade conferem os argumentos do log.

### D7. Prova da autocontenção no bundle de produção
- `test/e2e/capture.e2e.test.ts` roda sobre o **build de produção** (o `global-setup` do E2E), carregado no Edge real. A página local é hostil:
  - no mundo principal, troca `checkVisibility`, `getComputedStyle` e `Range.prototype.getClientRects`;
  - esconde 13 canários por técnicas do T2 e em lugares que não são texto (atributo, comentário, `script`, SVG, `noscript`, `nav`);
  - traz um Cf (`&#x200B;`) e um BEL (`&#x7;`).
- O clique vem do `Extensions.triggerAction`.
- **Prova negativa:** uma variante do extrator com uma referência ao escopo do módulo derruba 3 dos testes do E2E de produção. A captura vira `erro`, porque a função serializada perde a referência. O teste, portanto, detecta a falta de autocontenção. O arquivo foi restaurado com o hash idêntico.

## 3. Auditoria do `[APPSEC]` (sem veto)

Critérios de aceite:
1. Sem `host_permissions`, sem permissão `tabs` e manifesto sem mudança. O `activeTab` vem só do clique.
2. Só o frame principal e o mundo ISOLATED, travados por teste.
3. O retorno é validado como hostil (forma estrita, tamanho e contadores) antes de qualquer uso.
4. Controles e surrogates órfãos saem em ordem que não recombina metades. Os Cf ficam para o servidor.
5. Corte em code points, com o pior caso abaixo dos 64 KiB.
6. O texto fica só em `storage.session` e no Service Worker. O painel nunca o recebe.
7. Nenhum texto de vaga, URL ou mensagem do navegador em log.
8. Fallback para `sem_acesso`, `erro` e `texto_insuficiente`.
9. O E2E de produção prova a autocontenção, com prova negativa, e nenhum canário no storage nem no painel.
10. Nenhuma versão de prompt, guard ou extrator muda, e nada chama a rede externa.

Riscos residuais (aceitos):
- **Navegação para outro site na mesma aba:** sem a permissão `tabs`, o Service Worker não vê a URL. A captura antiga fica até a aba fechar ou até o próximo clique. Ela é só o texto que o próprio usuário pediu para ler.
- **`storage.session` em memória:** a captura some quando o navegador fecha. É o comportamento desejado (minimização).
- **`maxNodes` de 50.000** pode cortar páginas gigantes antes do conteúdo. O `truncado` sinaliza, e a D2 mede nas páginas reais.
- **O painel ainda não pede a releitura** depois de a concessão cair (ADR-001 §5.0 passo 5). Isso entra com a UI da F1-EXT-04: hoje, um novo clique no ícone relê a aba.

> [!note] Nota de 2026-10-27 (Trilha G, [ADR-025-side-panel-ui](ADR-025-side-panel-ui.md))
> - O conjunto de portas do `capture-service` virou o `src/messaging/panel-hub.ts`, compartilhado com o consentimento. O comportamento não mudou: os 15 testes passaram sem alteração.
> - O handshake agora manda `ready`, `captura` e `consentimento`, nessa ordem.
> - O E2E "de produção" deste ADR usava o React de **desenvolvimento** no painel, porque o vitest define `NODE_ENV=test`. O `global-setup` agora força `NODE_ENV=production` durante o build. O Service Worker já saía minificado, e a D7 continua válida.
> - O pedido de releitura continua sem tela própria: o painel diz "clique no ícone do Trampo", e isso fica para a parte 2.

## 4. Consequências
- O F1-EXT-03 parte 2 (extratores do LinkedIn e da Gupy) escolhe o extrator pelo host da aba e cai no genérico. A `platform` do `CapturedJob` ganha `linkedin` e `gupy`. Isso espera o *HITL-QUEUE §HITL-030*.
- O F1-EXT-04 (UI) e o envio à API leem a `vaga` do `storage.session` no Service Worker e montam o `AnalyzeJobRequest` com `requestId = crypto.randomUUID()`.
- Nenhum schema novo em `packages/contracts`: o protocolo da porta e o estado da captura são privados da extensão (como o `protocol.ts` do F1-EXT-02). O [contratos-zod](../contratos-zod.md) não muda.

## 5. Implementação (2026-10-27, Trilha F)
- **Código novo:**
  - `src/capture/job-text.ts`, `capture.ts` e `capture-service.ts`;
  - `protocol.ts` ganhou o `colar` e a `captura`; `worker-port.ts` ganhou o `onReady` e o `onPaste`;
  - `background.ts` faz a ligação, e o painel mostra o estado e o formulário de colar.
- **Testes:**
  - `test/capture.test.ts` e `test/capture-service.test.ts`;
  - a mensageria ganhou casos novos;
  - `test/e2e/capture.e2e.test.ts` tem 6 testes, e o `browser.ts` ganhou o `clickAction` via `Extensions.triggerAction`.
- **Cobertura:** `@vitest/coverage-v8` (do catálogo) na extensão, com limite de 100% em `src/capture/**` e `src/messaging/**`. O `background` e o painel são cola, provados no E2E.
- **Prova:**
  - unidade: 110 testes, 100% nas 4 métricas;
  - E2E: 15/15 em 3 rodadas (CSP 5, mensageria 5, captura 6);
  - `test:browser`: 52/52 (o extrator não mudou);
  - mutação: 66 de 66 mutantes mortos em `src/capture` e no protocolo da porta (script no scratchpad, arquivos restaurados com o hash idêntico);
  - prova negativa da autocontenção no E2E de produção (D7).
- **Achado:** o `fake-browser` do WXT devolve `{ chave: undefined }` para chave ausente, mas o Chrome omite a chave. O caminho "ausente" do `sessionStore` nunca rodava nos testes. Um teste com área injetada cobre agora o comportamento real.
- **Mudança de comportamento:** o handshake real manda `ready` e logo em seguida a `captura`, e a expectativa do E2E de mensageria foi atualizada.
- `[APPSEC]`: os 10 critérios do §3 estão cobertos, e não há veto.

## 6. Extratores de plataforma (2026-10-31, Trilha D2b)
- **Injeção:** `executeScript({ ..., func: extractJobText, args: [limites, plataforma] })`. A forma continua travada por teste de unidade: só o frame principal, o mundo ISOLATED e os mesmos limites.
- **Escolha:** `capture.captureTab(tab.id, platformForUrl(tab.url))`. O `activeTab` entrega a URL da aba no clique, sem a permissão `tabs`. Só o host vira a plataforma, e a URL não vai para o storage nem para log. O E2E confere que o host não aparece no estado guardado.
- **D3 emendada:** a `versao` é `ge1`, `li1` ou `gu1`, e a `raiz` aceita `plataforma`. O resultado é recusado como `erro` se a versão não bate com a plataforma pedida: `ge1` vale para todas, mas só com a raiz genérica; `li1` e `gu1` valem só para a própria plataforma e só com a raiz `plataforma`.
- **D4 emendada:** a `platform` do `CapturedJob` ganha `linkedin` e `gupy`. A plataforma é a que o host escolheu, e a `extractorVersion` é a que rodou. A visão do painel não muda: `origem` continua `pagina`.
- **Critérios do §3 conferidos de novo:** manifesto sem mudança e sem `host_permissions` (teste do manifesto), retorno validado antes do uso, texto fora do painel, nenhuma URL em log ou storage, e fallback igual.
- **Riscos residuais novos (aceitos):**
  - **LinkedIn logado não medido.** As fixtures são da página pública, sem login. O layout logado usa outras classes, e nele o `li1` cai no `ge1`, que pode pegar a lista junto com a vaga. O sinal é `linkedin` + `ge1` na telemetria, e a coleta logada é o *HITL-QUEUE §HITL-033*.
  - **A URL passa pela memória do Service Worker** durante o clique, como já passava pelo objeto `tab`. Ela não é copiada para fora do `platformForUrl`.
  - **Página da plataforma controlada por terceiro** (por exemplo, uma empresa num subdomínio da Gupy): a plataforma só escolhe a raiz, e as regras de descarte e a validação são as mesmas. Não há ganho de privilégio.

## 7. LinkedIn logado e Solides (2026-10-31, Trilha D2c)
- **Escolha:** o `platformForUrl` acrescenta `https://vagas.solides.com.br` e `*.vagas.solides.com.br` (Solides). `app.solides.com.br`, `http:` e sufixo parecido caem no genérico.
- **D3 emendada:** cada plataforma aceita a lista das suas versões: LinkedIn `li2` e `li1`, Gupy `gu1`, Solides `so1`. O `ge1` continua valendo para todas, só com a raiz genérica. O `{ ok: false, versao: "li2", motivo: "texto_insuficiente" }` da falha fechada ([ADR-023-generic-dom-extractor](ADR-023-generic-dom-extractor.md) D12) é aceito e vira o fallback "colar o texto".
- **D4 emendada:** a `platform` do `CapturedJob` ganha `solides`. O `PlatformSchema` do contrato ganha o mesmo valor (DOC-01, [contratos-zod](../contratos-zod.md) §9).
- **Critérios do §3 conferidos de novo:** manifesto sem mudança e sem `host_permissions`, retorno validado antes do uso, texto fora do painel, nenhuma URL em log ou storage, e fallback igual.
- **E2E no build de produção:** o host real do LinkedIn logado (`/jobs/search-results/`) dá `li2` com o texto da descrição e sem os proibidos; o da Solides dá `so1`; uma página logada sem a descrição dá `texto_insuficiente`, e o painel oferece colar o texto.
- **Risco residual novo (aceito):** a página logada guarda o texto do perfil (qualificações, rede) no DOM, fora da raiz. O extrator nunca o lê enquanto o `li2` ou o `layout` reconhecem a página; se os dois mudarem, o `ge1` volta a lê-lo (sinal `linkedin` com `ge1`).
