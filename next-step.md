# Próximo passo: F1-API-07 (BFF de troca, renovação e logout) numa sessão nova; o HITL-036 corre em paralelo

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie o prompt do fim deste arquivo. O HITL-036 não bloqueia a F1-API-07 e pode ser respondido em paralelo.

## O que acabou de ser entregue (2026-11-06)

### HITL-035 fechado com ressalvas
- **Pré-spike:** o P4, o P7 e o P8 não falharam, então o recuo do D14 não dispara. O registro por ponto está no `spike-metrics` §4.1:
  - **P4 e P7:** aprovados com ressalva, porque faltou anotar parte da saída das funções;
  - **P5:** aprovado com ressalva. O `st` voltou, mas, com o Site URL A, pode ter voltado pelo host do Site URL, e não pela allow-list. O `state` fica, e o caso é refeito no S-5;
  - **P8:** aprovado, com ressalva de evidência para o aceite. O 2º uso do código deu 404 `flow_state_not_found`; B, C e D só deram "≠ 200" (HITL-036 item 3);
  - **P6: inconclusivo.** No caso E, `host_igual` deu Falso. Com o Site URL na opção A, um retorno pelo Site URL daria Verdadeiro (o nosso host, caminho `/`). Falso também é o resultado de um código que tivesse ido ao host `aaaa…`, então a saída não separa o resultado bom do ruim;
  - **P18:** disponível no painel. O Custom Access Token Hook passa a ser condição de aceite (Q10), com a trilha nova **F1-DB-02**;
  - **P19:** 150 por 5 min por IP na renovação e 30 em sign-up/sign-in. Os tetos de saída do BFF ficam em até 14 (troca) e 74 (total no `/token`) por 300 s.
- **Desenho (ADR-004, emendas datadas):**
  - D7 sem mudança de forma: o `AuthCodeSchema` fica largo, porque o formato do código não foi anotado;
  - o `state` fica (P5), e a Q6 não foi acionada;
  - D15 com a opção A até o S-5: Site URL = `https://<id>.chromiumapp.org/`;
  - um 404 sem o corpo JSON do GoTrue vira 503, e não 401 (evita o laço de relogin);
  - critério do caso E corrigido no runbook.
- **Runbooks:** `supabase-setup`, `upstash-redis` e `regiao-custo-zero` foram apagados de propósito. As citações viraram histórico anotado.

### Trilha F1-AUTH-00: contratos do ADR-004 D7 (`47abd8c`)
- **O que entrou:**
  - `packages/contracts/src/auth.ts` com os schemas do D7, `AUTH_ROUTES` congelado e os 4 tipos `z.infer`;
  - `ACCESS_TOKEN_MAX_CHARS` (8.192) no `limits.ts`, como fonte única;
  - subpath `./auth` e reexport na raiz.
- **Fora desta trilha:**
  - `apps/api` e `apps/extension` não mudaram;
  - a troca dos 3 literais `8_192` da API fica para a F1-API-07;
  - o `CONTRACTS_ALLOWED` da extensão muda só na F1-EXT-05a.
- **Prova:**
  - contratos de 91 para 656 testes, com 100% nas 4 métricas. Os testes foram escritos por um `[QA_EVALS]` sem ver a justificativa da equipe e revistos por um segundo, cético;
  - mutação: 92 mutantes, 88 mortos e 4 equivalentes provados;
  - turbo 21/21 em série (API com 2.903 testes, extensão com 180) e depcruise sem violações;
  - `[APPSEC]` sem veto.
- **Achados da revisão, já escritos no ADR-004 para a F1-API-07:**
  - `open` do envelope com base64url canônica;
  - `expiresIn` inteiro: se der menos de 1, a resposta é 503;
  - `kid` do anel em `[a-z0-9]{1,16}`;
  - texto claro do envelope com até 768 bytes;
  - nunca `i` junto com `u` no regex do Bearer.

### Antes (ainda valendo)
- **ADR-004:** continua `proposto` até o HITL-036, a F1-DB-02, o spike completo (P1 a P20) e o aceite. O veto do `[APPSEC]` do §3 continua de pé para o aceite.
- **Trilhas D2a a D2d:** extratores `li1`, `li2`, `gu1` e `so1`. A intermitência do E2E está no QA-04.
- **Trilha W1:** `rpd` da Workers AI.
- **Trilha L1:** cadeia Groq → Workers AI → determinístico no `main.ts`. A pendência do próximo prompt (`p4`) é o `null` em `yearsExperienceMin` (spike-metrics §2.11).
- **Trilhas F e G:** captura no Service Worker e UI do Side Panel, ainda sem enviar à API.

