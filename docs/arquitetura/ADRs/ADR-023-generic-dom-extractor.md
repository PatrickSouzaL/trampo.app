---
tipo: adr
id: ADR-023
titulo: "Extrator genérico de DOM (S-2, parte sintética): função autocontida no mundo ISOLATED, leitura só de nós de texto, descarte por técnica do T2 com contadores, cor normalizada por canvas, invisíveis Unicode preservados para o servidor, lint de só-leitura e prova no Edge real com cobertura de bloco do V8"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]) dentro do S-2 (BACKLOG) e do ADR-001 §5.0. Não muda contrato público, nem EXTRACTION_PROMPT_VERSION, nem LLM_OUTPUT_GUARD_VERSION. O extrator não é ligado no Service Worker antes do F1-EXT-03."
data: 2026-10-27
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "S-2 parte sintética (apps/extension/src/extraction/generic-extractor.ts, apps/extension/eslint.config.js, apps/extension/test/browser/**)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-005-job-text-normalizer](ADR-005-job-text-normalizer.md)", "[threat-model](../threat-model.md)", "*spike-metrics*", "*fixtures-dom*", "*BACKLOG §S-2*", "*BACKLOG §F1-EXT-03*"]
---

# ADR-023: extrator genérico de DOM

## 1. Contexto

O ADR-001 §5.0 (passos 2 a 4) define a captura: o Service Worker chama `scripting.executeScript` com uma função **autocontida**, no frame principal e no mundo ISOLATED. O extrator lê só o texto renderizado do contêiner da vaga e descarta o que o usuário não vê. O T2 lista as técnicas de ocultação que já foram usadas contra triagem por IA.

O S-2 pede três extratores (LinkedIn, Gupy e genérico). Os de plataforma dependem de páginas reais, que ainda não existem no repositório. Esta trilha entrega só o **genérico** e as fixtures **sintéticas**, uma por técnica do T2.

Sondagem no Edge 155 (2026-10-27, scratchpad) que define três decisões:
- `getComputedStyle(...).color` devolve `oklch(1 0 0)`, `lab(100 0 0)` e `color(srgb 1 1 1)` **sem converter**. Um parser de `rgb()` deixaria passar branco-no-branco escrito em `oklch`. Um `OffscreenCanvas` 1×1 com `fillStyle` + `getImageData` devolve sRGB em bytes para todos os formatos.
- O conteúdo de um `<details>` fechado tem `Range.getClientRects()` não vazio, mas `checkVisibility()` falso. A geometria sozinha não basta.
- Na execução das fixtures (mesmo dia), apareceram duas brechas e um falso descarte, corrigidos antes do commit:
  - o texto solto **direto** num elemento com `content-visibility:hidden`, ou num `<details>` fechado, tem retângulo de layout, e o pai passa no `checkVisibility()`. O canário passaria;
  - `display:contents` dá `checkVisibility()` falso e apagava texto legítimo.
- No mundo isolado criado por CDP (`Page.createIsolatedWorld`, o mesmo mecanismo do mundo ISOLATED da extensão), a troca de `window.getComputedStyle` feita pela página no mundo principal **não** aparece. A cobertura de bloco do V8 (`Profiler.startPreciseCoverage`, `detailed: true`) funciona para código avaliado nesse mundo.

## 2. Decisões

### D1. Local e forma
- `apps/extension/src/extraction/generic-extractor.ts` exporta `extractGenericJobText(limites)`. Versão `ge1`, literal dentro da função.
- **Autocontida:** nenhuma referência ao escopo do módulo. Os auxiliares são funções internas e as constantes são literais internos. Só usa globais do navegador (`document`, `getComputedStyle`, `OffscreenCanvas`, `Node`) e da linguagem.
- O único parâmetro é JSON simples (`{ maxChars, maxNodes, minChars }`), porque o `executeScript` serializa `args` em JSON. Fora de faixa: `{ ok: false, motivo: "limites_invalidos" }`, sem ler o DOM.
- **Não é ligado no Service Worker.** A ligação, o fallback para "colar o texto" e a prova no bundle de produção ficam no F1-EXT-03.

### D2. Mundo ISOLATED (página hostil, AT2)
O extrator roda no mundo ISOLATED, que é o padrão do `executeScript`. Nele, os protótipos (`Node`, `Element`, `Range`, `getComputedStyle`) são os nativos, mesmo que a página os troque no mundo principal. O DOM é compartilhado: a página ainda decide **o que** está no DOM e no CSS, mas não consegue mentir sobre como o navegador o renderiza. O teste prova isso com uma página que troca `getComputedStyle`, `checkVisibility` e `Range.prototype.getClientRects` no mundo principal.

