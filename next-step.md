# Próximo passo: F1-EXT-05a (Service Worker e manifesto da autenticação) numa sessão nova

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie o prompt do fim deste arquivo. Não há HITL aberto para a trilha.

## O que acabou de ser entregue (2026-11-07, sessão 7)

### F1-API-07, commit 07h (`4efd96c`): contrato no job `db` e regra do gitleaks
- **Pilha local espelhando a produção:**
  - `supabase/config.toml` com `jwt_expiry = 900` e `signing_keys_path = "./signing_keys.json"`;
  - a chave ES256 nasce no próprio job `db`, antes do `supabase start` (`apps/api/test/db/support/write-signing-key.ts`: JWK P-256 com `kid` aleatório, `wx` e modo 0600, só com o nome `signing_keys.json`). Nunca versionada: `.gitignore` e regra do gitleaks;
  - o `@trampo/ci-policy` prende a ordem "chave antes do start", o `config.toml` (900 s, chave, rotação, reuso de 10 s, limites 150 e 30) e o `.gitignore`.
- **Contrato** (`apps/api/test/db/auth-contract.db.test.ts`, só no job `db`):
  - o token sai com `alg` ES256 e o `kid` do job, e o JWKS público não tem `d` nem `k`;
  - `expires_in` 900 e `exp − iat` 900 no `JoseAccessTokenVerifier` real;
  - `password` só com `NODE_ENV=test`; com `AUTH_ALLOWED_AMR=oauth`, **401 pela borda real** (`createAuthHook`);
  - o `GotrueTokenClient` real renova e faz logout; P10 (o pai do ativo devolve o ativo, antes e depois de 10 s; o ancestral revoga a cadeia) e P11 (o logout global derruba o refresh de todas as sessões do usuário, e não as de outro);
  - `pkce` com código desconhecido é `recusado` (404 com o corpo do GoTrue).
- **Achado, corrigido no adapter:** o GoTrue real responde **403 `session_not_found`** ao logout repetido, não 401. Só esse `error_code` exato vira sessão encerrada (204, D7 idempotente); o `bad_jwt` e o resto do 403 seguem `recusado`. O GoTrue simulado agora responde como o real.
- **Balde do `pkce` e do `/logout` (D8 item 5), pelo código-fonte do GoTrue:**
  - o `pkce` cai no balde `Token`, o mesmo da renovação, e não no `sign_in_sign_ups`; o `/logout` não tem limitador;
  - o balde `Token` tem **rajada fixa de 30**. O orçamento do 07e deixa passar 74 numa rajada: isso virou o **07j** (teto de rajada de 15 no `GotrueEgress`);
  - o limitador só roda com cabeçalho de IP configurado, e a CLI local provavelmente não configura nenhum;
  - a sonda (`apps/api/test/db/auth-rate-limit.db.test.ts`, último grupo do `test:db`) descobre o modo no GoTrue local e, se ativo, confere os baldes. Em modo inativo, o balde do projeto real fica pelo código-fonte e pelo P19.
- **Gitleaks:** `trampo-auth-seal-keys` (atribuição ao `AUTH_REFRESH_SEAL_KEYS` com material de chave literal, inclusive com o valor na linha de baixo do YAML) e `trampo-auth-seal-keys-files` (`.pem` e `signing_keys.json` pelo caminho), sem allowlist própria. O `@trampo/ci-policy` tem um leitor estrito do `.gitleaks.toml` (regex lida igual pelo RE2 e pelo V8) e varre a árvore versionada no `pnpm test`.
- **Prova local:**
  - API de 3.518 para 3.553 testes e `ci-policy` com 258, as duas com 100% nas 4 métricas;
  - mutação dirigida: 57 mutantes, 56 mortos e 1 equivalente (a flag solta `(?i)`, que o V8 já recusa). Quatro sobreviventes da 1ª rodada viraram testes;
  - turbo 21/21 em série na 1ª rodada; depcruise sem violações (480 módulos).
- **CI verde no PR #17** (a estação não tem o *daemon* do Docker, e o download do binário do gitleaks foi negado, então o contrato, a sonda e o gitleaks rodaram só lá):
  - run `42397764768` (`4efd96c`): 71 dos 72 casos do `test:db` passaram contra o GoTrue real, inclusive o P10, o P11 e o logout repetido com 403. O caso "pela borda real" falhou por erro do teste (Fastify mínimo, 500), corrigido em `316da68` com o `buildApp`;
  - run `42398183789` (`316da68`): `secrets` (regras novas no histórico inteiro, sem achado), `db` (72/72, cobertura de 100%), `test` e `quality` verdes;
  - a sonda mediu o **limitador inativo** no GoTrue local nos dois runs, e o `groupOrder` não segurou a ordem dos grupos: a sonda agora devolve o balde cheio ao terminar, em modo ativo.
