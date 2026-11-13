---
tipo: adr
id: ADR-025
titulo: "UI do Side Panel (F1-EXT-04 parte 1): consentimento imposto pelo Service Worker em storage.session e versionado, redutor puro do painel, catálogo de textos exaustivo por enum, relatório só em texto sem nenhum link (lint), erros pelo código e nunca pelo message do servidor, botões de envio desabilitados até a API e E2E do React de produção com porta falsa"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]) dentro do F1-EXT-04 e do ADR-001 §5.0 (passos 6 e 7). Não muda contrato público (packages/contracts), manifesto, CSP, extrator, EXTRACTION_PROMPT_VERSION nem LLM_OUTPUT_GUARD_VERSION."
data: 2026-10-27
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "apps/extension/src/{consent,panel}/**, src/messaging/{protocol,worker-port,panel-hub}.ts, src/capture/capture-service.ts (refatoração), src/entrypoints/{background.ts,sidepanel/**}, eslint.config.js, vitest.config.ts, test/{consent-service,panel,messaging}.test.ts, test/fixtures/stream.ts, test/e2e/{panel,messaging}.e2e.test.ts, test/e2e/global-setup.ts"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-024-capture-in-service-worker](ADR-024-capture-in-service-worker.md)", "[ADR-012-report-composer](ADR-012-report-composer.md)", "[threat-model](../threat-model.md)", "[contratos-zod](../contratos-zod.md)", "*BACKLOG §F1-EXT-04*"]
---

# ADR-025: UI do Side Panel

## 1. Contexto

O [ADR-024-capture-in-service-worker](ADR-024-capture-in-service-worker.md) deixou o painel com o estado da captura e o "colar o texto". Faltavam, pelo ADR-001 §5.0:
- o passo 7: o aviso em destaque antes da 1ª transmissão (Limited Use da Chrome Web Store);
- o passo 6: renderizar os eventos `AnalysisStreamEvent` revalidados, como texto puro;
- o relatório (`AnalysisReport`), os erros acionáveis (`ApiError`) e o "Reanalisar com IA".

A parte 1 **não chama a API**: o envio entra na parte 2, com a autenticação (F1-EXT-05, S-3).

Fatos verificados na Fase 1 (2026-10-27):
- `packages/ui-kit` **não existe**;
- jsdom e testing-library **não estão** no catálogo do pnpm;
- o `wxt/browser` resolve para `globalThis.browser` quando ele tem `runtime.id`, e senão para `globalThis.chrome`.

## 2. Decisões

### D1. Escopo e local
- **A lógica do painel é pura** e fica em `src/panel/`:
  - `panel-state.ts`: redutor e `parseWorkerMessage`;
  - `texts.ts`: catálogos e formatação.
- Os `.tsx` de `src/entrypoints/sidepanel/` só ligam a porta e renderizam:
  - `App.tsx`;
  - `Analysis.tsx`: aviso, progresso, relatório, erro e botões.
- **Sem `@trampo/ui-kit` por enquanto:** os componentes ficam locais. O pacote nasce quando o portal (F1-PORTAL) precisar de componentes compartilhados, e o BACKLOG do F1-EXT-04 registra isso.

### D2. Consentimento (ADR-001 §5.0 passo 7)
- **Quem impõe é o Service Worker**, o único que falará com a API. O painel só mostra o aviso e pede.
- O `src/consent/consent-service.ts` guarda `{ versao, dadoEm }` em `storage.session`, na chave `trampo/consentimento/v1`.
- A porta ganhou três mensagens estritas:
  - `consentir`, com a versão do aviso;
  - `revogar`;
  - do Service Worker para o painel, `consentimento` com `dado: boolean`.
- **Versão do aviso (`CONSENT_VERSION = "aviso-1"`):**
  - a versão é literal no protocolo e no registro;
  - mudou o texto do aviso, muda a versão;
  - o registro antigo falha na revalidação do `sessionStore` e é apagado. Um `consentir` com outra versão derruba a porta.
- **Por que `storage.session`, sem consultar o humano:**
  - o aviso volta a cada sessão do navegador, que é o lado conservador da Limited Use;
  - o lint proíbe `storage.local` (T22);
  - persistir entre sessões fica para a Fase 2, de preferência com o registro do lado da API, por usuário.
- **O portão:** `isGranted()` é a porta do envio na parte 2. Sem consentimento vigente, nada sai. O teste da parte 2 precisa provar que o envio consulta o portão.
- **Ordem do handshake:** `ready`, depois `captura`, depois `consentimento`, em sequência no `onReady`.
- O hub de portas (`src/messaging/panel-hub.ts`) saiu do `capture-service` e agora é usado pelos dois serviços, sem mudar o comportamento: os 15 testes do `capture-service` passaram sem alteração.

### D3. Estado do painel
- O estado é `{ conexao, queda, captura, consentimento, analise }`.
- A `analise` pode ser:
  - `nenhuma`;
  - `andamento` (etapa e tempo);
  - `concluida` (relatório);
  - `erro` (`ApiError`).
- Regras:
  - **toda mensagem passa pelo `WorkerToPanelSchema`**. Mensagem fora do contrato vira `recusada`: o App derruba a porta, o estado vai para `desconectado` com `queda: resposta_invalida`, e a análise sai da tela;
  - **a queda é definitiva**: nada mais muda a tela até o painel ser reaberto;
  - uma captura nova tira da tela a análise da vaga anterior;
  - um evento `stage` depois de um resultado começa uma análise nova.
- O consentimento é `null` até o Service Worker informar. Nesse estado, nem o aviso nem o botão aparecem.

- **Emenda do 05b-2 (F1-EXT-05b, 2026-11-09; [ADR-004-extension-auth](ADR-004-extension-auth.md) D12, "Emenda do 05b-2"):**
  - o estado passa a ser `{ conexao, queda, captura, consentimento, sessao, entrandoDesde, pediuSair, analise }`. A `sessao` chegou no 05b-1 (null até o fim do handshake); `entrandoDesde` e `pediuSair` são estado local do painel e nunca vão ao Service Worker;
  - o redutor ganhou 4 ações do usuário e do relógio do App: `entrar { agora }`, `sair`, `tique { agora }` e `reconectar`. O clique que a tela não oferece é ignorado;
  - **exceção à queda definitiva:** com `queda: "porta_fechada"`, o "Reconectar" volta ao estado inicial, e o App abre uma porta nova com um `hello` novo (05b-3). Com `resposta_invalida`, a queda continua definitiva. Nenhuma mensagem nem tique reconecta: só o clique;
  - o "Analisar" ganhou o portão `analyzeBlock(api, { consentimento, sessao })`, que soma a sessão ao consentimento do D2. Até a parte 2, o `api` é `false`, e o texto continua o do D5.

### D4. Textos
- Cada enum do contrato tem um `Record` exaustivo em `texts.ts`, e um valor novo no contrato quebra a compilação. Os enums cobertos são:
  - `AnalysisStage`, `Verdict` e `ScoreDimension`;
  - `DimensionOutcome`, `AnalysisWarning` e `DecisionPath`;
  - `ApiErrorCode`.
- Um teste confere que as chaves são exatamente as opções do enum, e que nenhum texto do catálogo parece link ou tem `<`/`>`.
- **Estágios:** "Etapa N de 6: rótulo (x,y s)", com a lista marcando as etapas feita, atual e pendente.
- **`retryAfterSeconds`:** vira prazo legível, com segundos, minutos ou horas arredondados para cima, no singular e no plural.

- **Emenda do 05b-3 (F1-EXT-05b, 2026-11-09; [ADR-004-extension-auth](ADR-004-extension-auth.md) D12, "Emenda do 05b-3"):**
  - a queda da porta diz "A conexão com o Trampo caiu. Clique em Reconectar para continuar.", montado com o rótulo do botão (`SESSION_ACTION_LABELS.reconectar`), e não mais "Feche e abra o painel de novo.". A queda por resposta inválida mantém o texto e não cita o botão;
  - a área da sessão (`data-sessao`) mostra só o `describeSession`: a linha do estado e, se houver, o título e a ação do erro (`data-sessao-erro`). Nenhum texto novo entrou no catálogo: os do 05b-2 cobrem tudo.

### D5. Relatório, erros e nenhum link
- **O relatório mostra:**
  - a nota, o veredito, o eliminatório e o resumo;
  - os avisos, os pontos fortes, os de atenção e o que a vaga não informa;
  - a composição da nota (dimensão, resultado, pontos assinados e explicação);
  - o caminho da decisão e o código da análise.
