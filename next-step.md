# Próximo passo: F1-EXT-05b, commit 05b-3 (botões, "Reconectar" e E2E do painel), numa sessão nova

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie o prompt do fim deste arquivo. Nenhum HITL bloqueia a trilha: o HITL-037 (push e PR) corre em paralelo.

## O que acabou de ser entregue (2026-11-09, sessão 14)

### F1-EXT-05b: commit 05b-2 (`c61f50d`), estado e textos da sessão
- **Partição** (ADR-004 §6.3 item 4): 05b-1 ✅ (`abafafb`) → **05b-2 ✅** (`c61f50d`) → 05b-3 (botões, "Reconectar" e E2E do painel). O `[APPSEC]` não vetou. A condição 3 ("Reconectar" só por ação do usuário) já vale na lógica; o clique em si é do 05b-3.
- **`src/panel/panel-state.ts`**, em lógica pura e sem mensagem nova na porta:
  - estado local `entrandoDesde` e `pediuSair`, e as ações `entrar { agora }`, `sair`, `tique { agora }` e `reconectar`. O relógio entra como dado da ação, e o redutor segue puro;
  - o "entrando" desliga na próxima `sessao` ou no teto de 310 s (`ENTRANDO_TETO_MS`, preso por teste ao `loginDeadlineMs` + 10 s), e também com o relógio que volta (falha segura);
  - `logoutUnconfirmed`: o texto da falha remota e o "Tentar sair de novo" só depois do clique em "Sair". Uma sessão autenticada encerra o pedido;
  - `sessionActions`: os botões que a tela oferece. O redutor ignora o clique que não está ali;
  - `canReconnect`: só com `porta_fechada`. O "Reconectar" volta ao estado inicial; `resposta_invalida` continua definitiva;
  - `analyzeBlock(api, { consentimento, sessao })`: `sem_api`, `sem_consentimento` ou `sem_sessao`. O `api` vem do App e fica `false` até a F1-EXT-04 parte 2.
- **`src/panel/texts.ts`:**
  - `SESSION_TEXTS` exaustivo por `{ autenticado, erro }`, o texto do "Sair" sem confirmação, o "entrando", os rótulos dos botões por provedor e os motivos do portão;
  - dois desvios do D12, registrados como emenda: o `ERRO_INTERNO` sem pedir o código do pedido, e o `LIMITE_DE_TAXA` com texto próprio (o do `ERROR_TEXTS` fala de análises);
  - o `SEM_API` do `Analysis.tsx` passou a vir daqui (a única linha de `.tsx` do commit).
- **Prova local:**
  - extensão de 1203 para 1255 testes, 100% nas 4 métricas;
  - teste de invariante: uma busca em largura por todos os estados alcançáveis;
  - mutação 64/65 na 2ª rodada (`mut05b2.py`, catálogo no SESSION-LOG). Na 1ª, os 3 sobreviventes eram equivalentes: 2 conferências redundantes saíram do código, e o 3º ficou provado pelo teste de invariante;
  - E2E 49/49 no Edge; turbo 21/21 em série, sem cache; depcruise sem violações (509 módulos).
- **Cofre:** ADR-004 D12 e §6.3 item 4 ("Emenda do 05b-2"), ADR-025 D3, STATE, BACKLOG (F1-EXT-05) e SESSION-LOG. **Runbook novo `publicar-branch-pr` e HITL-037**, a seu pedido. Os backups estão no scratchpad.
- Nada chamou o Supabase real nem provedor de LLM.

