# Próximo passo: F1-EXT-05c, commit 05c-3 (provas negativas do §4.5 e o E2E que fecha a trilha), numa sessão nova

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie o prompt do fim deste arquivo. Nenhum HITL bloqueia a trilha: o HITL-037 (o PR do 4º ciclo) corre em paralelo.

## O que acabou de ser entregue (2026-11-09, sessão 17)

### F1-EXT-05c: commit 05c-2 (`8c59e5a`), roteiro nos falsos e cenários 6, 7, 8, 9, 13 e 14, com o P13
- **Sincronização:** o humano mergeou o PR #20 (`580e81e`), e o 3º ciclo do HITL-037 fechou. O `git fetch` não trouxe commit novo.
- **Roteiro nos falsos**, só pelo canal de controle (`POST /roteiro`, `strictObject`, teto de 256 bytes):
  - o próximo `authorize` válido pode segurar o 302 (`POST /soltar`), cancelar com `error_description=CANARIO-ERR-<uuid>`, mandar o código certo em `/outro`, com `#access_token=` canário ou nascido para o challenge de outro fluxo;
  - de 1 a 5 logouts respondem 503;
  - **o roteiro só age depois das barreiras** (os 4 parâmetros do `authorize`; corpo e Bearer vivo no logout, sem derrubar a sessão), e a troca nunca tem roteiro. Os falsos ficam mais hostis, nunca mais permissivos (condição 2 do `[APPSEC]`);
  - na unidade, cada retorno roteirizado passa pelo `parseAuthRedirect` real, que dá a classe pretendida.
- **E2E novos:**
  - `auth-adversarial.e2e.test.ts` (8 casos): cenário 7 (outro caminho e fragmento com 0 trocas; o código de outro challenge é o controle positivo, recusado na troca), 8 (cancelamento dá `{ false, null }`, sem o canário na tela nem no storage), 14 (2 logouts com Bearer, `{ false, SERVICO_INDISPONIVEL }` e o "Tentar sair de novo", que encerra com o mesmo Bearer) e 9 (o `sendMessage` avulso falha com e sem o ID; uma página de outra origem não enxerga o runtime, e o painel enxerga);
  - `auth-lifecycle.e2e.test.ts` (7 casos): cenário 13 (o 302 segurado e solto com o SW vivo completa o login; com sessão, o SW parado sobrevive ao "Reconectar"; com o 302 segurado, o SW parado dá `{ false, null }` e 0 trocas, mesmo com o 302 solto depois) e cenário 6 (as recargas e o reinício);
  - `test/e2e/session.ts` reúne os leitores, e o `browser.ts` ganhou o `stopWorker`, as duas recargas e o `relaunch`.
- **P13 respondido no E2E local:** o `storage.session` some na recarga (`runtime.reload()` e novo `loadUnpacked` no mesmo caminho) e no reinício do navegador, com o mesmo ID e `session`, `local`, `sync`, localStorage e IndexedDB vazios.
  - A extensão do `Extensions.loadUnpacked` não volta sozinha com o perfil relançado (Edge 157 e Chrome 156).
  - **Achado:** no Chrome 156, um `runtime.reload()` dessa extensão a deixa bloqueada até o fim do navegador, e nem um novo `loadUnpacked` a traz de volta. É limite do harness (a extensão por CDP). A forma fica numa tabela fixa por navegador no teste, e no Chrome o cenário 6 roda com o `loadUnpacked` e o reinício.