- **Os `facts` não são exibidos** nesta parte: a composição já os explica. Exibi-los fica para depois, se a pesquisa com usuário pedir.
- **Os erros saem só do catálogo, pelo `code`.** O `message` do servidor não é exibido, mesmo validado como `safeText`: o servidor controla menos texto na tela. O `requestId` aparece como "Código do pedido", para o suporte.
- **Nenhum link, imposto por lint** (`noLinkSelectors` no `eslint.config.js` da extensão):
  - JSX com `a`, `area`, `base`, `link`, `iframe`, `frame`, `embed`, `object`, `img`, `image`, `video`, `audio`, `source`, `track` ou `portal` é proibido;
  - os atributos `href`, `src`, `srcSet`, `action`, `formAction`, `xlinkHref`, `poster`, `data`, `ping`, `background`, `cite` e `xlink:*` também.
- **Prova negativa do lint:** um arquivo de sonda com `<a href>`, `<img src>`, `<form action>`, `xlinkHref` e `dangerouslySetInnerHTML` teve 7 de 7 erros, e foi apagado. A regra pegou até uma prop `data` de um componente nosso, que foi renomeada para `lista`.
- **"Analisar vaga" e "Reanalisar com IA"** aparecem desabilitados, com o texto "A ligação com o servidor do Trampo ainda não está ativa nesta versão.". O "Analisar" só aparece com a captura pronta e o consentimento dado. Sem consentimento, no lugar dele aparece o aviso.
- O usuário pode **retirar o consentimento** pelo botão "Retirar o consentimento de envio".

- **Emenda do 05b-3 (F1-EXT-05b, 2026-11-09; [ADR-004-extension-auth](ADR-004-extension-auth.md) D12, "Emenda do 05b-3"):**
  - **botões da sessão, nunca links** (`src/entrypoints/sidepanel/Session.tsx`): só os que o `sessionActions` oferece. O `entrar` vira um botão por provedor da `AUTH_PROVIDERS` ("Entrar com GitHub" e "Entrar com Google"), e o "Sair da conta" e o "Tentar sair de novo" mandam o mesmo `sair`. O clique despacha a ação local (com a hora do relógio do App, no `entrar`) e posta a mensagem;
  - **"Reconectar"** no `App.tsx`, só com o `canReconnect`. Ele despacha a ação, e é o redutor que muda a geração da porta;
  - **"Analisar vaga" e "Reanalisar com IA"** passam pelo `analyzeBlock(API_DO_ENVIO, state)`: desabilitados com o motivo do `ANALYZE_BLOCKED_TEXTS` (`data-bloqueio`). O `API_DO_ENVIO` é a constante `false` do `App.tsx` até a F1-EXT-04 parte 2, e o texto continua o deste D5. O `SEM_API` saiu do `Analysis.tsx`;
  - os botões da sessão ficam lado a lado e quebram a linha a 320 px (`.acoes`, D7).

### D6. Testes
- **Unidade (Node, sem DOM):**
  - redutor, textos, consentimento, hub e protocolo;
  - 100% nas 4 métricas, com `src/consent/**` e `src/panel/**` incluídos na cobertura.
- **E2E (`test/e2e/panel.e2e.test.ts`) sobre o build de produção:**
  - **Porta falsa:** o `page.addInitScript` define `globalThis.browser` com uma porta que registra o que o painel envia e entrega eventos de fixture. É o React minificado de verdade renderizando. Os casos são:
    - o aviso aparece antes do envio, o aceite manda só a versão, e o "revogar" funciona;
    - sem captura pronta, nada aparece;
    - estágios;
    - relatório a 320 px, com texto de 140 caracteres sem espaço: sem rolagem horizontal, sem nenhum elemento ou atributo de link, e o "Reanalisar" desabilitado;
    - os 10 códigos de erro, com o texto do catálogo e sem o `message`;
    - **10 relatórios hostis** (HTML, URL, link markdown, domínio nu, e-mail, Unicode Tag, resumo longo, chave extra, URL no fato e nota fora da faixa): a porta cai, o canário não aparece, e nem um relatório válido depois disso é renderizado.
  - **Service Worker real:** o aceite fica só em `storage.session` (o `storage.local` continua vazio), vale para o painel reaberto, e "revogar" apaga.
- **Fixtures** em `test/fixtures/stream.ts`. Um teste de unidade confere que o relatório válido passa no contrato e que cada hostil é recusado.
- **Emenda do 05b-3 (F1-EXT-05b, 2026-11-09):** a porta falsa aceita várias conexões (cada `runtime.connect` abre uma porta, com o nome, o que o painel enviou e quantas vezes ele a derrubou) e a queda pelo lado do Service Worker (`fall`). Os casos novos: o texto de cada uma das 8 `SessaoView` e só os botões oferecidos; "Entrar" com cada provedor; "Sair", a falha remota e o "Tentar sair de novo" a 320 px; a mesma falha sem o clique; o "entrando" com o relógio falso do Playwright (`page.clock`); o "Reconectar" com a porta antiga ignorada; e o "Analisar" pelo portão. Com o Service Worker real: o "Entrar" no build sem origens, e o SW parado por `Target.closeTarget` com o "Reconectar" refazendo o handshake. Os relatórios hostis passaram a exigir também nenhum botão e nenhuma porta nova.
- **Achado no harness do E2E:** o vitest define `NODE_ENV=test`, e o Vite respeita um `NODE_ENV` já definido. O build "de produção" do E2E saía com o **React de desenvolvimento**: chunk acima de 500 kB, e o `StrictMode` rodava os efeitos duas vezes, abrindo duas portas. O `global-setup` agora força `NODE_ENV=production` durante o build e restaura o valor depois. O Service Worker já saía minificado (ADR-024 D7 continua válido), mas o React do painel não era o da loja.

### D7. Estilo
- `style.css` importado no `main.tsx` e servido como arquivo próprio, porque a CSP `default-src 'self'` barra `<style>` inline.
- `overflow-wrap: anywhere` no `main` e tema escuro por `prefers-color-scheme`.
- A CSP e o manifesto não mudaram.

## 3. Auditoria do `[APPSEC]` (sem veto)

Critérios de aceite:
1. Nenhum `fetch` novo e nenhuma origem nova. A CSP de produção continua `connect-src 'none'` sem `TRAMPO_API_ORIGIN`, e o manifesto não mudou.
2. O consentimento é imposto no Service Worker, versionado, estrito na porta, só em `storage.session`, e pode ser revogado.
3. Tudo o que chega ao painel é revalidado com o contrato público. Um relatório hostil derruba a porta, sem render parcial.
4. Zero `innerHTML`, zero link e zero recurso externo no painel, com lint provado por sonda negativa e E2E que varre o DOM.
5. Os erros não exibem texto do servidor, só o catálogo.
6. O texto da vaga continua sem chegar ao painel (ADR-024 D4). Nenhuma mensagem nova leva o texto.
7. Nenhuma versão de prompt, guard ou extrator mudou, e nada chamou o Groq.

Riscos residuais (aceitos):
- **O aviso não nomeia o provedor de IA** (hoje Groq, com a Cloudflare de reserva). Ele diz "um provedor de inteligência artificial". A política de privacidade da loja (S-5) precisa nomear os provedores. Se o aviso passar a nomeá-los, a versão muda.
- **O consentimento por sessão do navegador** pode cansar o usuário. A persistência por usuário fica do lado da API, na Fase 2.
- **A porta falsa do E2E** prova a renderização, não o caminho de rede. O SSE real entra na parte 2, com o servidor local do E2E de CSP.

## 4. Consequências
- **F1-EXT-04 parte 2** (depois da Trilha A e do S-3/F1-EXT-05):
  - o Service Worker monta o `AnalyzeJobRequest` a partir da `vaga` do `storage.session`, com `requestId = crypto.randomUUID()`, **só se `consent.isGranted()`**;
  - consome o SSE, revalida cada evento com o `AnalysisStreamEventSchema` e os repassa como `{ kind: "stream" }`;
  - a porta ganha `analisar` (com o `mode`), e os botões são habilitados.
- O [contratos-zod](../contratos-zod.md) não muda: o protocolo da porta é privado da extensão.

## 5. Implementação (2026-10-27, Trilha G)
- **Provas:**
  - unidade: 140 testes (eram 110), com 100% nas 4 métricas e 10 arquivos cobertos;
  - E2E: 32/32 em 3 rodadas (CSP 5, mensageria 5, captura 6, painel 16), todas sobre o build de produção com o React de produção;
  - mutação (script no scratchpad): 43 mutantes em `panel-state`, `texts`, `consent-service`, `panel-hub`, `worker-port` e `protocol`, com 42 mortos. O sobrevivente é **equivalente**: trocar `parsed.success ? parsed.data : null` por `parsed.data ?? null` dá o mesmo resultado, porque no Zod 4 o `safeParse` com falha devolve `data` indefinido. Os arquivos foram restaurados com o hash idêntico;
  - `test:browser`: 52/52 (o extrator não mudou);
  - depcruise sem violações (414 módulos); lint, typecheck e `wxt build` verdes, com o manifesto de 557 B, sem mudança.