### Pendências do humano
- **HITL-036 (aberto, não bloqueia a F1-API-07, as F1-EXT-05a/b/c nem a F1-DB-02; bloqueia o spike contra o projeto real e o aceite do ADR-004).** Detalhes em `HITL-QUEUE#HITL-036`:
  1. **O quanto antes:**
     - em Authentication → URL Configuration, confira que Redirect URLs tem uma única entrada, `https://<id>.chromiumapp.org/auth`, sem curinga nem `localhost`;
     - diga se o Site URL virou A antes ou depois da parte 3;
     - refaça os casos E e F pelo runbook `auth-extensao` §3, com o Site URL A, colando a saída inteira da `Ler-Retorno` (`destino_exato`, `host_igual`, `caminho`, `chaves_query`, `code_presente`) e o host de chegada (o nosso ID, o `aaaa…` ou outro; não é segredo);
     - critério do E: aprovado se `code_presente` for falso, ou se `host_igual` for verdadeiro com caminho `/`; reprovado se o host de chegada for o `aaaa…` (veto do `[APPSEC]` ao spike até corrigir a lista e repetir).
  2. **Novos cadastros (Q9):** em Authentication → Users, confira se o pré-spike criou usuário a mais (ex.: o Google do caso H com outro e-mail) e apague o excedente. Depois, desligue "Allow new users to sign up". No runbook, esse item ficou sem marca.
  3. **Anotações** (pode ir junto com o spike), sempre com a saída inteira das funções (runbook `auth-extensao` §5):
     - caso A (ou H): `Ler-Retorno`, `Trocar` e o status do `Sair-Global`;
     - caso G com o Google: se as chaves de erro (inclusive `error`) vieram na query ou no fragmento, e se o `st` voltou;
     - casos C e B com `code_presente` True (um teste negativo só vale com código válido), o status e o `error_code` da troca; no D, o `minutos_do_code` e o `error_code`;
     - P19: os demais limites por IP de Authentication → Rate Limits, além dos 150 e 30.
  4. **Chave privada:** o comando gravou o `.pem` em `G:\Meu Drive\trampo-chaves`. Se a pasta sincroniza com o Google Drive, apague o arquivo da lixeira e do histórico do Drive, ou gere um par novo. O par novo muda o ID. Gere-o antes de refazer o E e o F (item 1), numa pasta só local, com a privada no gerenciador de senhas, e troque juntos a Redirect URL, o Site URL, o `CORS_ALLOWED_ORIGINS` e o `TRAMPO_EXTENSION_KEY` guardado (runbook `auth-extensao` §1 e §2).
  5. **Runbooks ausentes:** também faltam `supabase-migration-real`, `supabase-local`, `github-actions` e `mcp-supabase-upstash`. Foram apagados de propósito? As instruções do `RATE_KEY_PEPPER` e a restauração do T30 precisam de um novo lugar?
- Nunca cole no chat código, token, chave ou URL de retorno: só booleanos, nomes, status e o host de chegada.
- O push continua não autorizado. O `spike/s1-extraction` tem vários commits locais, agora também o `47abd8c`. Quando quiser, autorize o push e o PR.

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM nem chama o Supabase real. A API chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **F1-API-07** | BFF do ADR-004 (D4 a D8) em commits atômicos. Começa pela troca dos 3 literais `8_192` da API pelo import de `@trampo/contracts/limits`, e segue com o `aead-envelope`/`RefreshSealer`, a porta e o adapter do GoTrue com o simulado do §4.2, os casos de uso, `keysReady()` e `amr` (ADR-013), o limitador local, o orçamento de saída, o *bulkhead*, as rotas e a borda, e o teste de contrato no job `db` (§4.3). Leva as emendas do HITL-035 e da revisão da F1-AUTH-00 | não | nada (o HITL-036 não bloqueia) |
| **F1-DB-02** | Custom Access Token Hook por migration (ADR-004 D5): recusa com 403 a sessão com mais de 24 h, grants mínimos e `test:db` da recusa na emissão e na renovação. Depois, HITL de aplicação no projeto real (molde do HITL-023) | não | nada; precisa entrar antes do aceite do ADR-004 |
| **F1-EXT-05a → F1-EXT-05b → F1-EXT-05c → F1-SEC-01** | Resto do ADR-004, uma trilha por vez: Service Worker e manifesto (com `auth` no `CONTRACTS_ALLOWED` e o painel proibido de importá-lo), painel, E2E com IdP falso e threat model v2 | não | a trilha anterior (a F1-EXT-05a espera a F1-API-07) |