### D3. Leitura: só nós de texto
- O extrator percorre a árvore por `firstChild`/`nextSibling` e lê só o `data` de nós `Text`. Não usa `innerText`. Para descartar um nó invisível de dentro de um `innerText`, seria preciso mudar a página, e o extrator é só-leitura. Emenda ao ADR-001 §5.0 passo 3: "lê o texto renderizado" passa a ser "lê o `data` dos nós de texto que passam no descarte".
- Nunca lê atributo como conteúdo (`data-*`, `alt`, `title`, `aria-label`, `placeholder`, `value`, `href`). A única leitura de atributo é **decisória**: a propriedade refletida `ariaHidden`, comparada com `"true"` e nunca emitida.
- Comentários, `CDATA` e instruções de processamento não são `Text` e ficam fora por construção.
- Shadow DOM não é percorrido. O texto que só existe na *shadow root* fica de fora, e esse é o lado seguro: menos texto, nunca mais injection. Fica como residual de completude.

### D4. Descarte por técnica (contadores em `descartes`)
Descarte de **subárvore** (o descendente não consegue desfazer):

| Contador | Regra |
|---|---|
| `naoTexto` | elemento fora do namespace HTML (SVG, MathML: cobre `<text>`, `CDATA` e `foreignObject`) ou tag `SCRIPT`, `STYLE`, `NOSCRIPT`, `TEMPLATE`, `IFRAME`, `OBJECT`, `EMBED`, `CANVAS`, `TEXTAREA`, `SELECT`, `BUTTON`, `HEAD` |
| `ruido` | `NAV`, `ASIDE` e `FOOTER` abaixo da raiz (menus e "vagas parecidas") |
| `naoRenderizado` | `checkVisibility()` falso (`display:none`, atributo `hidden`, filho de `<details>` fechado ou de *host* de shadow sem `<slot>`), salvo `display:contents`, que não tem caixa mas renderiza os filhos; ou `content-visibility:hidden` **no próprio elemento**, que mantém a caixa e esconde todo o conteúdo |
| `ariaHidden` | `ariaHidden === "true"` (ADR-001 §5.0) |
| `opacidade` | produto das `opacity` dos ancestrais abaixo de 0,1 |
| `recorte` | `clip-path` diferente de `none`, ou `clip` diferente de `auto` (padrão *sr-only*) |

Descarte por **nó de texto** (o descendente pode desfazer, ou depende da geometria):

| Contador | Regra |
|---|---|
| `naoRenderizado` | texto solto direto num `<details>` fechado (a propriedade refletida `open` é lida só para decidir) |
| `visibilidade` | `visibility` diferente de `visible` no pai do texto (`hidden` e `collapse`; o filho com `visible` volta a valer) |
| `fonteMinuscula` | `font-size` abaixo de 6 px |
| `tamanhoZero` | nenhum retângulo do texto (`Range.getClientRects`) com largura e altura positivas (`transform: scale(0)`) |
| `foraDaTela` | retângulo do texto inteiro à esquerda ou acima da origem do documento, já descontada a rolagem (`left:-9999px`, `top:-9999px`, `text-indent:-9999px`) |
| `cortado` | texto inteiro fora do corte de algum ancestral com `overflow` diferente de `visible`. Num eixo não `visible`, a borda esquerda ou a superior **sempre** corta, porque o transbordo nessa direção nunca é alcançável, nem rolando. A borda direita ou a inferior só corta com `hidden`/`clip` ou com tamanho zero naquele eixo (`height:0; overflow:hidden`, `max-height:0`, rolável sem área). Rolável com área positiva não corta para a direita nem para baixo, porque o usuário rola até o texto (o painel de vaga do LinkedIn rola) |
| `corDoFundo` | cor de preenchimento (`-webkit-text-fill-color`, que por padrão é a `color`) com alfa zero, salvo `background-clip: text` no próprio elemento; ou contraste WCAG abaixo de 1,2 contra o fundo efetivo (composição das `background-color` dos ancestrais sobre branco). Um ancestral com `background-image` antes do fundo opaco torna o contraste inconclusivo, e o texto fica |

Os contadores contam elementos (subárvore) ou nós de texto. Não carregam texto. A ordem das regras é a da tabela, e cada descarte conta uma vez, no primeiro critério que falha.