## 6. Parte 2: envio à API (F1-EXT-04 parte 2, desenho de 2026-11-11, sessão 22)

`[ARCHITECT]` + `[APPSEC]`, antes do código. Base: o §4 deste ADR, o [ADR-004-extension-auth](ADR-004-extension-auth.md) D10 (B6 e B9), D11.1, D11.4 ("Emenda da F1-EXT-07") e D12, e o [ADR-017-analyze-job-and-stream](ADR-017-analyze-job-and-stream.md) D6 (formato do SSE). Nenhum contrato público muda (`AnalyzeJobRequestSchema` e `AnalysisStreamEventSchema` ficam como estão), nem o manifesto, a CSP, o extrator, o `EXTRACTION_PROMPT_VERSION` ou o `LLM_OUTPUT_GUARD_VERSION`.

### 6.1 Partição (AGENTS §4.1, uma por sessão)
- **04b-1, Service Worker:** o leitor do SSE (`src/api/sse-reader.ts`), o `api-client.analyze` (prazos e tetos do stream), o `analysis-service` (`src/api/analysis-service.ts`: portões, pedido, 401 e repasse), a mensagem `analisar` na porta, o `onChange` da captura e a ligação no `background.ts`. Unidade com 100% e mutação dirigida. O painel ainda não posta `analisar` (o `API_DO_ENVIO` segue `false`).
- **04b-2, painel:** a fonte do `API_DO_ENVIO` (D14), os botões habilitados que postam `analisar` com o `mode`, o estado local "enviando" e o E2E do painel com a porta falsa.
- **04b-3, E2E com a API falsa:** `POST /v1/analyze` em SSE no `fake-servers.ts`, os cenários 3, 4, 5 e 12 do [ADR-004-extension-auth](ADR-004-extension-auth.md) §4.4 e a entrada deles na sequência do `auth-negative.e2e.test.ts`, antes das provas (TRILHAS, cuidado 24).

### D8. Leitor do SSE (`src/api/sse-reader.ts`, puro)
- O servidor tem um formato só (ADR-017 D6): `event: <type>\ndata: <json>\n\n`, um `data:` por evento, sem `id:`, sem `retry:` e sem comentário. O leitor aceita **só** essa forma. Qualquer outra linha (comentário `:`, `id:`, `retry:`, segundo `data:`, `data:` sem `event:`, `\r`, campo desconhecido, linha em branco solta) é **violação**, e o stream inteiro é descartado. Afrouxar (um proxy da borda que injete comentário de *keep-alive*, a conferir no S-5) pede emenda a este D8.
- Cada `data:` passa pelo `JSON.parse` e pelo `AnalysisStreamEventSchema`, e o nome do `event:` tem de ser igual ao `type` do JSON. Falhou, violação.
- O `stage` é entregue na hora. O **terminal** (`result` ou `error`) fica guardado e só sai no fim do stream, se ele for o último evento e nada vier depois (nem um byte). Assim, "exatamente um terminal no fim" (ADR-017 D6) vale no cliente também, e um relatório seguido de lixo nunca chega ao painel.
- Teto de linha: uma linha acima do teto do stream já cai pelo teto do `api-client` (D9); o leitor não guarda mais que o buffer da linha corrente.
- Fim do stream: com o terminal guardado, `completo` (o terminal sai); sem terminal, inclusive com o corte no meio de um evento, `incompleto` (o corte é tratado como rede). Qualquer byte depois do terminal é violação: a linha completa cai na checagem da linha, e o resto sem fim de linha, na checagem do fim do pedaço.

### D9. `api-client.analyze` (o único `fetch` continua no `api-client`, B9)
- Método novo `analyze(call, onText)`, só para o `POST /v1/analyze`. Usa a mesma preparação do `post` (lista fechada, Bearer pelo `AccessTokenSchema`, corpo validado pelo `AnalyzeJobRequestSchema` e enviado como a string validada) e as mesmas opções do B9 (`credentials: "omit"`, `redirect: "error"`, `cache: "no-store"`, `referrerPolicy: "no-referrer"`). Nenhum cabeçalho novo: só `content-type` e `authorization`. O `post` mantém a rota (a prova do Bearer do M-07), mas o `analysis-service` só usa o `analyze`.
- **Prazos** (o ponto aberto do 05a-2): até o status, **10 s** (o do B9; o Chrome encerra o SW se a resposta do `fetch` passar de 30 s); entre dois pedaços do corpo, **20 s** (o router tem 12 s e o cache tem tetos próprios; o pior caso de silêncio do servidor é a extração, ~12,5 s, ADR-017 D2); total, **45 s**. Qualquer prazo vencido aborta o `fetch`.
- **Tetos:** **64 KiB** no stream 200 (o pior relatório legítimo cabe com folga) e **16 KiB** no corpo de erro (o `ApiError` é pequeno). O corpo é decodificado em UTF-8 estrito (`fatal`).
- **200 só com `content-type` `text/event-stream`** (parâmetros ignorados, comparação sem caixa). 200 com outro tipo é `resposta_ilegivel`, sem ler o corpo.
- **Resultado (nunca rejeita):**
  - `pedido_recusado` (nada saiu) e `sem_resposta` (rede, redirecionamento ou prazo antes do status), como no `post`;
  - outro status: `{ ok: true, status, body }`, com o corpo inteiro até 16 KiB, ou `resposta_ilegivel`;
  - 200: cada pedaço decodificado vai ao `onText`, que responde `seguir` ou `parar`. O fim é `completo` (o servidor fechou), `parado` (o leitor pediu), `queda` (rede ou prazo depois do status) ou `ilegivel` (teto ou UTF-8). Todo fim que não é `completo` aborta o `fetch`, e o `finally` sempre limpa o relógio e aborta.

### D10. `analysis-service` (`src/api/analysis-service.ts`)
- **`analyze(mode)` nunca rejeita**, uma análise por vez: um `analisar` com outra em curso é ignorado (log `analise_em_curso`).
- **Portões, nesta ordem e antes de qualquer rede:**
  1. `api` ausente (build sem as duas origens): nada sai (log `analise_sem_api`), e o painel recebe `ERRO_INTERNO`;
  2. `consent.isGranted()` falso: nada sai (log `analise_sem_consentimento`), e o painel recebe `ERRO_INTERNO`. Nem o `accessToken()` é chamado, porque ele pode renovar pela rede;
  3. captura que não está `pronto`: nada sai (log `analise_sem_vaga`), e o painel recebe `ERRO_INTERNO`;
  4. `accessToken()` sem token: nada sai (log `analise_sem_token`), e o painel recebe `SERVICO_INDISPONIVEL`. Não é `NAO_AUTENTICADO`: o `undefined` também cobre a renovação transitória com o token vencido, e a ambiguidade nunca empurra para um novo login (T30). A visão da sessão já chega ao painel pelo canal dela.
  Nos 4, o erro sai com `requestId: null` (nada saiu). Os 3 primeiros só acontecem numa corrida, porque o painel não oferece o botão nesses estados (o `analyzeBlock`): o SW é a trava, não a interface.