- **Remoto:** o branch tinha o `47db338` (agente Copilot), que libera na allowlist do gitleaks um UUID de fixture falsa; o `[APPSEC]` aceitou, e os commits locais entraram por *rebase* (o 07h passou de `7962d4f` a `4efd96c`).
- **Cofre:** ADR-004 §4.3, §4.8, D7 e D8 item 5 ("Emenda do 07h") e a marca no §6.3; ADR-019 §3.4 novo; runbook `auth-extensao` §1.6 novo; STATE, BACKLOG e SESSION-LOG, com backups no scratchpad.
- Nada chamou o Supabase real nem provedor de LLM.

### Pendências do humano
- Nenhum HITL aberto para as trilhas.
- **Vale desde o 07h:** quem rodar `supabase start` na estação precisa gerar a chave antes, com `node apps/api/test/db/support/write-signing-key.ts supabase/signing_keys.json` na raiz do `trampo.app` (runbook `auth-extensao` §1.6). Sem o arquivo, o `start` não sobe.
- **Vale desde o 07g:** fora de `NODE_ENV=test`, a API só sobe com `API_BEHIND_PROXY=false` (junto com `TRUST_PROXY=false`) e o anel `AUTH_REFRESH_SEAL_KEYS` e `AUTH_REFRESH_SEAL_ACTIVE_KEY` no `apps/api/.env` (runbook `auth-extensao` §1.5).
- Push autorizado nesta sessão e feito: o `spike/s1-extraction` está no `origin` com o 07h, a correção e este arquivo.
- **Antes de cada push:** `git fetch` e confira `HEAD..origin/spike/s1-extraction`. O branch pode receber commits no GitHub entre sessões.

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM nem chama o Supabase real. A API chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **F1-EXT-05a → F1-EXT-05b → F1-EXT-05c → F1-SEC-01** (**próxima: F1-EXT-05a**) | Resto do ADR-004, uma trilha por vez: Service Worker e manifesto (com `auth` no `CONTRACTS_ALLOWED` e o painel proibido de importá-lo), painel, E2E com IdP falso e threat model v2 | não | nada para a F1-EXT-05a (o 07h a liberou); as seguintes esperam a anterior |
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

---

## Próximo prompt (sessão nova)

```text
Equipe, sigam em ciclo estrito de DevSecOps. Trilha F1-EXT-05a (Service Worker e manifesto da autenticação, ADR-004 §6.3 item 3), sem gastar cota e sem chamar o Supabase real. Push do spike/s1-extraction só com autorização no prompt.

1. [ORCHESTRATOR]: leiam o STATE.md (bloco "HITL-036 fechado e Trilha F1-API-07 em andamento", com o 07h) e confiram no PR #17 (gh, só leitura) se os jobs secrets e db do 4efd96c passaram. Se algum falhou, a sessão começa pelo conserto. Se a sonda imprimiu "[sonda do limite por IP]", registrem o modo no ADR-004 D8 item 5. Leiam o ADR-004: D3, D9 a D13, §4.1, §4.5, §4.6, §4.8 e §4.10 (CA-01 e o P3), e os ADR-024 e ADR-025 na parte do Service Worker e do painel.
2. [ARCHITECT] + [APPSEC]: desenhem a F1-EXT-05a: src/auth/** e src/api/api-client.ts no Service Worker (fluxo do D3 com launchWebAuthFlow, PKCE S256, state, storage.session, renovação sem paralelo e logout local primeiro), manifesto (identity e key, D13), auth no CONTRACTS_ALLOWED só para o SW, lint B2 e depcruise que proíbem o painel e o extrator de importar src/auth. O token nunca sai do SW (D10).
3. [DEV] + [QA_EVALS]: TDD com 100% de cobertura em apps/extension/src/{auth,api}/**, mutação dirigida, manifest.test.ts e o grep do artefato. Turbo em série e depcruise. Ao fim, avaliem o peso da sessão: se leve, sigam para o 07i ou o 07j (um só); se pesada, parem e reciclem (AGENTS §4.4).
4. [SCRIBE]: atualizem o STATE a cada commit. No fim, SESSION-LOG, BACKLOG e o next-step mantendo a tabela de trilhas. Commit atômico; push só se autorizado.
```