### D5. Invisíveis Unicode e Base64: preservados, nunca decodificados
O extrator **não** remove Unicode Tags, *zero-width*, bidi nem *variation selectors*. Quem remove é o `JobTextNormalizer` ([ADR-005-job-text-normalizer](ADR-005-job-text-normalizer.md)), que conta os removidos para a heurística de injection (T2, mitigações 3 e 4). Remover no cliente apagaria esse sinal. Base64 visível sai literal. O extrator não chama `atob`, `TextDecoder` nem `decodeURI*`, e o lint garante isso (D8).

### D6. Montagem do texto
- Espaço ASCII (`[\t\n\f\r ]+`) vira um espaço só, salvo `white-space` `pre*` ou `break-spaces`, que preservam as quebras. `\s` não é usado, para não tocar em U+00A0, U+FEFF e afins (D5).
- `BR` é uma quebra. Elemento de bloco (`display` que não começa com `inline` e não é `contents`) abre e fecha com quebra. `P`, `H1` a `H6`, `UL`, `OL`, `TABLE`, `BLOCKQUOTE`, `PRE`, `SECTION` e `HEADER` usam quebra dupla, que o `RelevantSectionSelector` lê como fronteira de bloco ([ADR-006-relevant-section-selector](ADR-006-relevant-section-selector.md)).
- No fim: espaços nas pontas de cada linha saem, 3 ou mais quebras viram 2 e o texto é aparado.

### D7. Raiz, limites e resultado
- **Raiz:** o primeiro `main` visível. Sem ele, o `article` com mais texto aproveitado. Sem nenhum, o `body`. O resultado diz qual (`raiz`).
- **Limites:** `maxChars` em unidades UTF-16 (o corte pode deixar um *surrogate* órfão, que o Service Worker remove, ADR-001 §5.0 passo 5), `maxNodes` (teto de nós visitados, contra DOM hostil gigante) e `minChars` (abaixo disso, `texto_insuficiente`, e o Service Worker oferece colar o texto, D10 do ADR-001).
- **Resultado:** `{ ok: true, versao, raiz, texto, truncado, descartes }` ou `{ ok: false, versao, motivo }`, só JSON simples.

### D8. Lint de só-leitura em `src/extraction/**`
Além dos seletores de HTML do preset, ficam proibidos no extrator:
- leitura de conteúdo por atributo ou por API que ignora a visibilidade: `innerText`, `outerText`, `textContent`, `getAttribute*`, `attributes`, `dataset`;
- decodificação e execução: `atob`, `btoa`, `TextDecoder`, `decodeURI*`, `unescape`, `eval`, `Function`;
- rede e mensagens: `fetch`, `XMLHttpRequest`, `WebSocket`, `postMessage`, `chrome`, `browser`;
- mutação do DOM: `appendChild`, `insertBefore`, `removeChild`, `replaceChild`, `remove`, `setAttribute`, `removeAttribute`, `click`, `focus`, `dispatchEvent`.

### D9. Fixtures
- **Sintéticas** (esta trilha): casos em `apps/extension/test/browser/synthetic-cases.ts`, cada um com o trecho HTML da técnica dentro do mesmo molde de página, o contador esperado, um **canário** único (`CANARIO-...`) no conteúdo oculto e um **controle visível** da mesma técnica (por exemplo, `opacity: 0.5` ao lado de `opacity: 0`), que mata o mutante que descarta demais.
- **Reais** (depois do *HITL-QUEUE §HITL-030*): `apps/extension/test/browser/fixtures/<plataforma>-<nn>.html` com um `.json` ao lado (`plataforma`, `coletadoEm`, `modoDeSalvamento`, `raizEsperada`, `trechosObrigatorios`, `trechosProibidos`). Coleta e anonimização no runbook *fixtures-dom*.

### D11. Extratores de plataforma: só a raiz muda (Trilha D2b, 2026-10-31)
- **Uma função, uma regra de descarte.** O arquivo vira `src/extraction/job-extractor.ts`, e a função, `extractJobText(limites, plataforma)`. O segundo parâmetro é `"generico"`, `"linkedin"` ou `"gupy"`, em JSON simples, como os limites.
- **A plataforma escolhe só a raiz.** A tabela de seletores é literal dentro da função, num `Map` (assim, `"__proto__"` e `"constructor"` não acham nada). Plataforma fora da tabela dá `limites_invalidos`, sem ler o DOM.