- **Todo `analisar` aceito termina com exatamente um terminal no painel** (`result` ou `error`), para o "enviando" do 04b-2 nunca ficar preso. As exceções são o `analisar` ignorado por outro em curso (o em curso termina com o dele) e a análise cancelada pela captura (o `captura` que limpa a tela vem logo depois).
- **Pedido:** `requestId = crypto.randomUUID()` (injetado), `source: { platform, extractorVersion }` da vaga guardada (a base do monitoramento dos seletores, spike-metrics §3.4 e §3.5), `job: { titleHint: null, text, clientTruncated: truncated }` e o `mode` do painel. Sem URL da página e sem dado de perfil (o contrato já proíbe). O título fica `null` até o extrator devolver um (fora desta trilha).
- **401 (D11.4 do ADR-004, "Emenda da F1-EXT-07"):** só o 401 com o `ApiError` `NAO_AUTENTICADO` conta (o mesmo critério do `auth-service`; 401 sem esse corpo é `SERVICO_INDISPONIVEL`). O serviço guarda o token que mandou e chama `onUnauthorized(1, usado)`. Com token novo, **confere o consentimento e a captura de novo** (o reenvio é uma nova transmissão) e reenvia o **mesmo pedido**, com o mesmo `requestId` (idempotente pela cota, ADR-014 D5). Sem token, o painel recebe `NAO_AUTENTICADO`. O 2º 401 chama `onUnauthorized(2, usado2)` (a sessão é apagada pelo `auth-service`, se o token for o dela) e o painel recebe `NAO_AUTENTICADO`. Não há 3º envio: o tipo `1 | 2` impede o laço.
- **Outros status antes do stream:** o corpo que passa no `ApiErrorSchema`, com `requestId` nulo ou igual ao do pedido, vai ao painel como veio (o painel mostra só o catálogo pelo `code`). Fora disso, o erro é sintetizado pelo status: 429 `LIMITE_DE_TAXA`, 5xx `SERVICO_INDISPONIVEL`, o resto `ERRO_INTERNO`.
- **Stream:** cada `stage` vai ao painel na hora, e o terminal no fim (D8). `incompleto` e `queda` viram `SERVICO_INDISPONIVEL`; violação do leitor e `ilegivel` viram `ERRO_INTERNO` (o `onText` responde `parar`, e o `fetch` cai). `pedido_recusado` vira `ERRO_INTERNO`; `sem_resposta`, `SERVICO_INDISPONIVEL`.
- **Repasse:** tudo sai às portas confiáveis como `{ kind: "stream", event }`, pelo `PanelHub` próprio do serviço, e cada evento sintetizado passa pelo `AnalysisStreamEventSchema` antes de sair. O `attach(port)` só põe a porta no hub: **o handshake não muda** (`[ready, captura, consentimento, sessao]`). Um painel aberto no meio da análise vê só os eventos seguintes (residual aceito: a análise segue e o resultado chega a ele).
- **Captura que muda no meio** (outro clique, texto colado, aba fechada): o `capture-service` ganha o `onChange`, chamado **antes** de gravar o estado novo, e o `background.ts` o liga ao `analysis.cancel()`. O cancelamento soma a geração: nada mais da análise antiga chega ao painel (o `onText` responde `parar`), e um `analisar` novo já pode começar. Como o `onChange` vem antes da gravação e do `captura` que limpa a tela, nenhum evento velho chega depois dele.
- **Log:** só motivos da lista fechada `ANALYSIS_LOG_REASONS` (`analise_sem_api`, `analise_sem_consentimento`, `analise_sem_vaga`, `analise_sem_token`, `analise_em_curso`, `analise_recusada`, `analise_indisponivel`, `analise_violacao`, `analise_erro_servidor` e `analise_falha_interna`), nunca texto da vaga, token, `requestId`, status ou corpo (T23).

### D11. Erro sintetizado no SW
- O SW monta o `ApiError` com o `code` do D10, `message` fixa por código (texto curto do catálogo do SW, que passa no `safeText(200)`; o painel não o mostra, D5), `requestId` do pedido (ou `null` se nada saiu) e `retryAfterSeconds: null`. Nenhum texto do servidor, da rede ou do navegador entra nele.

### D12. Mensagem `analisar`
- `z.strictObject({ kind: z.literal("analisar"), mode: z.enum(["auto", "aprofundada"]) })` no `PanelToWorkerSchema`, com o `mode` tirado do `AnalyzeJobRequestSchema.shape.mode` (o painel não manda texto, `requestId`, plataforma nem token: tudo isso é do SW). Chave extra derruba a porta (SR-10). O `worker-port` ganha o `onAnalyze(mode)`.

### D13. `api` da composição
- O `createWorkerAuth` passa a devolver também o `api` (o mesmo `ApiClient` da sessão, ou `undefined` sem as duas origens). O `analysis-service` usa esse cliente e o `accessToken`/`onUnauthorized` do mesmo serviço. O `src/api` importa `src/consent`, `src/capture` e `src/messaging` (permitido pelo depcruise; o inverso continua proibido).

### D14. Fonte do `API_DO_ENVIO` (B6; a implementar no 04b-2)
- O `ready` ganha `envio: boolean` (`z.boolean()`, estrito): `true` só quando a composição tem o `api` (D13). É um booleano, sem texto livre (B6), e diz só o que o manifesto já mostra (o `connect-src` com a origem). O painel guarda o valor no `PanelState` e o passa ao `analyzeBlock` no lugar da constante. Alternativas recusadas: uma mensagem nova no handshake (muda a ordem fixada no E2E) e o painel ler o build (o `import.meta.env` fica só no `background.ts`).

### `[APPSEC]` sobre o desenho (sem veto)
Condições: (1) o teste prova que o portão do consentimento vem antes do `accessToken()` e de qualquer rede, e que o reenvio do 401 confere o consentimento de novo; (2) o `onUnauthorized` recebe sempre o token capturado no envio, nunca um lido depois; (3) o leitor do SSE é estrito e nunca entrega um terminal que não seja o último; (4) nenhum texto do servidor fora do `ApiError` validado chega ao painel, e o erro sintetizado só tem texto do catálogo do SW; (5) o log da análise só leva motivos da lista fechada; (6) nenhum cabeçalho novo sai do `api-client`; (7) a captura que muda cancela o repasse antes de o painel limpar a tela.

### 6.2 Implementação do 04b-1 (2026-11-12, sessão 22)
- **Código:** `src/api/sse-reader.ts` (novo), `src/api/analysis-service.ts` (novo), `src/api/api-client.ts` (`analyze` e `ANALYZE_STREAM_POLICY`; o `post` não mudou), `src/messaging/protocol.ts` (`AnalysisModeSchema` e `analisar`), `src/messaging/worker-port.ts` (`onAnalyze`), `src/capture/capture-service.ts` (`onChange` e `readyJob`), `src/auth/worker-auth.ts` (`api`), `src/auth/auth-service.ts` (só tipo) e `src/entrypoints/background.ts`.
- **Decisões de implementação, sem mudar o desenho:**
  - o `AuthConfig.api` do `auth-service` passou a ser `Pick<ApiClient, "post">`: o serviço da sessão não enxerga o `analyze` (menor capacidade). Mudança só de tipo; o `authConfigFrom` devolve o cliente inteiro para a composição;
  - o `NAO_AUTENTICADO` só leva à renovação com o status 401. O mesmo código com outro status vai ao painel como veio, sem renovar;
  - o `ApiError` do servidor (antes do stream ou como terminal) só vale com `requestId` nulo ou igual ao do pedido; outro `requestId` é tratado como corpo fora do contrato;
  - `pedido_recusado` (o `api-client` recusou o corpo ou o token) vira `ERRO_INTERNO`, com o log `analise_violacao`;
  - o consentimento é conferido no portão (antes do `accessToken`) e de novo imediatamente antes de cada transmissão; a geração, depois de cada espera (o consentimento, o envio e a renovação);
  - o `readyJob(store)` do `capture-service` é a única leitura da vaga para o envio, e o `background.ts` usa o mesmo `sessionStore` da captura;
  - `analise_falha_interna` cobre a dependência que lança (o `storage`, por exemplo): o painel recebe `ERRO_INTERNO`, e a análise seguinte roda.
- **Provas:** testes antes do código em cada passo (o leitor, o `analyze`, o serviço e a ligação). Extensão com 1.996 testes e 100% nas 4 métricas; typecheck, lint e depcruise (534 módulos) verdes; E2E 100/100 no Edge headless (o handshake e as provas negativas não mudaram); turbo `build typecheck lint test` 21/21 em série, sem cache.
- **Mutação, em primeiro plano, com sha256 conferido:** `mut04b1.py` (scratchpad da sessão 22) 65/65: S-01 a S-13 no leitor, A-01 a A-17 no `analyze`, N-01 a N-30 no serviço, C-01 a C-03 na captura, W-01, P-01, K-01 e K-02. Na 1ª rodada, 11 sobreviveram: 8 eram buracos de teste (o `data:` com `\r` que o `JSON.parse` aceita, outro campo de 6 caracteres com JSON válido, o terminal e outro evento no mesmo pedaço, o pedaço que decodifica para vazio, o `requestId` novo no reenvio, o `NAO_AUTENTICADO` com outro status, e o cancelamento durante a leitura da vaga e durante o envio que volta 401) e viraram testes; 3 eram travas redundantes (a checagem do terminal no começo do `push` e a 1ª checagem da geração no `transmit`) e saíram do código. Os scripts antigos dos arquivos tocados: `mut05a2.py` (cópia com 4 âncoras estendidas, porque o `analyze` repete trechos do `post`, e o A10 no `streamMaxBytes`) com todos os mutantes do `api-client` e do `session-schema` mortos (o lote L- parou numa âncora do `eslint.config.js` que já tinha mudado antes, arquivo fora desta tarefa); `mut05a4.py` W- 7/7 aplicáveis (o W-05 virou o K-02); `mut05b1.py` S-, P-, WP- e WA- 22/22; `mut05a3.py` 57/57. O `mut_ext07.py` não tem âncora no trecho alterado do `auth-service` (só tipo).
- **`[APPSEC]`:** as 7 condições do desenho cumpridas, cada uma com teste: (1) a ordem consentimento, vaga, token, consentimento e envio, e o reenvio que confere o consentimento; (2) o `onUnauthorized(1, token do envio)` e o `onUnauthorized(2, token do reenvio)`, com o `accessToken()` chamado uma vez só; (3) a violação em cada forma fora do servidor e o terminal que só sai no fim; (4) o corpo do servidor fora do `ApiError` nunca chega ao painel, e o erro sintetizado só tem o texto do `LOCAL_ERROR_MESSAGES`; (5) o log só com a lista fechada; (6) os cabeçalhos exatos (`content-type` e `authorization`); (7) o `onChange` antes de gravar, em cada caminho da captura. Sem veto.
- **Residuais aceitos:** um painel aberto no meio de uma análise vê só os eventos seguintes; o `titleHint` vai `null` até o extrator devolver um título; o leitor estrito recusa um comentário de *keep-alive* que um proxy da borda injete (a conferir no S-5, com emenda ao D8 se preciso).