**O que vem depois:**
- **F1-API-07 concluída:** começa a F1-EXT-05a.
- **F1-EXT-05a concluída:** o envio à API (F1-EXT-04 parte 2) vira trilha.
- **HITL-036 item 1 respondido:**
  - se o caso E caiu no nosso host ou sem código, o P6 fecha;
  - se caiu no `aaaa…`, vale o veto do `[APPSEC]` ao spike até corrigir a allow-list e repetir.
- **F1-DB-02 concluída:** abre o HITL de aplicação do hook.
- **Spike S-3 completo (P1 a P20):** depois das F1-EXT-05x, do HITL-036 e da F1-DB-02. Depois dele, o aceite do ADR-004.
- **S-5 (troca do Site URL, ADR-004 D15):** a página estática fica pronta antes, numa origem própria. Depois, o humano refaz pelo runbook `auth-extensao` §3 os casos A com `-ComState` (P5), E, F (anotando o `caminho`) e G. Se o `st` deixar de voltar, vale a Q6; se um código chegar a host fora da lista, vale o veto do `[APPSEC]`.

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`.
2. **Nenhuma sessão muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`** sem um HITL mandar. O próximo prompt (`p4`) carrega a linha do `null` de `yearsExperienceMin` e passa pelo aceite completo (§8.1 por efeito, §8.3 com ruído).
3. **Nenhuma trilha chama provedor.** Para testar a API à mão, lembre que ela agora gasta cota do Groq.
4. **O avaliador do S-1 tem a equivalência de nome** (`stackKey` no `score.ts`). Ninguém muda a regra sem refazer o relatório de todas as versões e o `s1-effect.json`.
5. **O critério de stack é o efeito na nota** (golden-dataset-spec §8.1), e o **§8.3 tem o ruído**. Cada aceite novo de prompt ou guard roda o `S1_MODE=effect` e, se cair mais de 2 pp, o `S1_MODE=noise`.
6. **A cadeia de produção passa pelo `composeProductionApp`.** Provedor novo ou troca de modelo exige o gate do golden dataset antes (T28).
7. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts`. O GoTrue simulado da F1-API-07 segue o mesmo padrão.
8. **Fixtures reais:** qualquer fixture nova ou alterada passa de novo pelo runbook fixtures-dom §2 a §4 e pelas emendas do §8 (script fora do repositório, varredura antes do `git add`, commit próprio). O trecho proibido precisa existir na página e não pode aparecer na raiz da vaga; o recolhido (com "ver mais" fechado) precisa entrar no texto (ADR-023 D13).
9. **O extrator é um só** (`job-extractor.ts`, ADR-023 D11 e D12):
   - a regra de descarte (D4) vale para todas as plataformas, e qualquer mudança nela passa pelo `test:browser` inteiro, com a cobertura de 100% e a mutação;
   - cada seletor de plataforma tem a sua versão (`li2` logado, `li1` público, `gu1`, `so1`); seletor novo ganha versão nova e precisa de fixture real no gate;
   - o *clamp* só deixa de cortar na própria raiz de uma versão com `verMais` (hoje só o `li2`, D13); estender isso a outra raiz passa pelo `[APPSEC]`;
   - **depois que o envio à API existir, qualquer mudança no D4 muda todas as versões**;
   - o texto da vaga não vai ao painel (ADR-024 D4), link é proibido por lint, e erro sai do catálogo pelo `code` (ADR-025).
10. **A autenticação segue o ADR-004, com as emendas do HITL-035 e da revisão da F1-AUTH-00:**
    - **isolamento:** o token fica só no Service Worker; o painel nunca lê `storage` nem recebe token; o extrator nunca recebe nada da sessão;
    - **contratos:** são os de `@trampo/contracts/auth` (`47abd8c`). Mudar a forma de um deles exige a mutação do `auth.test.ts` de novo e o DOC-01. O teto do token sai só do `ACCESS_TOKEN_MAX_CHARS`, e a F1-API-07 prova que a API não guarda mais nenhum literal `8_192` para ele;
    - **no BFF:** o GoTrue recebe `{ auth_code, code_verifier }`, sem nova tentativa com `code`. O 404 só é recusa (401) com o corpo JSON do GoTrue; sem esse corpo, dá 503. O `error_code` nunca sai da API nem vai a log;
    - **no envelope:** base64url canônica no `open`, `kid` em `[a-z0-9]{1,16}` e texto claro com até 768 bytes. O `expiresIn` é inteiro, e menor que 1 dá 503;
    - **envio à API (F1-EXT-04 parte 2):** quando virar trilha, só envia com `consent.isGranted()` e com sessão, e um teste prova isso. O `source` leva `platform` e `extractorVersion`, a base do monitoramento dos seletores (spike-metrics §3.4 e §3.5).
11. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/` por script (o `auth.ts` é a §4.8 e o `index.ts` a §4.9), e a §9 ganha uma linha.
12. **E2E com fixture real:** cada teste de plataforma usa uma URL própria (o `clickAction` acha a aba pela URL), e a rota serve o CSS pelo nome do arquivo. Intermitência de `sem_acesso` vai para o QA-04.
13. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