| Plataforma | Versão | Raiz | Origem |
|---|---|---|---|
| LinkedIn | `li1` | `.details-pane__content` | busca em dois painéis: a vaga aberta é irmã do `main`, que é a lista (fixtures-dom §6) |
| Gupy | `gu1` | `main#main` | o `main` da página, fixado pelo `id` (as classes são hashes do Emotion) |
| outras | `ge1` | `main` → `article` → `body` (D7) | — |

- **Fallback:** sem raiz da plataforma visível (`checkVisibility()`), roda o `ge1`, e o resultado diz `versao: "ge1"` com a raiz genérica. Se a raiz da plataforma é achada, ela decide, mesmo com pouco texto: no LinkedIn, o `main` é a lista de vagas e nunca deve entrar no lugar da vaga.
- **Resultado:** `versao` é `ge1`, `li1` ou `gu1`, e a `raiz` ganha `plataforma`.
- **Escolha no Service Worker** (`platformForUrl`): só o host da URL que o `activeTab` entrega no clique. `https:` com `linkedin.com` ou `*.linkedin.com` vai para o LinkedIn, `*.gupy.io` vai para a Gupy, e qualquer outro caso (sem URL, `http:`, URL inválida, sufixo parecido) cai no genérico. A URL não é guardada nem registrada. O retorno precisa ter a versão coerente com a plataforma pedida (ADR-024 D3).
- **Monitoramento:** `platform: "linkedin"` com `extractorVersion: "ge1"` no `AnalyzeJobRequest` quer dizer que o seletor do LinkedIn não achou a raiz. É o sinal de layout quebrado (spike-metrics §3.3).

### D12. LinkedIn logado (`li2`), Solides (`so1`) e o corte por rolagem (Trilha D2c, 2026-10-31)
- **Uma versão por seletor.** A tabela literal vira uma lista ordenada de `{ versao, raiz, layout }` por plataforma. A primeira raiz com um elemento visível vence e dá a versão. Seletor novo ganha versão nova, e o antigo mantém a dele: o `li1` continua sendo a página pública, com o mesmo seletor.

| Plataforma | Versão | Raiz | `layout` (falha fechada) | Origem (*fixtures-dom* §8) |
|---|---|---|---|---|
| LinkedIn logado | `li2` | `[data-sdui-screen$=".SemanticJobDetails"] [data-testid="expandable-text-box"]` | `main#workspace` | o painel da vaga do layout logado traz, além da descrição, blocos tirados do perfil e da rede do usuário. Só a descrição entra |
| LinkedIn público | `li1` | `.details-pane__content` | — | D11 |
| Gupy | `gu1` | `main#main` | — | D11 |
| Solides | `so1` | `#vacancy-box-details` | — | busca em dois painéis em `vagas.solides.com.br`, sem `main`: o `ge1` cai no `body` e pega a lista inteira |
| outras | `ge1` | `main` → `article` → `body` (D7) | — | — |

- **Falha fechada no layout reconhecido.** Se nenhuma raiz da plataforma aparece, mas o `layout` de uma delas está visível, o resultado é `{ ok: false, versao: <a do layout>, motivo: "texto_insuficiente" }`, sem ler nada, e o painel oferece colar o texto.
  - No LinkedIn logado, o `main#workspace` junta a lista de vagas, o painel da vaga e os blocos do perfil. O `ge1` ali traria a lista, "algumas qualificações não constam do seu perfil", "pessoas que você pode contatar" e a contagem de ex-alunos da instituição do usuário (medido: 4 a 6 proibidos por página, *spike-metrics* §3.5).
  - É a garantia de que a lista nunca entra no lugar da vaga. Fora do layout reconhecido, o `ge1` continua sendo o último caso.
  - Uma raiz achada sempre vence o `layout`: a página pública dentro de um `main#workspace` (improvável) ainda dá `li1`.