- **Prova:**
  - unidade: extensão de 1347 para 1357 testes, 100% nas 4 métricas;
  - **E2E local inteiro (CA-16):** Edge 157.0.4341.42, headless, build de produção, **modo 1 do P20**: 82/82 em 3 rodadas (login 8, adversariais 8, ciclo de vida 7, CSP 10, mensageria 11, captura 11 e painel 27). No Chrome 156.0.8078.80, login, adversariais, ciclo de vida, CSP e mensageria deram 43/43, com 1 pulado pela tabela;
  - mutação 34/34 (`mut05c2.py`, catálogo no SESSION-LOG). A 1ª execução foi interrompida pelo sistema por falta de memória no E-02; a árvore foi restaurada por bytes e conferida, e os 9 restantes rodaram em primeiro plano com a sua autorização;
  - turbo 21/21 em série, sem cache (1m48s); depcruise sem violações (519 módulos); gitleaks 8.30.1 conferido, 0 achados no histórico (174 commits).
- **Cofre:** ADR-004 (§1.4 P13, §4.4 "Emenda do 05c-2" e os cenários, §6.3 item 5), STATE, BACKLOG (F1-EXT-05 e o F1-EXT-06 novo), HITL-037 (4º ciclo) e SESSION-LOG. Os backups estão no scratchpad.
- Nada chamou o Supabase real nem provedor de LLM.