### 6.3 Cancelamento imediato (04b-1b, desenho de 2026-11-12, sessão 23)

`[ARCHITECT]` + `[APPSEC]`, antes do código. **O problema:** o `cancel()` do `analysis-service` só para o `fetch` no próximo pedaço do corpo (o `onText` responde `parar`). Com o servidor em silêncio, o `fetch` cancelado fica vivo até o prazo de inatividade (20 s) e segura a vaga da análise na API.

#### D15. `api-client.analyze(call, onText, signal?)`
- O 3º parâmetro é um `AbortSignal` opcional de quem chama. O `fetch` continua recebendo só o sinal do controlador interno: o abort de quem chama e os 3 relógios (status, inatividade e total) caem no mesmo `controller.abort()`.
- **O abort de quem chama é um fim próprio:** `{ ok: false, reason: "cancelado" }`. Não é o `parado`: o `parado` só existe dentro do stream 200 e diz "o leitor pediu"; o abort pode vir antes do status (não há stream) e durante o corpo de erro. Um motivo só cobre as 3 fases, e quem chama separa o cancelamento da falha de rede (nunca reenvia, nunca registra como indisponível).
- **Depois do abort, o resultado é sempre `cancelado`**, mesmo que a resposta ou o último pedaço já tivesse chegado, e o `onText` não é mais chamado (o pedaço lido antes do abort e entregue depois é descartado no `api-client`, sem depender de quem chama).
- **Sinal já abortado na chamada:** nada sai (nem o `fetch`), e o resultado é `cancelado`. O pedido fora do contrato continua `pedido_recusado` (conferido antes; nada sai nos dois casos).
- **Nunca rejeita e nunca deixa relógio vivo:** o `finally` de hoje limpa os dois relógios e aborta; ele passa a tirar também o ouvinte do sinal de quem chama. O teste prova `vi.getTimerCount() === 0` depois do abort em cada fase (antes da chamada, antes do status, durante o stream e durante o corpo de erro).
- Nenhum cabeçalho, opção do `fetch`, prazo ou teto muda. O `post` não muda.

#### D16. `analysis-service.cancel()`
- Cada `analisar` aceito cria um `AbortController`, o mesmo para o envio e para o reenvio do 401. O `cancel()` soma a geração, libera o `running` e **aborta na hora**. O resultado observável não muda: nada chega ao painel, o `analyze` nunca rejeita, e uma análise nova já pode começar.
- O `cancelado` que voltar com a geração ainda vigente (não acontece sem o `cancel()`) é tratado como `pedido_recusado`: `ERRO_INTERNO`, log `analise_violacao`. Nenhum motivo novo de log.
- A renovação do 401 (`onUnauthorized`) não é abortada: ela é da sessão (single-flight, D11.3 do ADR-004) e serve às outras chamadas. A geração conferida depois dela já impede o reenvio.

#### D17. Análise em curso no "Retirar o consentimento" e no "Sair"
- **O revoke cancela.** A retirada do consentimento vale na hora (Limited Use; LGPD, art. 8º §5º): o `fetch` em voo é abortado, nada mais é repassado ao painel, e o reenvio do 401 já não sairia (o D10 confere o consentimento antes de cada transmissão). O texto que já saiu não volta: residual declarado.
  - **Ligação pelo `consent-service`, nunca pela cola do `background.ts`:** o serviço ganha a dependência opcional `onRevoke`, chamada no `revoke()` **antes** de apagar o registro e de avisar o painel (o molde do `onChange` da captura). O `background.ts` só passa `() => analysis.cancel()`. Assim, nenhum evento da análise chega depois do `consentimento { dado: false }`, e nenhum pedaço é repassado enquanto o `storage` apaga.
  - Se o `storage` falhar depois do cancelamento, a análise fica cancelada e o registro continua (fecha do lado da intenção do usuário); o teto do "enviando" (04b-2) devolve o botão.
  - **No painel (04b-2):** o `consentimento { dado: false }` desliga o "enviando" e tira da tela a análise `andamento`. O relatório já concluído fica.
- **O "Sair" não cancela.**
  - O pedido saiu com o token válido de quem pediu, e o resultado é dele. O painel já mantém na tela o relatório concluído depois do "Sair" (D3): cancelar só o que está em voo não protegeria nada a mais.
  - **Não há reenvio depois do "Sair":** no 401, o `onUnauthorized(1, token do envio)` recusa o token que não é o da sessão gravada (F1-EXT-07), e o painel recebe `NAO_AUTENTICADO`. Ele não renova nem apaga a sessão de outra pessoa que tenha entrado no meio.
  - Cancelar pelo "Sair" pediria um gancho novo no `auth-service` (superfície do T30), sem ganho.
  - **Residual aceito:** num perfil de navegador dividido, o resultado da análise pedida antes do "Sair" pode aparecer até 45 s depois dele, na mesma tela em que o relatório anterior continua. Limpar a tela no "Sair" fica para a Fase 2, se a pesquisa com usuário pedir.

#### `[APPSEC]` sobre o desenho (sem veto)
Condições: (1) o abort de quem chama nunca deixa relógio nem ouvinte vivo, com prova em cada fase; (2) depois do abort, o `onText` não é chamado e nada chega ao painel; (3) o `onRevoke` vem antes de apagar o registro e de avisar o painel, e é chamado pelo `consent-service`; (4) o `cancelado` nunca vira nova tentativa nem `SERVICO_INDISPONIVEL`; (5) nenhum cabeçalho, prazo ou teto muda.

#### Implementação do 04b-1b (2026-11-12, sessão 23, commit `b3badb0`)
- **Código:** `src/api/api-client.ts` (o `signal`, o `cancelado` e a guarda do `pumpStream`), `src/api/analysis-service.ts` (um `AbortController` por análise aceita, abortado no `cancel()`), `src/consent/consent-service.ts` (`onRevoke`) e `src/entrypoints/background.ts` (só passa `() => analysis.cancel()`).
- **Decisões de implementação:** o `analyze` decide o `cancelado` num ponto só, no fim (o abort vence qualquer resultado), mais duas guardas que evitam trabalho depois do abort: a resposta que chega depois dele não é lida, e o pedaço lido antes e entregue depois não vai ao `onText`. O controlador da análise não é limpo no fim: abortar um controlador de uma análise terminada não faz nada.
- **Provas:** 21 testes antes do código (14 falharam pelo motivo certo): o abort em cada fase com `vi.getTimerCount() === 0`, o ouvinte tirado do sinal, o `fetch` que só conhece o sinal interno, o sinal igual no envio e no reenvio, um sinal novo por análise, e o `onRevoke` antes do `remove` e do aviso. Extensão com 2.017 testes e 100%; E2E 100/100 no Edge.
- **Mutação, em primeiro plano, com sha256 conferido:** `mut04b1b.py` (scratchpad da sessão 23) 21/21: B-01 a B-11 no `analyze`, V-01 a V-06 no serviço e R-01 a R-04 no consentimento. `mut04b1.py` (cópia na sessão 23, com as âncoras A-02, A-03, N-05 e N-06 atualizadas) 65/65. `mut05a2.py` (cópia da sessão 22): os 49 do `api-client` e do `session-schema` mortos.
- **`[APPSEC]`:** as 5 condições cumpridas, cada uma com teste. A ligação do `onRevoke` no `background.ts` é provada pelo E2E do 04b-3 (o revoke com o stream em silêncio fecha a conexão no BFF falso). Sem veto.