- **Só a descrição no `li2`.** O título, a empresa, o local e os chips de modalidade ficam de fora. O cartão do topo não tem âncora estável (classes atômicas em hash) e mora no mesmo painel dos blocos do perfil. A modalidade que só aparece no chip se perde; o título vai pelo `titleHint` no envio à API (F1-EXT-04 parte 2).
- **Emenda ao D4 (`cortado` e `foraDaTela`): rolável dentro de corte.**
  - **Regra nova.** Num eixo rolável (`auto`/`scroll`), o texto passa se alguma posição da rolagem o traz para a parte visível da caixa (a caixa cortada pelos ancestrais e pela origem do documento). O intervalo vai do início dessa parte menos o que já foi rolado até o fim dela mais o que falta rolar. Nesse eixo, os cortes de fora e a origem do documento se soltam para a subárvore. Sem parte visível (rolável de tamanho zero ou fora do corte), nada passa.
  - `hidden`/`clip` continuam cortando na caixa, porque o usuário não rola. O rolável do `<html>` e do `<body>` é a própria página, que anda junto com a caixa deles: vale como `visible`, e a origem do documento continua cortando (`foraDaTela`).
  - **Por quê.** O LinkedIn logado é um *app shell*: o `body` e vários ancestrais têm `overflow: hidden` do tamanho da janela, e a vaga fica num rolável interno. A regra antiga cortava tudo abaixo da dobra: o `ge1` lia cerca de 1.000 caracteres da tela, sem a descrição, e o `li2` dava `texto_insuficiente` nas 3 páginas. Ela também descartava o que o usuário já tinha rolado para cima dentro do painel (borda superior e `foraDaTela`), que é o caso comum na página viva.
  - **Mais estrita para a frente.** O rolável que cabe na própria caixa não estende nada. Isso fecha o ataque "rolável gigante sem rolagem dentro de um corte", que a regra antiga também barrava pelo corte de fora.
  - **Contadores.** O texto de um rolável fora de alcance conta como `cortado`. Antes, parte disso caía em `foraDaTela`.
  - **Sem regressão:** as 21 fixtures da D2a/D2b e os 52 casos sintéticos anteriores dão o mesmo resultado. O transbordo para a esquerda num rolável RTL continua cortado, como antes.
- **Versões e o D4.** A emenda muda o que o `ge1`, o `li1` e o `gu1` devolvem em páginas com rolável interno, mas as versões não mudam: nenhuma versão saiu do navegador ainda (o envio à API não existe). A partir do F1-EXT-04 parte 2, qualquer mudança no D4 muda todas as versões.
- **"Ver mais" fechado (medido).** O LinkedIn recolhe a descrição com um *clamp* de 6 linhas (`-webkit-line-clamp` e `overflow: hidden`). O resto contava como `cortado`: no `linkedin-08`, ficavam 382 caracteres das 6 primeiras linhas. Resolvido pela D13 (Trilha D2d).
- **Service Worker** ([ADR-024-capture-in-service-worker](ADR-024-capture-in-service-worker.md) §7): o `platformForUrl` acrescenta `vagas.solides.com.br` e `*.vagas.solides.com.br`, cada plataforma aceita a lista das suas versões, e o `PlatformSchema` do contrato ganha `solides` (DOC-01).
- **Monitoramento** (*spike-metrics* §3.5): `linkedin` com `li2` e `texto_insuficiente` é o seletor logado quebrado com o layout ainda reconhecido; `linkedin` com `ge1` é o layout inteiro mudado.
- **Riscos residuais (aceitos):**
  - a vaga aberta direto (`/jobs/view/...`) logada não foi coletada. Se ela não tiver a tela `SemanticJobDetails`, cai na falha fechada pelo `main#workspace`;
  - se o LinkedIn trocar também o `main#workspace`, o `ge1` volta a pegar a lista e os blocos do perfil. O sinal é `linkedin` com `ge1`, com o alarme de 20%;
  - elemento `position: absolute` cujo bloco de contenção fica fora do rolável não é cortado por ele no navegador, mas a regra o trata como cortado (descarta a mais, o lado seguro). Herdado da regra anterior.

### D13. "Ver mais" fechado: o *clamp* da própria raiz do `li2` não corta (Trilha D2d, 2026-11-04)
- **Decisão (`[ARCHITECT]` + `[APPSEC]`): opção (b) do BACKLOG**, exceção ao `cortado` só na caixa da descrição. A opção (a), um aviso no painel para abrir o "ver mais" e capturar de novo, foi descartada: ela deixa a análise errada por padrão (382 de 3.324 caracteres no `linkedin-08`) e depende de o usuário ler o aviso.
- **Regra.** Na raiz da plataforma cuja versão declara `verMais` (hoje só o `li2`), com `-webkit-line-clamp` diferente de `none` e corte vertical na própria raiz (`overflow-y` `hidden`/`clip`):
  - a borda de baixo da caixa da raiz desce `scrollHeight − clientHeight`, a altura do que o *clamp* recolhe;
  - os cortes de fora que ainda valem na vertical descem na mesma medida, porque abrir o "ver mais" empurra a caixa e o fim da rolagem dos ancestrais (no `linkedin-08`, o rolável do painel só alcançava cerca de dois terços da descrição aberta).
