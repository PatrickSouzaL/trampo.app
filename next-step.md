# Próximo passo: F1-EXT-05a, commit 05a-2 (sessão guardada e api-client) numa sessão nova

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie o prompt do fim deste arquivo. Não há HITL aberto para a trilha.

## O que acabou de ser entregue (2026-11-07, sessão 8)

### F1-EXT-05a: partição e commit 05a-1 (`78be3f2`)
- **Partição** (ADR-004 §6.3 item 3), um commit por vez:
  - **05a-1** (feito): funções puras do fluxo e fronteiras de import;
  - **05a-2:** `session-schema.ts` e `src/api/api-client.ts` (B9), com a regra "`fetch` só no `api-client`";
  - **05a-3:** `auth-service.ts` (login do D3, renovação com *single-flight* e geração, logout local primeiro, linhas do D12 como testes nomeados);
  - **05a-4:** `web-auth-flow-source.ts`, ligação no `background.ts`, `wxt.config.ts` (`identity`, `key`, `TRAMPO_SUPABASE_ORIGIN`) e `manifest.test.ts` (CA-01).
- **P3:** a prova em runtime (login completo com o manifesto do D13) exige o IdP falso e vai para o primeiro E2E da F1-EXT-05c. O 05a-4 prova a parte estática (CA-01). A condição do veto do ADR-004 §3 não muda.
- **O 05a-1** (`apps/extension/src/auth/`):
  - `pkce.ts`: verifier de 32 bytes e `state` de 16, em base64url; S256 por `crypto.subtle`, que, se faltar, faz o login lançar (nunca `plain`); entropia injetável;
  - `authorize-url.ts`: os 4 parâmetros exatos e codificados, `s256`, `redirect_to` com `?st=<state>`, nenhum `response_type`, origem https exata ou lança;
  - `redirect.ts`: `parseAuthRedirect` em falha fechada (`ok`, `cancelado` ou `recusado`). A base é comparada byte a byte, o que recusa também a raiz do Site URL da opção A; o fragmento só aceita o erro do IdP; o `error` nunca é ecoado; a query só aceita `code` e `st`.
- **Fronteiras:**
  - `AUTH_PROVIDERS` no `protocol.ts`, só a constante;
  - `@trampo/contracts/auth` só em `src/auth`, `src/api` e `test/`, com o lint provado por fixtures negativas;
  - 4 regras novas no depcruise (`extension-panel-no-auth`, `extension-capture-no-auth`, `extension-auth-only-from-worker`, `extension-contracts-auth-only-auth-and-api`), provadas por 9 fixtures temporárias (13 violações).
- **Prova local:**
  - extensão de 180 para 257 testes, 100% nas 4 métricas com `src/auth/**` e `src/api/**` na cobertura;
  - mutação 29/29 (`mut05a1.py`, catálogo no SESSION-LOG). Dois equivalentes da 1ª rodada viraram simplificação do código;
  - turbo 21/21 em série na 1ª rodada, sem cache; depcruise sem violações (486 módulos).
- **Cofre:** ADR-004 §6.3 item 3 (partição e P3), STATE (bloco novo da F1-EXT-05a), BACKLOG (F1-EXT-05) e SESSION-LOG, com backups no scratchpad.
- **Remoto:** o PR #17 foi mergeado no `master` (`ac4e517`). Os commits desta sessão foram ao `origin/spike/s1-extraction` e pedem um **PR novo** para o `master`.
- Nada chamou o Supabase real nem provedor de LLM.