### 6.4 Painel (04b-2, emenda de 2026-11-12, sessão 23)

`[ARCHITECT]` + `[APPSEC]`, antes do código. Detalha o D12 e o D14.

#### D18. `ready.envio` (a fonte do `API_DO_ENVIO`, D14)
- `z.strictObject({ kind: "ready", protocolVersion, envio: z.boolean() })`. O `PortContext` do `worker-port` ganha `envio: boolean`, e o `background.ts` passa `auth.api !== undefined`: `true` só quando a composição tem o `api` (D13). O handshake continua `[ready, captura, consentimento, sessao]`; só a forma do `ready` muda.
- Um `ready` sem o campo, com outro tipo ou com chave extra derruba a porta (o `WorkerToPanelSchema` é estrito, D3).
- `PanelState.api` (`false` no estado inicial): preenchido pelo `ready` e zerado no "Reconectar", que volta ao estado inicial. A constante `API_DO_ENVIO` sai do `App.tsx`, e o `analyzeBlock(state.api, state)` mantém a assinatura.

#### D19. O que a área da análise oferece (`analysisControl`, puro)
- Uma função só decide o controle, e o redutor usa a mesma função para aceitar o clique:
  - **nada:** sem conexão pronta, sem captura `pronto`, com o consentimento ainda desconhecido, com um envio em curso ou com a análise em `andamento`;
  - **aviso:** consentimento `false`. O aviso passa a aparecer também ao lado do relatório e do erro (antes, só sem análise): com os botões ativos, quem retira o consentimento precisa de um caminho para aceitar de novo sem ler outra vaga;
  - **botão:** `{ mode, bloqueio }`. O `mode` é `aprofundada` ("Reanalisar com IA") com um relatório na tela e `auto` ("Analisar vaga") nos outros casos, inclusive depois de um erro (o erro passa a ter o botão ao lado, para tentar de novo). O `bloqueio` é o do `analyzeBlock`, e o botão bloqueado fica desabilitado com o motivo, como hoje.
- **Clique:** o App despacha `{ type: "analisar", mode, agora }` e posta `{ kind: "analisar", mode }`, nada mais (D12). O redutor ignora o clique que a tela não oferece: outro `mode`, botão bloqueado ou envio em curso.

#### D20. "Enviando" (estado local, nunca vai ao SW)
- `PanelState.enviandoDesde`: a hora do clique aceito, no relógio do App. O clique aceito também tira da tela a análise anterior (relatório ou erro), como o `stage` depois de um resultado já fazia.
- **Desliga:** no próximo terminal do stream (`result` ou `error`); num `captura`; num `consentimento { dado: false }` (D17), que também tira da tela a análise `andamento`; numa `sessao` sem sessão; num `ready` sem envio; na queda da porta (as duas); e no "Reconectar". Um `stage` não desliga: troca o texto pelo progresso.
- **Invariante de estado:** `enviandoDesde !== null` implica conexão pronta, `api`, consentimento `true`, sessão autenticada e captura `pronto`; e só o clique aceito o liga. O teste de invariante (a busca em largura do `panel-session.test.ts`) prova as duas coisas com as ações novas.
  - A `sessao` sem sessão desliga o "enviando" mesmo sem o "Sair" cancelar a análise (D17): o botão volta bloqueado por `sem_sessao`, e o terminal que ainda chegar aparece.
- **Teto:** `ENVIANDO_TETO_MS = 55_000`, o `ANALYZE_STREAM_POLICY.totalMs` + 10 s, preso por teste (o painel nunca importa `src/api`). No teto, ou com o relógio que volta, o "enviando" desliga e a análise vira o erro local `SERVICO_INDISPONIVEL` (texto do catálogo pelo `code`, sem `requestId`), com o botão de volta.
  - **Residual aceito:** o SW pode passar dos 55 s (a renovação antes do envio, ou o 401 com reenvio). O terminal que chegar depois do teto ainda vale e troca o erro local pelo resultado. Se o usuário clicar antes disso, o SW ignora o `analisar` com outro em curso, e o terminal da análise em curso desliga o "enviando" novo.
- **Tique:** o mesmo intervalo de 1 s do "entrando" (`ENTRANDO_TIQUE_MS`), armado enquanto um dos dois estiver ligado. A ação `tique` confere os dois tetos e nunca posta nada ao SW.

#### D21. Textos
- `SENDING_TEXT` ("Enviando a vaga ao Trampo…"), antes do 1º `stage`, e `ANALYZE_LABELS`, um rótulo por `AnalysisMode` (exaustivo). Os dois entram no teste de "nenhum link, nenhum `<` ou `>`". Os erros seguem saindo só pelo `code` (D5): nem o `message` do servidor, nem o do SW, nem o do erro local do teto aparecem.

#### `[APPSEC]` sobre o desenho (sem veto)
Condições: (1) o `ready` continua estrito, e o `envio` é só booleano (B6); (2) o painel posta exatamente `{ kind: "analisar", mode }`, sem texto, `requestId` nem token; (3) o clique que a tela não oferece não liga o "enviando" (invariante); (4) nenhum relógio do painel posta ao SW; (5) os 10 relatórios hostis seguem derrubando a porta com os botões ativos, sem render e sem postagem depois; (6) nenhum texto novo com link, conta ou provedor.

#### Implementação do 04b-2 (2026-11-12, sessão 23, commit `14fb7d4`)
- **Código:** `src/messaging/protocol.ts` (`ready.envio`), `src/messaging/worker-port.ts` (`PortContext.envio`), `src/entrypoints/background.ts` (`envio: auth.api !== undefined`), `src/panel/panel-state.ts` (`api`, `enviandoDesde`, `analysisControl`, a ação `analisar`, o tique dos dois tetos, `ENVIANDO_TETO_MS` e `SENDING_TIMEOUT_ERROR`), `src/panel/texts.ts` (`ANALYZE_LABELS` e `SENDING_TEXT`), `App.tsx` (a constante `API_DO_ENVIO` saiu; o clique despacha e posta; um intervalo só para os dois relógios) e `Analysis.tsx` (`onClick` no botão e o `Sending`).
- **Decisões de implementação:** o redutor aceita o clique pela mesma `analysisControl` que a tela usa; o teto do "entrando" e o do "enviando" usam a mesma função de prazo, com o teto por parâmetro; o `SENDING_TIMEOUT_ERROR` é congelado e passa no `ApiErrorSchema`.
- **Provas:**
  - unidade: `test/panel-sending.test.ts` (novo, 46 casos) e o teste de invariante ampliado: a busca em largura ganhou os dois modos do clique, o `ready` sem envio, as capturas, os dois consentimentos, o `stage`, o resultado, o erro e o tique do teto do envio. Ela prova que o "enviando" só vale com conexão, API, consentimento, sessão e vaga pronta, e que só o clique oferecido o liga. A fila da busca passou a ser lida por índice (tirar do começo custava a fila inteira a cada estado);
  - E2E do painel (Edge, build de produção, porta falsa), 21 casos novos: o clique que posta exatamente `{ kind: "analisar", mode }`; o "Reanalisar" com `aprofundada`; o duplo clique com um envio só; o erro que devolve o botão; o teto de 55 s com o `page.clock` e a contagem dos `setInterval` vivos; a captura que limpa; a retirada do consentimento no meio; o bloqueio sem sessão e sem API; a queda da porta e o "Reconectar"; 3 formas de `ready` fora do contrato; e os 10 relatórios hostis de novo, com os botões ativos;
  - o handshake do build sem origens diz `envio: false` (`messaging.e2e.test.ts`), e o do build auth, `envio: true` (`handshakeWith`, usado pelo `auth.e2e.test.ts` e pelo `auth-lifecycle.e2e.test.ts`);
  - extensão com 2.066 testes e 100% nas 4 métricas; E2E 121/121 no Edge; typecheck, lint e depcruise (535 módulos) verdes.
- **Mutação, em primeiro plano, com sha256 conferido:**
  - `mut04b2.py` (scratchpad da sessão 23) 58/58: U-01 a U-41 pela unidade (o `ready`, cada regra que desliga o "enviando", o clique, o que a tela oferece, o teto e os textos) e Q-01 a Q-17 pelo E2E (a cola do `App.tsx`, do `Analysis.tsx` e do `background.ts`);
  - `mut05b2.py` (cópia na sessão 23, com as âncoras do teto, da `sessao`, do tique e do estado inicial atualizadas) 64/65: o D-03 é o equivalente de sempre;
  - `mut05b3.py` (cópia na sessão 23) 31/32: o A-05 é o equivalente de sempre. O A-18 (a constante `API_DO_ENVIO`) deixou de existir, e os U-05, U-29, U-40, Q-15 e Q-16 ocupam o lugar dele;
  - `mut05b1.py` (cópia da sessão 21) S-, P-, WP- e BG- 22/22.