- **O que não muda:**
  - todas as outras regras do D4 valem dentro da descrição (`display:none`, cor do fundo, fonte minúscula, opacidade, fora da tela). Só o corte do *clamp* da raiz se solta;
  - o *clamp* de um descendente ou de um ancestral da raiz continua cortando, e o de qualquer raiz do `ge1`, do `li1`, do `gu1` e do `so1` também (T2);
  - um *clamp* sem corte vertical na raiz (`overflow-x: clip`) não abre nada: as linhas já transbordam, e o corte de fora continua valendo;
  - um *clamp* rolável na raiz não estende de novo: o rolável já alcança o resto (D12).
- **Sem clicar e sem mudar a página.** O extrator não clica no "ver mais" (D8 proíbe `click`, e o clique mudaria a tela do usuário) e não troca classe nem estilo.
- **Clone com `innerText`: vetado pelo `[APPSEC]`.** Proposto no pedido da trilha (clonar a raiz, tirar o *clamp* e ler o `innerText`). Sondagem no Edge 155, no mundo isolado: o `innerText` de um clone **desconectado** devolve o mesmo que o `textContent` e traz o canário com `display:none` (`"vagaCANARIO-noneCANARIO-brancoCANARIO-zero"`). Fora do documento, o clone não tem estilo nem caixa, e todo o D4 se perde. Pôr o clone no documento para ter estilo é mutação do DOM (D8) e aparece na tela. Também quebraria o D3 (só nós de texto) e o lint do `innerText`.
- **DOM Clobbering.** Um `<form>` com `<input name="scrollHeight">` troca `form.scrollHeight` pelo `<input>`, também no mundo isolado (sondado). Nesse caso a conta dá `NaN`, e toda comparação com `NaN` é falsa: o texto inteiro da raiz vira `cortado` (o lado seguro, provado por teste). A exceção só existe na raiz do `li2`, que no LinkedIn é um `span`.
- **Desempenho.** Nenhum clone nem nó novo: uma leitura de `scrollHeight` e `clientHeight` na raiz. O teto de 50.000 nós não muda.
- **Versão.** O `li2` não muda de versão: nenhuma versão saiu do navegador ainda (D12). A partir do F1-EXT-04 parte 2, mudança assim muda a versão.
- **Riscos residuais (aceitos):**
  - dentro da descrição do `li2`, o que cabe no `scrollHeight` da raiz conta como alcançável depois do "ver mais", mesmo o que estaria fora da caixa aberta (deslocado com `position: relative` ou `transform`). Quem publica a vaga no LinkedIn não escreve CSS; o servidor continua com as defesas do T1 e do T2;
  - um ancestral com `overflow: hidden` de altura fixa entre a raiz e o rolável cortaria a descrição aberta, e a regra a deixa passar. Não existe no layout medido.

### D10. Prova
- `pnpm --filter @trampo/extension test:browser`: Edge instalado, `playwright-core` (já no catálogo), sem dependência nova, sem build da extensão e com a rede da página bloqueada (`route.abort`).
- Cada caso: `setContent` → mundo isolado novo por CDP → `Runtime.evaluate` de `(${extractGenericJobText.toString()})(limites)`. Isso prova a autocontenção (a função roda sem o módulo) e o mundo isolado.
- **Cobertura de 100%** medida pelo V8 no próprio navegador: a união da cobertura de bloco de todas as execuções não pode deixar nenhum trecho do extrator com contagem zero (fora espaço e pontuação de fechamento). O teste falha e mostra o trecho.
- **Mutação** manual por script no scratchpad, com o registro no SESSION-LOG.
- Fora do `pnpm test` e do CI, como o `test:e2e`, porque exige navegador.

## 3. Auditoria do `[APPSEC]` (sem veto)