### Pendências do humano
- Nenhum HITL aberto para as trilhas.
- **Vale desde o 07h:** quem rodar `supabase start` na estação precisa gerar a chave antes, com `node apps/api/test/db/support/write-signing-key.ts supabase/signing_keys.json` na raiz do `trampo.app` (runbook `auth-extensao` §1.6). Sem o arquivo, o `start` não sobe.
- **Vale desde o 07g:** fora de `NODE_ENV=test`, a API só sobe com `API_BEHIND_PROXY=false` (junto com `TRUST_PROXY=false`) e o anel `AUTH_REFRESH_SEAL_KEYS` e `AUTH_REFRESH_SEAL_ACTIVE_KEY` no `apps/api/.env` (runbook `auth-extensao` §1.5).
- Push autorizado nesta sessão e feito: o `spike/s1-extraction` está no `origin` com o `78be3f2` e este arquivo. **Abrir o PR novo** do `spike/s1-extraction` para o `master` fica com o humano (ou com uma sessão em que ele o peça): o PR #17 já foi mergeado.
- **Antes de cada push:** `git fetch` e confira `HEAD..origin/spike/s1-extraction`. O branch pode receber commits no GitHub entre sessões.

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM nem chama o Supabase real. A API chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **F1-EXT-05a → F1-EXT-05b → F1-EXT-05c → F1-SEC-01** (**em andamento: F1-EXT-05a, próximo commit 05a-2**) | Resto do ADR-004, uma trilha por vez: Service Worker e manifesto (partição 05a-1 a 05a-4 no ADR-004 §6.3 item 3; 05a-1 feito em `78be3f2`), painel, E2E com IdP falso (com a prova em runtime do P3) e threat model v2 | não | nada para o 05a-2; as trilhas seguintes esperam a anterior |
| **F1-API-07 (07i e 07j)** | BFF do ADR-004 (D4 a D8), na partição do ADR-004 §6.3. Feitos: 07a (`c51b809`), 07b (`905d85f`), 07c (`86fe1ef`), 07d (`7e6c5d5`), 07e (`ac3c2c7`), 07f (`e1af5d0`), 07g (`b516fd0`) e 07h (`4efd96c`). Faltam, um commit por vez: **07i** métricas `auth_*_total` do D8 item 7 na porta `Telemetry`; **07j** teto de rajada de 15 (reposição de 0,25 por segundo) no `GotrueEgress`, somado às janelas de hoje (o balde `Token` do GoTrue tem rajada fixa de 30; ADR-004 D8 item 5, "Emenda do 07h") | não | nada; nenhum dos dois bloqueia a F1-EXT-05a |
| **F1-DB-02** | Custom Access Token Hook por migration (ADR-004 D5): recusa com 403 a sessão com mais de 24 h, grants mínimos e `test:db` da recusa na emissão e na renovação. Depois, HITL de aplicação no projeto real (molde do HITL-023) | não | nada; o P18 (CA-15) depende dela, mesmo com o ADR-004 aceito por sobreposição do veto |

**O que vem depois:**
- **Balde do projeto real:** o GoTrue local não aplica o limite por IP, então a sonda só prova o modo. O balde do `pkce` e do `/logout` no projeto real fica para o spike S-3 (P19), pelo código-fonte até lá.
- **07i e 07j:** entram antes ou depois da F1-EXT-05a, à escolha do `[ORCHESTRATOR]`, cada um numa sessão própria.
- **F1-EXT-05a concluída:** o envio à API (F1-EXT-04 parte 2) vira trilha.
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

---

## Próximo prompt (sessão nova)

```text
Equipe, sigam em ciclo estrito de DevSecOps. Trilha F1-EXT-05a, commit 05a-2 (sessão guardada e api-client, ADR-004 §6.3 item 3), sem gastar cota e sem chamar o Supabase real. Push do spike/s1-extraction só com autorização no prompt.

1. [ORCHESTRATOR]: leiam o STATE.md (bloco "Trilha F1-EXT-05a em andamento", com a partição e o 05a-1 em 78be3f2) e rodem git fetch para ver se o branch recebeu commits no GitHub. Leiam o ADR-004: §6.3 item 3 (partição), D9 (StoredSessionSchema e onde cada segredo vive), D10 B2 e B9 (api-client), D11.1 e §4.1 (session-schema e api-client), e o §4.7 (M-07).
2. [ARCHITECT] + [APPSEC]: desenhem o 05a-2: apps/extension/src/auth/session-schema.ts (SESSION_STORAGE_KEY "trampo/sessao/v1" e StoredSessionSchema estrito, revalidado pelo sessionStore, que apaga valor adulterado) e apps/extension/src/api/api-client.ts (o único fetch da extensão: origem igual a TRAMPO_API_ORIGIN, caminhos de lista fechada, Bearer só em POST /v1/analyze e POST /v1/auth/logout, credentials "omit", redirect "error", cache "no-store", referrerPolicy "no-referrer", prazo de 10 s e teto de resposta), com a regra do lint B2 "fetch só no api-client" e fixture negativa. Nada de auth-service nem de manifesto neste commit.
3. [DEV] + [QA_EVALS]: TDD com 100% de cobertura em apps/extension/src/{auth,api}/**, mutação dirigida (M-07 e os operadores próprios, hashes restaurados), turbo em série e depcruise. Ao fim, avaliem o peso da sessão: se leve, sigam para o 05a-3 (auth-service); se pesada, parem e reciclem (AGENTS §4.4).
4. [SCRIBE]: atualizem o STATE a cada commit. No fim, SESSION-LOG, BACKLOG e o next-step mantendo a tabela de trilhas. Commit atômico; push só se autorizado.
```