- **`[APPSEC]`:** as 6 condições cumpridas, cada uma com teste. Sem veto.

### 6.5 E2E do envio com a API falsa (04b-3, desenho de 2026-11-12, sessão 23)

`[QA_EVALS]` + `[APPSEC]`, antes do código. Nada em `src/` muda nesta parte: só os falsos do `test/e2e/support`, os cenários e as provas. As emendas dos cenários 3, 4, 5 e 12 ficam no [ADR-004-extension-auth](ADR-004-extension-auth.md) §4.4 ("Emenda do 04b-3").

#### D22. `POST /v1/analyze` no BFF falso, nunca mais permissivo que o real
- **Barreiras, sempre antes de qualquer roteiro:** a origem exata da extensão (403 sem CORS); a rota na lista e o método `POST`; o corpo até 64 KiB (`HTTP_BODY_MAX_BYTES`; 413); `content-type: application/json` (415); JSON válido (400); `Authorization: Bearer` igual ao access de uma sessão **viva** no falso (emitido por ele e não girado, encerrado nem revogado; senão 401 com o `ApiError` `NAO_AUTENTICADO`); e o corpo no `AnalyzeJobRequestSchema` estrito, do mesmo pacote de contratos da API (400 `PAYLOAD_INVALIDO`).
- **Resposta padrão:** `200` em `text/event-stream; charset=utf-8`, na forma exata do ADR-017 D6: três `stage` e o `result`, com o relatório de fixture e o `requestId` do pedido.
- **Registro, sem valor de segredo:** cada pedido que passou das barreiras entra em `analyses` com o `requestId`, o `mode`, a plataforma, a versão do extrator, o `clientTruncated`, a contagem e o SHA-256 do texto, o **índice** do access apresentado na lista dos emitidos (nunca o token) e a resposta dada. O `RequestRecord` de sempre segue contando, por rota, a presença do `Authorization`. O falso conta também os streams abertos e os que o cliente fechou antes do fim (`analises.abortadas`): é a prova do cancelamento imediato (§6.3) e da ligação do `onRevoke` no `background.ts`.

#### D23. Roteiros novos (cuidado 23: só depois das barreiras, e só mais hostis)
- **`analyze`**, uma fila de 1 a 8 passos, um por pedido válido: `401` e `503` (com o `ApiError` do pedido), `fora_do_contrato` (500 com um corpo que não é `ApiError` e leva um canário de erro), `silencio` (um `stage` e o stream aberto, sem mais nada), `keep_alive` (um comentário `:` no meio), `depois_do_resultado` (um `stage` depois do `result`), `event_divergente` (o `event:` que não bate com o `type`) e `grande_demais` (uma linha sem fim acima de 64 KiB).
- **`refresh`**, uma fila de 1 a 4 passos, só para a renovação **válida** (corpo no contrato e envelope de sessão viva): `503` (a sessão segue viva no falso) e `segurar` (a resposta fica presa até o `POST /soltar`, que então gira o par; sem o `soltar`, é o "prazo" do cenário 5). A renovação presa cujo cliente desistiu sai da lista sem girar nada. **A troca continua sem roteiro.** A regra do 05c-2 ("a troca e a renovação não têm roteiro") muda só para a renovação, porque os cenários 3 e 5 do ADR-004 §4.4 pedem exatamente a renovação lenta e a renovação fora: os dois passos só recusam ou atrasam o que o falso aceitaria, e nenhum aceita o que ele recusaria.
- **`expiresIn`** (1 a 900): o prazo dos próximos pares emitidos, até o `zerar`. Só encurta a vida do token.
- **`POST /revogar`** (não é roteiro; é estado): encerra todas as sessões vivas no falso, como o logout em outro dispositivo (D11.6 do ADR-004). A renovação e a análise seguintes dão 401 pelas barreiras de sempre.
- Cada passo novo ganha, na unidade (`e2e-support.test.ts`), a prova de que o pedido inválido (origem, Bearer, tipo de conteúdo, corpo) não o consome.

#### D24. Cenário 3 redesenhado (o SW aceita uma análise por vez)
- "N=5 análises simultâneas" deixou de existir: o `analisar` com outro em curso é ignorado (D10). O *single-flight* da renovação fica provado pelo caminho real assim:
  1. `expiresIn` de 30 s no login (abaixo do limiar de 60 s: todo `accessToken()` renova) e a renovação `segurar`;
  2. **5 painéis** abertos clicam em "Analisar vaga" ao mesmo tempo: o SW aceita 1 e ignora 4, e 1 renovação fica presa no falso;
  3. a vaga muda (texto colado), o que cancela a análise em curso com o `accessToken()` dela ainda esperando; os 5 painéis clicam de novo, e a análise nova **se junta à mesma renovação** (dois chamadores, uma `Promise`);
  4. o `soltar` gira o par uma vez. O contador do BFF falso mostra **exatamente 1 renovação** e **1 análise** (a nova, com o access renovado), e os 5 painéis mostram o mesmo relatório.
- O controle positivo do "1": o mesmo fluxo sem a renovação presa faz 1 renovação por análise (2 no total).

#### D25. Provas negativas com o envio (cuidado 24)
- Os cenários 12, 3, 5 e 4 (nesta ordem, com a sessão do Google já aberta e a vaga capturada na aba) entram na sequência do `auth-negative.e2e.test.ts`, antes das provas, e o login volta no fim, porque as provas contam com a sessão aberta.
- **Texto de vaga canário**, montado em tempo de execução e posto na página da vaga: o controle positivo é o SHA-256 do texto que chegou ao BFF falso, igual ao do texto capturado (que contém o canário). Ele nunca aparece nas mensagens da porta, no DOM nem no heap do painel, no console de nenhum alvo, nem em `local`, `sync`, localStorage, IndexedDB e CacheStorage. Fica só onde o ADR-024 D4 manda: no `storage.session` do SW e na própria aba.
- O token canário continua fora do painel com a análise em curso (a renovação presa) e depois do resultado.

#### `[APPSEC]` sobre o desenho (sem veto)
Condições: (1) nenhuma barreira do BFF falso some nem afrouxa, e nenhum roteiro age antes delas; (2) o registro do falso nunca guarda token nem texto de vaga (só índice, contagem e hash); (3) cada "0" novo tem controle positivo, e controle nunca é canário; (4) todo valor com cara de segredo nasce em tempo de execução; (5) o prazo real de 20 s do SW no cenário do silêncio fica num teste só, com prazo explícito.

#### Implementação do 04b-3 (2026-11-12, sessão 23, commit `353b3c8`)
- **Código, só em `test/`:** `test/e2e/support/fake-auth.ts` (o `analyze`, as filas `analyze` e `refresh`, o `expiresIn`, o `revoke` e o registro `analyses`), `test/e2e/support/fake-servers.ts` (a rota, o stream SSE, a renovação presa, `analises { abertas, abortadas }` e o `POST /revogar`), `test/e2e/support/leaks.ts` (o Bearer só no logout e na análise), `test/e2e/analysis.e2e.test.ts` (novo, 20 casos), `test/e2e/auth-negative.e2e.test.ts` (4 cenários a mais na sequência e o texto de vaga canário) e `test/e2e-support-analyze.test.ts` (novo, 60 casos).
- **Decisões de implementação:**
  - o falso confere o Bearer antes do corpo, como a API; o texto entra no registro pelo hash do que chegou, antes do corte do contrato;
  - a renovação presa gira o par só na hora do `soltar` e sai da lista se o cliente desistir (o SW que estoura o prazo não deixa o falso com um par que ninguém recebeu);
  - o `zerar` encerra os streams abertos pelo servidor, sem contar como abortados;
  - o `expect.poll` não roda em `beforeAll` (cuidado 23): os preparos do `analysis.e2e.test.ts` usam uma espera própria;
  - no controle positivo do cenário 3, um painel só clica: sem a renovação presa a análise termina em milissegundos, e 5 cliques seguidos viram análises seguidas.
- **Achados:**
  - **F1-EXT-08 (UX, sem risco):** a análise e a sessão se contradizem quando a renovação é recusada antes do envio e quando ela falha de forma transitória depois do 401 da análise. O comportamento de hoje ficou preso em teste, e a correção virou tarefa no *BACKLOG §F1-EXT-08*;
  - **Chrome 157:** o caso "página restrita" do `capture.e2e.test.ts` usa `edge://version/`, que o Chrome 157 aborta na navegação (`net::ERR_ABORTED`). O arquivo não mudou nesta sessão, e a falha não passa pela extensão; fica registrada para o QA-04 e para a próxima sessão.