---

## Próximo prompt (sessão nova)

```text
Equipe, sigam em ciclo estrito. Trilha F1-API-07 (BFF de troca, renovação e logout do ADR-004), sem gastar cota e sem chamar o Supabase real.
(Se já respondi algum item do HITL-036, colo aqui: "HITL-036 item N: ...")

1. [ORCHESTRATOR]: leiam STATE.md, HITL-QUEUE (HITL-035 fechado com ressalvas, HITL-036), o ADR-004 (D4 a D9, §3, §4.2, §4.3, §4.7, §4.9, §6.1 e as emendas do HITL-035 e da revisão da F1-AUTH-00), o ADR-007, o ADR-013, o ADR-014, o ADR-018, o ADR-019 e o spike-metrics §4.1. Se houver resposta do HITL-036 acima, registrem antes de tudo; se o caso E tiver caído no host aaaa…, registrem o veto do [APPSEC] ao spike S-3 até o humano corrigir a allow-list e repetir o caso E; a F1-API-07 segue, porque não usa o projeto real.
2. [ARCHITECT] + [APPSEC]: fechem a partição da F1-API-07 em commits atômicos (AGENTS §4.1), no molde da F1-API-05, e registrem-na no ADR-004 §6.3. Ponto de partida: (a) troca dos 3 literais 8_192 da API pelo import de @trampo/contracts/limits; (b) aead-envelope e RefreshSealer, com o anel AUTH_REFRESH_SEAL_KEYS e AUTH_REFRESH_SEAL_ACTIVE_KEY lido no boot em falha fechada (kid na regex do contrato) e as duas variáveis, sem valor, no apps/api/.env.example; (c) porta e adapter do GoTrue, com o GoTrue simulado do §4.2; (d) ExchangeSession, RefreshSession e EndSession; (e) keysReady() e amr no verificador (emenda ao ADR-013); (f) limitador local pré-JWT, orçamento de saída e bulkhead, com os tetos do P19 fixados por teste (confirmem no GoTrue local do job db em que balde cai o grant_type=pkce e se o /logout conta; o adapter nunca repassa X-Forwarded-For nem X-Real-IP do cliente ao GoTrue); (g) rotas e borda (PUBLIC_ROUTES, CORS com Origin obrigatório, bodyLimit 2.048, no-store); (h) teste de contrato no job db (§4.3).
3. [DEV] + [QA_EVALS]: um commit por vez, com 100% de cobertura, a mutação do catálogo M-09 a M-17 que couber no commit, turbo em série e depcruise. Parem para reciclar a sessão quando ela ficar extensa (AGENTS §4.4).
4. [SCRIBE]: STATE a cada commit, com a emenda do ADR-004 §6.1 que o commit tocar (ADR-007, ADR-013, ADR-014, ADR-018 ou ADR-019) na mesma tarefa, marcada como aplicada no §6.1; no fim, SESSION-LOG, BACKLOG e o next-step reescrito mantendo as trilhas. Commit local, sem push.
```