### Pendências do humano
- **HITL-037 (novo, não bloqueia nenhuma trilha):** publicar o `spike/s1-extraction` e abrir o PR novo para o `master`. O passo a passo está no runbook `../base/03-infra-runbook/publicar-branch-pr.md`. O CI só roda em PR para o `master`, então a prova no GitHub vem com o PR.
- **Push não autorizado nesta sessão:** o GitHub está no `4b0bb1d`. O `abafafb`, o `b3a398e`, o `c61f50d` e o commit deste arquivo estão só no local. Para subir, escreva "push autorizado" no prompt da próxima sessão, ou faça o push pelo runbook (§3). **Abrir e mergear o PR** é seu (o PR #17 já foi mergeado).
- **Vale desde o 07h:** quem rodar `supabase start` na estação precisa gerar a chave antes, com `node apps/api/test/db/support/write-signing-key.ts supabase/signing_keys.json` na raiz do `trampo.app` (runbook `auth-extensao` §1.6). Sem o arquivo, o `start` não sobe.
- **Vale desde o 07g:** fora de `NODE_ENV=test`, a API só sobe com `API_BEHIND_PROXY=false` (junto com `TRUST_PROXY=false`) e o anel `AUTH_REFRESH_SEAL_KEYS` e `AUTH_REFRESH_SEAL_ACTIVE_KEY` no `apps/api/.env` (runbook `auth-extensao` §1.5).
- **Vale desde o 05a-4:** o build da extensão com login precisa de `TRAMPO_API_ORIGIN`, `TRAMPO_SUPABASE_ORIGIN` e, para o ID fixo, `TRAMPO_EXTENSION_KEY` (a chave pública em SPKI base64). Sem as duas origens, o "Entrar" dá erro interno. Nenhum valor vai ao cofre.
- **Antes de cada push:** `git fetch` e confira `HEAD..origin/spike/s1-extraction`. O branch pode receber commits no GitHub entre sessões.

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM nem chama o Supabase real. A API chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **F1-EXT-05b → F1-EXT-05c → F1-SEC-01** (**próximo: 05b-3**) | Resto do ADR-004, uma trilha por vez. A F1-EXT-05a foi concluída (`78be3f2`, `ec9c915`, `db98323` e `cd141d2`). **05b**, em 3 commits (ADR-004 §6.3 item 4): 05b-1 ✅ `abafafb` (isolamento e handshake) e 05b-2 ✅ `c61f50d` (estado e textos da sessão, em lógica pura). **05b-3**, no React: os botões do `sessionActions` ("Entrar com GitHub", "Entrar com Google", "Sair da conta", "Tentar sair de novo"), o texto do `describeSession`, o "Analisar" pelo `analyzeBlock`, o relógio e o tique do "entrando", e o "Reconectar" (novo `runtime.connect` e novo `hello`, só por clique); o E2E do painel com a porta falsa e o E2E local inteiro (CA-16); a emenda do ADR-025 D4 e D5. Com ele, a F1-EXT-05b fecha. **05c**: E2E com IdP falso (com a prova em runtime do P3) e as provas negativas. **SEC-01**: threat model v2 | não | nada para o 05b-3; as trilhas seguintes esperam a anterior |
| **F1-EXT-04 parte 2 (envio à API)** | Nova, liberada pela F1-EXT-05a (a Trilha A já tinha sido feita): portão do `consent.isGranted()` e da sessão, `accessToken()` e `onUnauthorized(1 \| 2)` do `auth-service`, SSE, `source` com `platform` e `extractorVersion`, botões habilitados. O prazo, o teto e o leitor do `/v1/analyze` se decidem aqui (ponto aberto do 05a-2) | não, se os testes usarem a API falsa | mexe na porta e no painel como a 05b: entra depois dela, numa sessão própria |
| **F1-API-07 (07i e 07j)** | BFF do ADR-004 (D4 a D8), na partição do ADR-004 §6.3. Feitos: 07a (`c51b809`), 07b (`905d85f`), 07c (`86fe1ef`), 07d (`7e6c5d5`), 07e (`ac3c2c7`), 07f (`e1af5d0`), 07g (`b516fd0`) e 07h (`4efd96c`). Faltam, um commit por vez: **07i** métricas `auth_*_total` do D8 item 7 na porta `Telemetry`; **07j** teto de rajada de 15 (reposição de 0,25 por segundo) no `GotrueEgress`, somado às janelas de hoje (o balde `Token` do GoTrue tem rajada fixa de 30; ADR-004 D8 item 5, "Emenda do 07h") | não | nada; nenhum dos dois bloqueia as F1-EXT-05x |
| **F1-DB-02** | Custom Access Token Hook por migration (ADR-004 D5): recusa com 403 a sessão com mais de 24 h, grants mínimos e `test:db` da recusa na emissão e na renovação. Depois, HITL de aplicação no projeto real (molde do HITL-023) | não | nada; o P18 (CA-15) depende dela, mesmo com o ADR-004 aceito por sobreposição do veto |

**O que vem depois:**
- **Balde do projeto real:** o GoTrue local não aplica o limite por IP, então a sonda só prova o modo. O balde do `pkce` e do `/logout` no projeto real fica para o spike S-3 (P19), pelo código-fonte até lá.
- **07i e 07j:** entram entre as trilhas da extensão, à escolha do `[ORCHESTRATOR]`, cada um numa sessão própria.
- **F1-DB-02 concluída:** abre o HITL de aplicação do hook.
- **Spike S-3 completo (P1 a P20):** depois das F1-EXT-05x e da F1-DB-02. Depois dele, o fechamento do F1-EXT-05 pelos CAs do §4.10. O ADR-004 já está `aceito` por sobreposição do veto, mas o P3 e o P18 seguem obrigatórios. O **P9** confirma o formato real do `amr` (hoje só a lista de objetos do GoTrue passa).
- **S-5 (troca do Site URL, ADR-004 D15):** a página estática fica pronta antes, numa origem própria. Depois, o humano refaz pelo runbook `auth-extensao` §3 os casos A com `-ComState` (P5), E, F (anotando o `caminho`) e G. Se o `st` deixar de voltar, vale a Q6; se um código chegar a host fora da lista, vale o veto do `[APPSEC]`. O S-5 também traz as faixas da Cloudflare para o `TRUST_PROXY` (com `API_BEHIND_PROXY=true`) e o exportador de métricas.

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`.
2. **Nenhuma sessão muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`** sem um HITL mandar. O próximo prompt (`p4`) carrega a linha do `null` de `yearsExperienceMin` e passa pelo aceite completo (§8.1 por efeito, §8.3 com ruído).
3. **Nenhuma trilha chama provedor.** Para testar a API à mão, lembre que ela agora gasta cota do Groq.
4. **O avaliador do S-1 tem a equivalência de nome** (`stackKey` no `score.ts`). Ninguém muda a regra sem refazer o relatório de todas as versões e o `s1-effect.json`.
5. **O critério de stack é o efeito na nota** (golden-dataset-spec §8.1), e o **§8.3 tem o ruído**. Cada aceite novo de prompt ou guard roda o `S1_MODE=effect` e, se cair mais de 2 pp, o `S1_MODE=noise`.
6. **A cadeia de produção passa pelo `composeProductionApp`.** Provedor novo ou troca de modelo exige o gate do golden dataset antes (T28).
7. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts`. O GoTrue simulado (`test/support/fake-gotrue.ts`) segue o mesmo padrão:
   - os modos `lento` e `corta` processam o pedido antes de perder a resposta (casos de 2 chamadas do 07f);
   - a opção `accessToken` emite JWS assinado para o `jose` real;
   - a opção `jwks` (07g) serve o JWKS na mesma origem, porque o boot exige o JWKS na origem do `SUPABASE_URL`. É assim que o `test/compose-app.test.ts` sobe o BFF inteiro.

   Asserção de tempo com o relógio real fica em faixa folgada; a conta exata vai para o `FakeClock`, o `ManualClock` e o `now` injetado. Se o `edge-socket.test.ts` voltar a falhar no turbo, guarde o nome do caso e leve ao QA-02.
8. **Fixtures reais:** qualquer fixture nova ou alterada passa de novo pelo runbook fixtures-dom §2 a §4 e pelas emendas do §8 (script fora do repositório, varredura antes do `git add`, commit próprio). O trecho proibido precisa existir na página e não pode aparecer na raiz da vaga; o recolhido (com "ver mais" fechado) precisa entrar no texto (ADR-023 D13).
9. **O extrator é um só** (`job-extractor.ts`, ADR-023 D11 e D12):
   - a regra de descarte (D4) vale para todas as plataformas, e qualquer mudança nela passa pelo `test:browser` inteiro, com a cobertura de 100% e a mutação;
   - cada seletor de plataforma tem a sua versão (`li2` logado, `li1` público, `gu1`, `so1`); seletor novo ganha versão nova e precisa de fixture real no gate;
   - o *clamp* só deixa de cortar na própria raiz de uma versão com `verMais` (hoje só o `li2`, D13); estender isso a outra raiz passa pelo `[APPSEC]`;
   - **depois que o envio à API existir, qualquer mudança no D4 muda todas as versões**;
   - o texto da vaga não vai ao painel (ADR-024 D4), link é proibido por lint, e erro sai do catálogo pelo `code` (ADR-025).
10. **A autenticação segue o ADR-004, com as emendas do HITL-035 e da revisão da F1-AUTH-00:**
    - **isolamento:** o token fica só no Service Worker; o painel nunca lê `storage` nem recebe token; o extrator nunca recebe nada da sessão;
    - **contratos:** são os de `@trampo/contracts/auth` (`47abd8c`). Mudar a forma de um deles exige a mutação do `auth.test.ts` de novo e o DOC-01. O teto do token sai só do `ACCESS_TOKEN_MAX_CHARS`, e o `test/access-token-ceiling.test.ts` (07a) prova que a API não guarda mais nenhum literal 8192 para ele;
    - **no BFF:** o GoTrue recebe `{ auth_code, code_verifier }`, sem nova tentativa com `code`. O 404 só é recusa (401) com o corpo JSON do GoTrue; sem esse corpo, dá 503. O `error_code` nunca sai da API nem vai a log;
    - **no envelope (07b):** `aead-envelope` por finalidade, com o prefixo de AAD terminando em `:<versão>:`; base64url canônica no `open`; `kid` em `[a-z0-9]{1,16}` preso à regex do contrato; texto claro até 768 **bytes**, e o excesso não é selado. O formato `s1` da pretensão é provado por vetor gravado: quem mexer no `aead-envelope` roda o `salary-cipher.test.ts`. O `expiresIn` é inteiro, e menor que 1 dá 503 (07f). Os dois anéis nunca dividem material de chave, e o boot recusa (07g);
    - **cabeçalhos de saída ao GoTrue (07c):** lista fechada em `GOTRUE_CLIENT_POLICY.outboundHeaders` (`apikey`, `content-type`, `accept` e, só no logout, `authorization`). A interface do adapter não recebe cabeçalho; nunca `X-Forwarded-For`, `X-Real-IP`, `Forwarded` nem cabeçalho do cliente, e o simulado prova isso. Quem mexer no adapter roda a mutação dirigida de novo;
    - **logout repetido (07h):** o GoTrue real responde 403 `session_not_found`; só esse `error_code` exato vira sessão encerrada. Quem mexer no `logoutFor403` roda os mutantes C1 a C5 do `mut07h.py` (scratchpad da sessão 7; catálogo no SESSION-LOG);
    - **porta do GoTrue (07c):** nunca rejeita; o `signal` opcional limita a nova tentativa do `RefreshSession` a 2 s. O mapa dos motivos para 401, 503 ou 204 é dos casos de uso (07f), não do adapter;
    - **verificador (07d):** o `keysReady()` usa só o cache do `RemoteJWKSet`. O `amr` exige todo método na lista. Quem assinar token de teste usa o `supabaseClaims`, que já traz `amr` oauth. Desde o 07f, o `ok` também traz `lifetime { issuedAt, expiresAt }`, fora do `Principal`: quem montar verificador falso precisa dele (o `test/auth-fakes.ts` tem o `TEST_LIFETIME`);
    - **contenção (07e):** os casos de uso chamam o GoTrue só por `GotrueEgress.run`, e há um só por processo, montado no `composeAuth` (07g). O orçamento da partição `troca` é 14 por 300 s: um teste com mais de 14 trocas que chegam ao GoTrue recebe 503 a partir da 15ª;
    - **casos de uso (07f):** a rota só traduz o resultado; regra nova entra no caso de uso, não na rota;
    - **borda e rotas (07g):**
      - `EXTENSION_ONLY_ROUTES` e `ORIGIN_REQUIRED_ROUTES` comparam o caminho cru **e** o padrão casado; a `EXTENSION_ROUTES`, só o cru. Quem mexer no `cors.ts` ou no `PUBLIC_ROUTES` roda de novo os mutantes M-15 do `mut07g.py` (no scratchpad da sessão 6; o catálogo está no SESSION-LOG);
      - o handler ainda recusa sem `Origin` e sem principal, como segunda trava, mas a prova da borda exige 0 chamadas ao limitador;
      - as linhas `auth_*` são amostradas, e a única chave nova da allowlist é `suprimidas`. Mensagem nova de auth entra no `AUTH_LOG_MESSAGES` e no `LOG_MESSAGES`, e o teste prende os dois;
    - **envio à API (F1-EXT-04 parte 2):** quando virar trilha, só envia com `consent.isGranted()` e com sessão, e um teste prova isso. O `source` leva `platform` e `extractorVersion`, a base do monitoramento dos seletores (spike-metrics §3.4 e §3.5).
11. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/` por script (o `auth.ts` é a §4.8 e o `index.ts` a §4.9), e a §9 ganha uma linha.
12. **E2E com fixture real:** cada teste de plataforma usa uma URL própria (o `clickAction` acha a aba pela URL), e a rota serve o CSS pelo nome do arquivo. Intermitência de `sem_acesso` vai para o QA-04.
13. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.
14. **Job `db` e gitleaks (07h):**
    - o `test:db` tem dois grupos; teste novo que esvazie um balde do GoTrue vai para o grupo `db-limite`, depois do resto;
    - fixture com material de chave do refresh é montada em tempo de execução (`${...}` no meio): a regra `trampo-auth-seal-keys` pega `AUTH_REFRESH_SEAL_KEYS` seguido de `kid:` e 32+ caracteres, também na linha de baixo. Nenhum `.pem` nem `signing_keys.json` entra no git;
    - regra nova no `.gitleaks.toml` passa pelo leitor do `@trampo/ci-policy`, que recusa allowlist, `entropy` e chave desconhecida dentro de uma regra própria.
15. **Auth na extensão (05a-1):**
    - o `@trampo/contracts/auth` só entra em `src/auth`, `src/api` e `test/` (lint e depcruise). O `background.ts` também fica de fora: ele só importa `src/auth`. Constante que o painel precisa (como `AUTH_PROVIDERS`) vai para o `protocol.ts`, nunca para `src/auth`;
    - quem mexer no `parseAuthRedirect`, no `pkce.ts` ou no `authorize-url.ts` roda de novo o `mut05a1.py` (scratchpad da sessão 8; catálogo no SESSION-LOG). O retorno é dado hostil: nenhum texto dele vai a log ou ao painel;
    - regra nova de depcruise na extensão ganha prova negativa por fixture temporária, com o hash dos arquivos restaurados conferido.
16. **Sessão guardada e `api-client` (05a-2):**
    - a sessão só é lida e gravada pelo `authSessionStore` (`src/auth/session-schema.ts`). Quem mexer no `StoredSessionSchema` ou no `api-client` roda de novo o `mut05a2.py` (scratchpad da sessão 9; catálogo no SESSION-LOG);
    - toda chamada à API sai pelo `createApiClient(...).post`, que nunca rejeita. Rota nova entra no `Map` do `api-client` com o Bearer, o schema e o teto, e ganha teste de "caminho fora" com os corpos válidos das outras rotas (o M-07a da 1ª rodada só morreu assim);
    - no 05a-3, o D11.3 lê `sem_resposta` como "sem resposta HTTP" (uma nova tentativa sequencial em 2 s) e `resposta_ilegivel` como resposta HTTP (sem nova tentativa). O corpo volta em texto: o `auth-service` valida com o `AuthSessionResponseSchema` e o `ApiErrorSchema`;
    - `fetch` fora do `api-client` derruba o lint, inclusive por `globalThis.fetch` e por desestruturação.
17. **`auth-service` (05a-3):**
    - quem mexer no `auth-service.ts` ou no `auth-code-source.ts` roda de novo o `mut05a3.py` (scratchpad da sessão 10; catálogo no SESSION-LOG) e mantém um teste `D12 | …` por linha do SW na tabela (CA-14);
    - o 401 só apaga a sessão com o `ApiError` `NAO_AUTENTICADO` da API. Nunca ligue o "apagar" a um status sozinho (T30);
    - os testes do `auth-service` usam um crypto determinístico: o `crypto.subtle` real do Node resolve fora das microtarefas e deixa os testes de corrida intermitentes.
18. **SW e manifesto (05a-4):**
    - quem mexer no `web-auth-flow-source.ts`, no `worker-auth.ts`, no `build-env.ts`, no `wxt.config.ts` ou no bloco B2 do `eslint.config.js` roda de novo o `mut05a4.py` (scratchpad da sessão 11; catálogo no SESSION-LOG);
    - o `browser.identity` só existe no adapter. A contingência C1 do D14 (relay pelo painel) pediria exceção escrita ao lint e HITL próprio;
    - as regras `no-restricted-*` do `eslint.config.js` não se acumulam entre blocos: cada bloco do B2 repete a lista inteira com a sua exceção. Regra nova entra no `workerRules`/`workerSelectors` e ganha fixture em `test/worker-modules-lint.test.ts`;
    - permissão nova ou variável de build nova passa pelo `manifest.test.ts`, que faz os dois builds próprios (fechado e completo). Nenhuma chave entra no git: o teste gera a sua;
    - desde o 05b-1, o `createWorkerAuth` liga o `emit` ao canal da sessão e devolve o `attach(port)`; o `view()` não sai da composição.
19. **Painel e sessão (05b-1):**
    - quem mexer na sessão ou nas mensagens do `protocol.ts`, no `session-channel.ts`, no `worker-port.ts`, no `panel-csp.ts`, no bloco B1 do `eslint.config.js` ou no fecho do `manifest.test.ts` roda de novo o `mut05b1.py` (scratchpad da sessão 13; catálogo no SESSION-LOG). Os mutantes BG-01 a BG-03 rodam pelo E2E e pedem o Edge;
    - a `SessaoView` só sai do SW pelo `toSessaoView`, no canal da sessão. Campo novo nela, ou texto livre numa mensagem nova, passa pelo `[APPSEC]` (B6);
    - o bloco B1 repete as listas do B2. Regra nova do painel entra no `panelRules` e ganha fixture em `test/worker-modules-lint.test.ts`, nos 3 caminhos do painel;
    - a meta do B4 só sai no `mode` `production`. Uma página HTML nova na extensão recebe a meta pelo mesmo plugin, e o `manifest.test.ts` hoje exige que o `sidepanel.html` seja a única página;
    - o `panel-state` já guarda a `sessao`, e o 05b-2 acrescentou o resto da lógica da sessão (item 20);
    - a cópia de trabalho mistura CRLF e LF (`core.autocrlf`). Script com trecho multilinha segue o fim de linha de cada arquivo, contado por Python, porque o Git Bash esconde o CR.
20. **Estado e textos da sessão (05b-2):**
    - quem mexer na sessão do `panel-state.ts` ou do `texts.ts` roda de novo o `mut05b2.py` (scratchpad da sessão 14; catálogo no SESSION-LOG). Ação nova do redutor entra também na lista do teste de invariante (a busca em largura do `panel-session.test.ts`), que prova que o "entrando" e o `pediuSair` nunca valem juntos;
    - o `ENTRANDO_TETO_MS` fica preso ao `loginDeadlineMs` + 10 s por teste: mudar o prazo do login no SW muda os dois;
    - o redutor ignora o clique que a tela não oferece. No 05b-3, o App renderiza só os botões do `sessionActions` e só posta a mensagem no clique de um botão visível. O `agora` vem do relógio do App, e o tique vem de um *timer* armado enquanto o `entrandoDesde` não for `null`;
    - o "Reconectar" volta ao `INITIAL_PANEL_STATE`. O App abre uma porta nova, manda um `hello` novo e ignora a porta antiga, que já caiu. Nenhum laço automático (condição 3 do `[APPSEC]`);
    - o texto da `porta_fechada` no `describeConnection` ainda diz "Feche e abra o painel de novo": o 05b-3 troca o texto junto com o botão "Reconectar";
    - o `api` do `analyzeBlock` é `false` até a F1-EXT-04 parte 2. Só o SW sabe da origem da API, então a fonte do `api` passa pelo `[APPSEC]` (B6);
    - texto novo da sessão passa pelo teste de "nenhum link, nenhum `<` ou `>`" e, se aparecer com a sessão aberta, pelo de "nenhuma conta nem provedor".

---

## Próximo prompt (sessão nova)

```text
Equipe, sigam em ciclo estrito de DevSecOps. Trilha F1-EXT-05b, commit 05b-3 (botões, "Reconectar" e E2E do painel; ADR-004 §6.3 item 4), sem gastar cota e sem chamar o Supabase real. Push do spike/s1-extraction só com autorização no prompt (HITL-037).

1. [ORCHESTRATOR]: leiam o STATE.md (bloco "Trilha F1-EXT-05b", com o 05b-2 concluído em c61f50d) e rodem git fetch para ver se o branch recebeu commits no GitHub. Leiam o ADR-004 D12 ("UI", "Emenda do 05b-1" e "Emenda do 05b-2"), a CA-16, o §6.3 item 4 e o ADR-025 D3 a D6.
2. [ARCHITECT] + [APPSEC]: desenhem o 05b-3 no React, sem lógica nova fora do src/panel: os botões saem do sessionActions, o texto do describeSession, o "Analisar" do analyzeBlock (api false), o relógio e o tique do "entrando", e o "Reconectar" (novo runtime.connect e novo hello, só por clique, ignorando a porta antiga), com o texto da porta_fechada trocado junto. Condição 3 do [APPSEC]: nenhum laço automático.
3. [DEV] + [QA_EVALS]: E2E do painel com a porta falsa (mensagens exatas enviadas, o texto de cada SessaoView, o "entrando", o "Tentar sair de novo" e o "Reconectar" refazendo o handshake), o E2E local inteiro (CA-16: navegador, versão, modo do P20 e contagens no SESSION-LOG), 100% de cobertura na lógica, mutação dirigida do que couber, turbo em série e depcruise. Emenda do ADR-025 D4 e D5. Com o commit, a F1-EXT-05b fecha: avaliem o peso da sessão antes de seguir para a F1-EXT-05c (AGENTS §4.4).
4. [SCRIBE]: atualizem o STATE a cada commit. No fim, atualizem o SESSION-LOG, o BACKLOG e o next-step, mantendo a tabela de trilhas. Commit atômico; push só se autorizado.
```