Critérios de aceite:
1. Nenhum canário de técnica oculta aparece no texto, e o contador da técnica é positivo.
2. Todo controle visível aparece no texto.
3. Atributos, comentários, `script`/`style`/`noscript`/`template` e SVG/CDATA nunca aparecem.
4. Invisíveis Unicode chegam idênticos (nem removidos, nem decodificados). Base64 sai literal, sem o canário decodificado.
5. A página que troca as APIs no mundo principal não muda o resultado.
6. Limites inválidos não leem o DOM. `maxNodes` e `maxChars` valem.
7. A função roda serializada, sem o módulo.
8. Cobertura de bloco de 100% no V8 e mutação sem sobrevivente não equivalente.
9. Lint D8 ativo e provado por um arquivo negativo no scratchpad.
10. Nenhuma versão de prompt ou de guard muda, e nada chama a rede.

Riscos residuais (aceitos, a medir com as fixtures reais):
- **Oclusão:** texto coberto por outro elemento (`z-index`) não é detectado. `elementFromPoint` só vale dentro da viewport.
- **Fundo por imagem ou gradiente:** contraste inconclusivo; o texto fica.
- **`filter: opacity(0)`, `mix-blend-mode`, `color` animada e fonte com glifos vazios** não são detectados.
- **Excesso de descarte:** texto num *clamp* "ver mais" (`overflow: hidden`) fica de fora, porque o usuário não o viu. Isso pode baixar a completude no LinkedIn, e a fixture real mede. Medido na D2c e resolvido no `li2` pela D13; nas outras raízes continua.
- **Shadow DOM** não é lido (D3).
- **Posição muito à direita ou abaixo** com a rolagem da página bloqueada (`overflow: hidden` no `html`) não é detectada: só a área negativa do documento, que nunca rola, conta como fora da tela.
- **Árvore muito profunda** (dezenas de milhares de níveis montados por script) pode estourar a pilha da recursão. A extração falha, e o painel oferece colar o texto. É negação de serviço só daquela página.
- A defesa estrutural continua: o LLM não decide nota, não tem tools e o servidor remove invisíveis até o ponto fixo (T1, T2).

## 4. Consequências
- O F1-EXT-03 liga o extrator no Service Worker (fallback genérico e "colar o texto") e prova a autocontenção no bundle de produção.
- Os extratores do LinkedIn e da Gupy escolhem a raiz pela plataforma e reusam as mesmas regras de descarte. Eles esperam as fixtures reais (*HITL-QUEUE §HITL-030*).

## 5. Implementação (2026-10-27, Trilha D)
- `src/extraction/generic-extractor.ts` (`ge1`), lint D8 em `eslint.config.js`, e a bancada, as 23 fixtures e os 52 testes em `test/browser/` (`test:browser`).
- **Prova:** 52/52 no Edge 155; cobertura de bloco do V8 de 100%; mutação com 97 mutantes distintos em 3 rodadas, sem sobrevivente nem equivalente; lint D8 provado por um arquivo negativo (15 violações plantadas, 15 pegas); turbo 19/19 em série; depcruise sem violações. Detalhes no *spike-metrics* §3.
- **Emendas desta implementação** (já refletidas na D4):
  - o transbordo para a esquerda ou para cima passou a cortar sempre, achado pela mutação;
  - `display:contents` saiu do `checkVisibility`;
  - `content-visibility:hidden` vale no próprio elemento;
  - o texto solto direto em `<details>` fechado é descartado.
- `[APPSEC]`: os 10 critérios do §3 estão cobertos, e não há veto.
- **2026-10-27 (Trilha F):** o extrator foi ligado no Service Worker sem mudar ([ADR-024-capture-in-service-worker](ADR-024-capture-in-service-worker.md)). A autocontenção ficou provada também no bundle minificado de produção.

## 6. Implementação (2026-10-31, Trilha D2b)
- **Código:** `job-extractor.ts` (o antigo `generic-extractor.ts`, renomeado no git) com a D11; `capture.ts` com o `platformForUrl`, a validação da versão contra a plataforma e o `CapturedJob` com `linkedin` e `gupy`; o `background.ts` passa `platformForUrl(tab.url)`.
- **Fixtures:** em 4 das 7 páginas do LinkedIn, o trecho proibido da D2a era o título da própria vaga aberta (o cartão selecionado na lista). Ele foi trocado pelo título de outro cartão, conferido fora do painel (commit `c664056`, só os `.json`).
- **Prova (commit `5c2dd4e`):**
  - `test:browser` 108/108: os 52 sintéticos de antes, 12 da D11 e 44 nas fixtures reais. A cobertura de bloco do V8 continua em 100%;
  - **gate nas 21 fixtures reais:** cada uma roda o extrator que o host escolheria. Os obrigatórios aparecem, nenhum proibido aparece, e cada proibido existe na página fora da raiz (o gate não é vazio). Onde a página tem o CSS da plataforma (Gupy e GeekHunter), nenhuma linha do texto fica fora do `innerText` da raiz;
  - E2E no build de produção 34/34. O host real do LinkedIn e da Gupy é roteado para as fixtures pelo navegador, e a prova negativa (o `background` sem o host) derruba os 2 testes novos;
  - mutação 32/32 sem sobrevivente (13 no extrator, 19 na captura e no serviço);
  - unidade 168/168 com 100%, lint, typecheck, depcruise e turbo 21/21 em série.