- **Provas:** extensão com 2.129 testes e 100% nas 4 métricas; E2E inteiro 145/145 no Edge em 3 rodadas (159 s, 167 s e 175 s); no Chrome 157, 143 passaram, 1 foi pulado pela tabela do `runtime.reload()` e 1 falhou (o achado acima); turbo `build typecheck lint test` 21/21 em série, sem cache (2m33s); depcruise sem violações (537 módulos); gitleaks 8.30.1 conferido pelo `checksums.txt` (o hash do `linux_x64` é o do `ci.yml`), 195 commits, 0 achados.
- **Mutação, em primeiro plano, com sha256 conferido:**
  - `mut04b3.py` (scratchpad da sessão 23) 68/68: F-01 a F-32 no `fake-auth`, G-01 a G-20 no `fake-servers` e K-01 a K-06 no `leaks` pela unidade (o F-30, a fila da renovação que soma em vez de substituir, sobreviveu na 1ª rodada e virou teste); X-01 a X-04 e X-11 a X-16 pelo `analysis.e2e.test.ts`: o `onRevoke` e o `onChange` fora do `background.ts`, o `cancel()` sem o abort, o reenvio com o token antigo ou com outro `requestId`, o `auth-service` sem o *single-flight*, o teto do stream em 1 MB, o prazo de inatividade em 2 s, o `envio` falso e o 2º 401 sem o `onUnauthorized(2)`;
  - `mut05c1.py` unidade 44/48, `mut05c2.py` R- e H- 20/24 e `mut05c3.py` U 19/20: os que não aplicaram são os de âncora mudada, que rodaram no `mut04b3.py` na forma nova (A-14 como F-16 e F-29, S-12 como G-13, R-14 como F-23, H-02 a H-04 como G-10, G-11 e G-15, U-14 como K-02 e K-06), mais o A-08 e o S-09, parados em âncoras de sessões anteriores;
  - `mut05c3.py` E1 e E2 (o `auth-negative.e2e.test.ts` com a sequência nova) 16/17, com o E-05 equivalente de sempre.
- **Cuidado com o lote de E2E:** um mutante que faz os testes estourarem o prazo em cascata leva minutos (o X-15 levou 552 s), e um lote que passa de 10 min vai para segundo plano com o mutante no disco. O repositório só volta a ser tocado depois do fim, com o sha256 conferido.
- **`[APPSEC]`:** as 5 condições cumpridas. Nenhuma fronteira nova (o threat model não muda): o `/v1/analyze` e o Bearer dele já estavam no T9 e no SR-21. Sem veto.

### 6.6 O código da análise sem token (F1-EXT-08, emenda ao D10 de 2026-11-12, sessão 24)

**Problema** (*BACKLOG §F1-EXT-08*, achado do 04b-3): a análise e a sessão se contradiziam em dois caminhos.
1. **Renovação recusada antes do envio:** o `accessToken()` volta sem token porque a renovação levou 401 e apagou a sessão. A sessão dizia "Sua sessão expirou"; a análise, `SERVICO_INDISPONIVEL` (portão 4).
2. **Renovação transitória depois do 401 da análise:** o `onUnauthorized(1)` volta sem token com a sessão viva. A sessão dizia "Conectado" com o serviço indisponível; a análise, `NAO_AUTENTICADO`.

**D26. Leitura `hasSession()` no `auth-service`.**
- `hasSession(): Promise<boolean>`: `true` se há sessão local gravada (`trampo/sessao/v1`), `false` se não há. **Nunca devolve o token** nem nada da sessão, e nunca rejeita.
- **A leitura que lança conta como "há sessão"** (`true`). É a regra do T30: a dúvida nunca empurra para um novo login, e o pior caso é mostrar "serviço indisponível" a quem já saiu.
- **Por que não o `view()`:** ele devolve a `SessaoView` (com o erro degradado, que a análise não usa) e, na leitura que lança, `FALHA_INTERNA` com `autenticado: false`: o contrário da regra acima. Além disso, o `view()` é do canal da sessão e sai da `WorkerAuth` (`Omit<AuthService, "view">`). O custo do `hasSession()` é o do `view()`: um `get` do `storage.session`, só nos dois caminhos de falha.
- O `AnalysisServiceDeps.auth` passa a `Pick<AuthService, "accessToken" | "onUnauthorized" | "hasSession">`: a menor capacidade, um booleano.

**D27. Regra do código.**

| Caminho | `hasSession()` | Código ao painel | Log |
|---|---|---|---|
| Portão 4: `accessToken()` sem token | `false` | `NAO_AUTENTICADO`, sem `requestId` | `analise_sem_token` |
| Portão 4 | `true` (ou a leitura lançou) | `SERVICO_INDISPONIVEL`, sem `requestId` (como antes) | `analise_sem_token` |
| 1º 401 e `onUnauthorized(1)` sem token | `false` | `NAO_AUTENTICADO` com o `requestId` (como antes) | `analise_recusada` |
| 1º 401 e `onUnauthorized(1)` sem token | `true` (ou a leitura lançou) | `SERVICO_INDISPONIVEL` com o `requestId` | `analise_indisponivel` |
| 2º 401 (`onUnauthorized(2)`) | não é lida | `NAO_AUTENTICADO` (como antes) | `analise_recusada` |

- O 2º 401 não muda: o `onUnauthorized(2)` apaga a sessão do token usado, e a contradição não existe ali.
- **Caso do 401 atrasado de outra sessão (E-02):** "Sair" e login novo durante a análise; o `onUnauthorized(1)` volta sem token e há sessão (a nova). A análise passa a dizer `SERVICO_INDISPONIVEL`, coerente com a sessão "Conectado". Antes dizia `NAO_AUTENTICADO`.
- **Corrida com o cancelamento:** o `hasSession()` é mais uma espera. Cancelada durante ela, nada sai (a geração já é conferida antes do terminal).
- Nenhum código, texto ou mensagem nova: o catálogo `LOCAL_ERROR_MESSAGES` e o `ERROR_TEXTS` do painel não mudam.

**`[APPSEC]` (sem veto, 3 condições):**
1. o `hasSession()` devolve só o booleano (teste de tipo e de valor) e não toca na rede (teste com o `api` espião);
2. a leitura que lança é `true` (teste);
3. o `mut04b1.py` roda inteiro de novo, com os mutantes novos do D26 e do D27, e o `mut05a3.py` e o `mut_ext07.py` rodam porque o `auth-service.ts` muda.

**E2E (`analysis.e2e.test.ts`):** o "cenário 4 pela renovação antes do envio" passa a esperar `NAO_AUTENTICADO` na análise; caso novo: o 401 da análise com a renovação 503 dá `SERVICO_INDISPONIVEL` na análise, com a sessão "Conectado" e o serviço indisponível.

**Chrome 157 (QA-04):** o caso "página restrita" do `capture.e2e.test.ts` usa `edge://version/`, que o Chrome aborta. Troca por uma página restrita que os dois navegadores abrem, sondada antes.

**Implementação da §6.6 (2026-11-12, sessão 24, `9efcc55`):**
- `auth-service.hasSession()` (um `get` do `authSessionStore`; `true` no `catch`) e o `withoutToken(motivoSemSessao, motivoComSessao, requestId)` no `analysis-service`, que também trata a rejeição do `hasSession` como sessão (defesa, porque o contrato diz que ele nunca rejeita). O `WorkerAuth` passa a expor o `hasSession` (a lista de chaves do `worker-auth.test.ts` mudou de propósito).
- Testes antes do código: 11 casos novos falharam pelo motivo certo (5 da análise, 6 do `hasSession`).
- E2E no Edge 157: 146/146 em 3 rodadas; Chrome 157: 145 e 1 pulado pela tabela, **sem a falha do `edge://version/`** (o `capture.e2e.test.ts` agora abre o `chrome://version/` e procura a aba pela URL que o navegador reporta, `chrome://` ou `edge://`).
- Mutação em primeiro plano, sha256 conferido: `mut04b1.py` 77/77 (o N-25 portado para o `withoutToken`; H-01 a H-12 novos); `mut05a3.py` 57/57; `mut_ext07.py` 38/39 (o Z-11 por desenho); `mut_ext08.py` 9/9; `mut04b3.py` X- 10/10 em 4 lotes; `mut_ext08_e2e.py` 2/2 (a regra desfeita derruba os dois cenários do E2E).
- **`[APPSEC]`:** as 3 condições cumpridas. Nenhuma fronteira nova: o booleano não sai do SW para o painel (o painel só vê o código do catálogo, que já existia). O threat model não muda.