### Pendências do humano
- **HITL-037 (não bloqueia nenhuma trilha), 4º ciclo:** o push foi autorizado e feito nesta sessão (o `8c59e5a` e o commit deste arquivo, sem *force*). Falta o seu passo no runbook (`../base/03-infra-runbook/publicar-branch-pr.md` §4 a §6): abrir o PR do `spike/s1-extraction` para o `master`, conferir os 4 checks e mergear com merge commit, sem apagar o branch.
- **F1-EXT-06 (decisão antes do 1º build real, não bloqueia a 05c):** você centralizou as variáveis da extensão no `apps/api/.env`. O E2E não precisa delas, e nada mudou no build. O `[APPSEC]` não aceita carregar o `../api/.env` inteiro no build da extensão, porque poria os segredos da API ao alcance de um artefato público. As opções estão no BACKLOG: um leitor de lista fechada que tira do arquivo só as 3 chaves, com teste de que nada mais chega ao build, ou um `apps/extension/.env` só com elas.
- **Push nas próximas sessões:** só com autorização no prompt. Antes de cada push: `git fetch` e confira `HEAD..origin/spike/s1-extraction`.
- **Vale desde o 07h:** quem rodar `supabase start` na estação precisa gerar a chave antes, com `node apps/api/test/db/support/write-signing-key.ts supabase/signing_keys.json` na raiz do `trampo.app` (runbook `auth-extensao` §1.6). Sem o arquivo, o `start` não sobe.
- **Vale desde o 07g:** fora de `NODE_ENV=test`, a API só sobe com `API_BEHIND_PROXY=false` (junto com `TRUST_PROXY=false`) e o anel `AUTH_REFRESH_SEAL_KEYS` e `AUTH_REFRESH_SEAL_ACTIVE_KEY` no `apps/api/.env` (runbook `auth-extensao` §1.5).
- **Vale desde o 05a-4:** o build da extensão com login precisa de `TRAMPO_API_ORIGIN`, `TRAMPO_SUPABASE_ORIGIN` e, para o ID fixo, `TRAMPO_EXTENSION_KEY` (a chave pública em SPKI base64). Sem as duas origens, o "Entrar" dá erro interno. Nenhum valor vai ao cofre.

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM nem chama o Supabase real. A API chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **F1-EXT-05c → F1-SEC-01** (**próximo: 05c-3**) | Resto do ADR-004, uma trilha por vez. A F1-EXT-05a (`78be3f2`, `ec9c915`, `db98323` e `cd141d2`) e a F1-EXT-05b (`abafafb`, `c61f50d` e `4b1259a`) foram concluídas. **05c** (partição no §6.3 item 5): **05c-1 ✅** (`2861c6a`: IdP falso, chave efêmera, P20 no modo 1 e P3 em runtime); **05c-2 ✅** (`8c59e5a`: roteiro nos falsos e cenários 6, 7, 8, 9, 13 e 14, com o P13); **05c-3**: provas negativas do §4.5 depois de todos os cenários e o E2E que fecha a trilha. **SEC-01**: threat model v2 e revisão adversarial de auth, com o residual do chromiumapp no T48 | não | nada para a 05c; a SEC-01 espera a 05c |
| **F1-EXT-04 parte 2 (envio à API)** | Liberada pela F1-EXT-05a e pela F1-EXT-05b: portão do `consent.isGranted()` e da sessão, `accessToken()` e `onUnauthorized(1 \| 2)` do `auth-service`, SSE, `source` com `platform` e `extractorVersion`, a mensagem `analisar`, a fonte do `API_DO_ENVIO` (pelo `[APPSEC]`, B6) e os botões habilitados. O prazo, o teto e o leitor do `/v1/analyze` se decidem aqui (ponto aberto do 05a-2) | não, se os testes usarem a API falsa | nada; mexe na porta, no painel e no E2E como a 05c, então nunca roda junto com ela |
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
12. **E2E com fixture real:** cada teste de plataforma usa uma URL própria (o `clickAction` acha a aba pela URL), e a rota serve o CSS pelo nome do arquivo. Intermitência de `sem_acesso` vai para o QA-04. Ela voltou na sessão 15 (`solides-04`, 1 de 4 rodadas). Desde o 05c-1, o `clickAction` espera as abas anteriores fecharem, e o `recordScriptRejections` guarda a mensagem da rejeição do `executeScript`, sem URL: se voltar, o erro do teste traz a causa, e ela vai para o QA-04.
13. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.
14. **Job `db` e gitleaks (07h):**
    - o `test:db` tem dois grupos; teste novo que esvazie um balde do GoTrue vai para o grupo `db-limite`, depois do resto;
    - fixture com material de chave do refresh é montada em tempo de execução (`${...}` no meio): a regra `trampo-auth-seal-keys` pega `AUTH_REFRESH_SEAL_KEYS` seguido de `kid:` e 32+ caracteres, também na linha de baixo. Nenhum `.pem` nem `signing_keys.json` entra no git;
    - regra nova no `.gitleaks.toml` passa pelo leitor do `@trampo/ci-policy`, que recusa allowlist, `entropy` e chave desconhecida dentro de uma regra própria. A lista **global** aceita só valor exato, falso e ancorado, com revisão do `[APPSEC]` (ADR-019 D6);
    - **fixture com cara de chave** (base64 ou texto longo ao lado de `KEY`, `TOKEN` ou `SECRET`) é montada em tempo de execução **desde o 1º commit**. O CI só roda no PR, e o gitleaks varre o *patch* de cada commit: um achado já publicado só sai pela lista de valor exato (incidente do PR #18). Antes do push, vale rodar o gitleaks 8.30.1 conferido (release oficial, `checksums.txt`) com o comando do job `secrets` e `-v`. No 05c-1, a chave efêmera e os canários do E2E já nascem em tempo de execução, e o gitleaks conferido deu 0 achados no histórico.
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
    - a cópia de trabalho mistura CRLF e LF (`core.autocrlf`). Script com trecho multilinha segue o fim de linha de cada arquivo, contado por Python, porque o Git Bash esconde o CR.
20. **Estado e textos da sessão (05b-2):**
    - quem mexer na sessão do `panel-state.ts` ou do `texts.ts` roda de novo o `mut05b2.py` (scratchpad da sessão 14; catálogo no SESSION-LOG). Ação nova do redutor entra também na lista do teste de invariante (a busca em largura do `panel-session.test.ts`), que prova que o "entrando" e o `pediuSair` nunca valem juntos;
    - o `ENTRANDO_TETO_MS` fica preso ao `loginDeadlineMs` + 10 s por teste: mudar o prazo do login no SW muda os dois;
    - o redutor ignora o clique que a tela não oferece;
    - texto novo da sessão passa pelo teste de "nenhum link, nenhum `<` ou `>`" e, se aparecer com a sessão aberta, pelo de "nenhuma conta nem provedor".
21. **React da sessão (05b-3):**
    - quem mexer no `App.tsx`, no `Session.tsx` ou no `AnalyzeButton` roda de novo o `mut05b3.py` (scratchpad da sessão 15; catálogo no SESSION-LOG). Os mutantes `A-`, `S-` e `N-` rodam pelo E2E do painel no Edge (cerca de 1,3 min cada), e os `G-` pela unidade;
    - **a porta segue a `geracao` do redutor:** o efeito da porta depende só dela, e o teste de invariante prova que só o "Reconectar" aceito a muda. Nunca abra porta fora desse efeito nem ligue a `geracao` a mensagem, tique ou queda (o mutante G-06 é o laço automático);
    - a porta que caiu ou foi derrubada fica inativa: o painel ignora mensagem e queda dela e não a derruba de novo (`ativa` no efeito);
    - o tique (`ENTRANDO_TIQUE_MS`, 1 s) só fica armado com o "entrando" ligado e nunca posta nada ao SW;
    - o `API_DO_ENVIO` é a constante `false` do `App.tsx` até a F1-EXT-04 parte 2. A fonte dele passa pelo `[APPSEC]` (B6), porque só o SW sabe da origem da API;
    - **no E2E:** a porta falsa aceita várias conexões e a queda pelo SW (`fall`), e o relógio do "entrando" usa o `page.clock` do Playwright, instalado antes do `goto`. O SW real se para por `Target.closeTarget` no alvo `service_worker`, pela sessão CDP do navegador: é a base do cenário 13 da 05c.
22. **E2E com IdP falso (05c-1):**
    - os falsos ficam em `test/e2e/support/` e entram na cobertura de 100% da extensão. Quem mexer no `canaries.ts`, no `fake-auth.ts`, no `fake-servers.ts`, no `p20.ts` ou no `refuseFakeIdentity` do `build-env.ts` roda de novo o `mut05c1.py` (scratchpad da sessão 16; catálogo no SESSION-LOG). Os mutantes `E-` rodam pelo E2E do login e da CSP no Edge (cerca de 35 s cada);
    - os falsos sobem no `global-setup`, e os testes leem e zeram o estado só pelo `fakeControl` (canal HTTP com segredo). Cada arquivo E2E que usa o IdP falso zera o estado antes de usar. O BFF falso nunca fica mais permissivo que o real: origem exata, código de uso único, S256 conferido e Bearer só no logout (condição 2 do `[APPSEC]`);
    - **o P20 é fixo por navegador** (`p20.ts`, Edge e Chrome no modo 1). Navegador novo passa por sondagem (o `probe-p20.mjs` do scratchpad da sessão 16 é o molde) e emenda do §4.4. O modo 3 não tem código, e o `TRAMPO_E2E_FAKE_IDENTITY` derruba o build;
    - **o chromiumapp local é medido, não zerado:** o navegador pode mandar o `GET /auth?code=…` antes de abortar a navegação (ADR-004 §4.4, "Emenda do 05c-1"). Todo outro "0" do E2E tem controle positivo;
    - o storage da extensão se lê por CDP `Extensions.getStorageItems` só pela sessão anexada a uma página da própria extensão (o painel); a sessão do navegador e a de uma página comum falham;
    - o build `auth` (as duas origens e a chave efêmera) substituiu o `extWithOrigin`: o ID é o `cfg.extensionId`, e o BFF falso só fala com ele.
23. **Roteiro e ciclo de vida (05c-2):**
    - quem mexer no roteiro do `fake-auth.ts`, no 302 segurado ou no `/roteiro` e `/soltar` do `fake-servers.ts`, ou nos cenários 6, 7, 8, 9, 13 e 14, roda de novo o `mut05c2.py` (scratchpad da sessão 17; catálogo no SESSION-LOG). Os `R-` e os `H-` rodam pela unidade (segundos); os `E-`, pelo E2E no Edge (cerca de 20 s cada, e 110 s o E-02). **Rode os `E-` em primeiro plano:** a 1ª execução em segundo plano foi encerrada pelo sistema por falta de memória, e um mutante pode ficar no disco. Se isso acontecer, restaure pelos bytes do blob do `HEAD` (`git show HEAD:<arquivo>`), nunca por `git checkout`, e confira que todo trecho original está presente;
    - **o roteiro só deixa os falsos mais hostis:** ele age depois das barreiras, e a troca e a renovação nunca têm roteiro. Roteiro novo passa pelo `[APPSEC]` e ganha, na unidade, a prova de que o pedido inválido não o consome;
    - o observador de sessão (`observeSessions`) é uma 2ª porta no painel: ele confere a `SessaoView` exata de cada tentativa. O `expect.poll` não roda em `beforeAll` (use o `waitFor` de um botão);
    - **recarga e reinício:** a forma `runtime.reload()` fica numa tabela fixa por navegador no `auth-lifecycle.e2e.test.ts` (Edge sim, Chrome 156 não); navegador novo passa por sondagem (o `probe-reload.mjs` e o `probe-p13.mjs` do scratchpad da sessão 17 são o molde). Depois de uma recarga, o painel abre antes do SW (a porta acorda o SW), e o teste espera o `close` do SW antigo antes;
    - o localStorage e o IndexedDB da extensão se leem por CDP com o `storageKey` `chrome-extension://<id>/`, pela sessão do painel (`originStorage`). O 05c-3 estende isso ao CacheStorage (§4.5 item 8).

---

## Próximo prompt (sessão nova)

```text
Equipe, sigam em ciclo estrito de DevSecOps. Trilha F1-EXT-05c, commit 05c-3 (provas negativas do §4.5 depois de todos os cenários e o E2E que fecha a trilha; ADR-004 §4.5 e §6.3 item 5), sem gastar cota e sem chamar o Supabase real. Push do spike/s1-extraction só com autorização no prompt (HITL-037, 4º ciclo: o PR é do humano).

1. [ORCHESTRATOR]: leiam o STATE.md (bloco "Trilha F1-EXT-05c", com o 05c-2 em 8c59e5a) e rodem git fetch para ver se o branch recebeu commits no GitHub (e o gh pr list do branch, para saber se há PR aberto ou mergeado). Leiam o ADR-004 §4.5 (itens 1, 3, 4, 6, 7, 8 inteiro, 9 e 10, e a "Emenda do 05c-1"), o §4.4 ("Emenda do 05c-2"), a CA-04, a CA-16 e o SR-23.
2. [ARCHITECT] + [APPSEC]: desenhem as provas negativas que rodam depois de todos os cenários: o espião no painel por addInitScript (item 1), o heap snapshot do painel e da aba sem segmento de canário com 16+ caracteres (3), a rede do painel por auto-attach antes do goto (4), a aba da vaga nos mundos MAIN e ISOLATED e o storage.session recusado no ISOLATED (6 e 7), a origem da extensão sem resto com o CacheStorage (8), o console por auto-attach no SW e nas páginas (9) e o total do que os falsos receberam (10). Cada "0" com controle positivo (condição 3 do [APPSEC]).
3. [DEV] + [QA_EVALS]: implementem o 05c-3: 100% de cobertura no que for lógica, mutação dirigida nos coletores e nas provas (os E- em primeiro plano), E2E local inteiro (CA-16: navegador, versão, modo do P20 e contagens no SESSION-LOG), turbo em série, depcruise e gitleaks 8.30.1 conferido. Com ele, a F1-EXT-05c fecha e a F1-SEC-01 fica liberada.
4. [SCRIBE]: atualizem o STATE a cada commit. No fim, atualizem o SESSION-LOG, o BACKLOG e o next-step, mantendo a tabela de trilhas. Commit atômico; push só se autorizado.
```