- **`maxNodes`:** fica em 50.000 (spike-metrics §3.3). A maior página real tem 4.875 nós, e o teto lido inteiro leva 541 ms.
- `[APPSEC]`: sem veto. Os riscos novos estão no ADR-024 §6.

## 7. Implementação (2026-10-31, Trilha D2c)
- **Fixtures (commit `08a8fd4`):** 3 páginas do LinkedIn logado (*HITL-QUEUE §HITL-033*) e 4 da Solides, com o CSS da plataforma. Marcadores: `[PESSOA]` 2, `[EMPRESA]` 2, `[ENDERECO]` 2 e `[URL]` 1. Emendas da limpeza em *fixtures-dom* §8.
- **Código (commit `1a0dcb8`):** `job-extractor.ts` com a D12 (tabela por versão, falha fechada pelo `layout` e corte por rolagem), `capture.ts` (Solides no `platformForUrl`, versões por plataforma, `CapturedJob` com `solides`) e `PlatformSchema` com `solides`.
- **Prova:**
  - unidade 180/180 com 100%, e contratos 91/91 com 100%;
  - `test:browser` 136/136: 78 sintéticos (com os casos novos `rolavel-interno`, `pagina-rolavel` e `pagina-travada`, e os do LinkedIn logado e da Solides) e o gate nas 28 fixtures reais. A cobertura de bloco do V8 continua em 100%;
  - E2E no build de produção 37/37 (a prova negativa derruba os 3 testes novos), com o host real do LinkedIn logado e da Solides e a falha fechada no layout logado;
  - mutação 66/66, sem sobrevivente (as 5 lacunas da primeira rodada viraram casos sintéticos);
  - lint, typecheck, depcruise (417 módulos) e turbo 21/21 em série.
- `[APPSEC]`: sem veto. O `li2` lê só a descrição, a falha fechada impede a lista e os blocos do perfil, e nenhuma permissão mudou.

## 8. Implementação (2026-11-04, Trilha D2d)
- **Código (commit `fc7a194`):** `job-extractor.ts` com a D13 (campo `verMais` na tabela de versões, `abreClamp` na raiz do `li2`).
- **Prova:**
  - `test:browser` 145/145, com a cobertura de bloco do V8 em 100%. São 9 casos sintéticos novos: o recolhido entra; o oculto dentro dele continua de fora; o *clamp* aninhado, o de um ancestral e o de outra raiz continuam cortando; o corte de altura sem *clamp* corta; o *clamp* sem corte vertical abre nada; o rolável não estende duas vezes; o fim da rolagem do painel desce; e o `<form>` que sombreia `scrollHeight` não estende nada;
  - **gate real:** no `linkedin-08`, o `li2` passa de 382 para 3.324 caracteres, com os 3 trechos recolhidos, `cortado` 0 e só o botão "… mais" em `naoTexto`. Nas 3 páginas logadas, toda linha do `innerText` da descrição (que traz o recolhido) está no texto, e nenhuma linha do texto fica fora dele;
  - E2E no build de produção 38/38, com o `linkedin-08` no host real do LinkedIn. A prova negativa (o extrator de antes no build) derruba o teste novo no trecho recolhido;
  - **correção da bancada E2E:** a rota casava o CSS pelo caminho inteiro, e o `href` relativo das fixtures sob `/jobs/search-results/` era abortado. Os E2E do LinkedIn logado, da Gupy e da Solides da D2b e da D2c rodavam sem o CSS da plataforma. Agora casa pelo nome do arquivo;
  - mutação 13/13 no código novo (2 sobreviventes da primeira rodada viraram os casos do ancestral e do *clamp* sem corte vertical);
  - unidade 180/180 com 100%, depcruise (417 módulos) e turbo 21/21 em série.
- `[APPSEC]`: sem veto. O clone com `innerText` foi vetado (D13), e o DOM Clobbering cai no lado seguro.
