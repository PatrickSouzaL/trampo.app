# Próximo passo: F1-API-07, commit 07c (porta e adapter do GoTrue) numa sessão nova

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie o prompt do fim deste arquivo. Não há HITL aberto para a trilha.

## O que acabou de ser entregue (2026-11-07)

### HITL-036 fechado (declarado pelo humano)
- **Item 1:** P6 aprovado. O Site URL virou A durante a parte 3 do HITL-035, o que explica o caso E original; E e F refeitos foram bloqueados ou caíram na raiz do nosso host.
- **Item 2:** excedentes apagados e novos cadastros desligados. O residual "cadastro aberto" fechou.
- **Item 3:** P19 fixado em 150 (renovação) e 30 (login) por 5 min por IP. As outras anotações não vieram: a ressalva de evidência do P8 e o `code_e_uuid` ficam para o spike S-3.
- **Item 4:** risco do `.pem` no Drive aceito para o MVP. O par novo em *cold storage* antes da loja virou o `BACKLOG#PRE-LOJA-01`.
- **Item 5:** os 4 runbooks foram apagados de propósito, e o `RATE_KEY_PEPPER` e a mitigação do T30 foram realocados fora do cofre.
- **"ADR-004 aceito":** a declaração ficou registrada no frontmatter, mas o status formal segue `proposto`. O §4.10 define o aceite como o fechamento do F1-EXT-05, e o veto do `[APPSEC]` no §3 continua em duas condições que o HITL-036 não cobre:
  - **P3:** sem `host_permissions`, provado só no manifesto da F1-EXT-05a;
  - **P18:** o hook da F1-DB-02.

  Se você quiser o `aceito` formal agora, diga, e a sobreposição do veto fica registrada.

### Trilha F1-API-07: partição e 2 de 8 commits
- **Partição (ADR-004 §6.3), com o `[APPSEC]` sem veto e 3 condições:**
  - nenhuma rota pública antes do 07g;
  - lista fechada de cabeçalhos de saída ao GoTrue, provada no simulado;
  - o balde do `pkce` e do `/logout` só se prova no GoTrue local do 07h. Um simulado só repetiria a hipótese.
- **07a (`c51b809`):** os 3 literais `8_192` viraram o `ACCESS_TOKEN_MAX_CHARS` do contrato. Um teste varre o `src/` da API. Mutação 8/8.
- **07b (`905d85f`):**
  - `aead-envelope` por finalidade;
  - `salary-cipher` sobre ele, com o `s1` provado por vetor gravado;
  - porta `RefreshSealer` e adapter `r1` (AAD com o `Origin`, teto de 768 bytes);
  - `auth-session-env` com anel, idade máxima e inatividade em falha fechada;
  - 4 variáveis sem valor no `.env.example`;
  - **achado corrigido antes do commit:** o prefixo de versão do envelope não entrava na tag. Agora o prefixo de AAD termina em `:<versão>:`;
  - mutação 23/23, com o M-12.
- **Prova:**
  - API de 2.903 para 2.991 testes, com 100% nas 4 métricas;
  - turbo 21/21 em série e depcruise sem violações;
  - o gitleaks não está instalado nesta estação, e a revisão dos literais novos foi manual.
- **Cofre:**
  - emendas do ADR-013 D3 e do ADR-018 D4, marcadas no ADR-004 §6.1;
  - STATE, HITL-QUEUE, BACKLOG e SESSION-LOG atualizados;
  - backups no scratchpad.
- Nada chamou o Supabase real nem provedor de LLM, e o comportamento da API não mudou.

### Pendências do humano
- Nenhum HITL aberto para as trilhas.
- Opcional: confirmar se quer sobrepor o veto do §3 e marcar o ADR-004 como `aceito` antes do P3 e do P18.
- O push continua não autorizado. O `spike/s1-extraction` tem vários commits locais, agora também o `c51b809` e o `905d85f`.

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM nem chama o Supabase real. A API chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **F1-API-07 (07c → 07h)** | BFF do ADR-004 (D4 a D8), na partição do ADR-004 §6.3. Feitos: 07a (`c51b809`) e 07b (`905d85f`). Faltam, um commit por vez: **07c** porta e adapter do GoTrue com o simulado em socket real e a lista fechada de cabeçalhos de saída; **07d** `keysReady()` e `amr` (ADR-013); **07e** limitador local pré-JWT, orçamento de saída e *bulkhead* (ADR-014 D10); **07f** `ExchangeSession`, `RefreshSession` e `EndSession`; **07g** rotas e borda, com a leitura do anel no boot; **07h** contrato no job `db` (§4.3) e regra do gitleaks | não | nada |
| **F1-DB-02** | Custom Access Token Hook por migration (ADR-004 D5): recusa com 403 a sessão com mais de 24 h, grants mínimos e `test:db` da recusa na emissão e na renovação. Depois, HITL de aplicação no projeto real (molde do HITL-023) | não | nada; precisa entrar antes do aceite do ADR-004 |
| **F1-EXT-05a → F1-EXT-05b → F1-EXT-05c → F1-SEC-01** | Resto do ADR-004, uma trilha por vez: Service Worker e manifesto (com `auth` no `CONTRACTS_ALLOWED` e o painel proibido de importá-lo), painel, E2E com IdP falso e threat model v2 | não | a trilha anterior (a F1-EXT-05a espera a F1-API-07) |

**O que vem depois:**
- **F1-API-07 concluída:** começa a F1-EXT-05a.
- **F1-EXT-05a concluída:** o envio à API (F1-EXT-04 parte 2) vira trilha.
- **HITL-036:** fechado em 2026-11-07 (P6 aprovado). O spike S-3 não depende mais dele.
- **F1-DB-02 concluída:** abre o HITL de aplicação do hook.
- **Spike S-3 completo (P1 a P20):** depois das F1-EXT-05x e da F1-DB-02. Depois dele, o aceite formal do ADR-004 (o veto do §3 segue em P3 e P18).
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
    - **contratos:** são os de `@trampo/contracts/auth` (`47abd8c`). Mudar a forma de um deles exige a mutação do `auth.test.ts` de novo e o DOC-01. O teto do token sai só do `ACCESS_TOKEN_MAX_CHARS`, e o `test/access-token-ceiling.test.ts` (07a) prova que a API não guarda mais nenhum literal 8192 para ele;
    - **no BFF:** o GoTrue recebe `{ auth_code, code_verifier }`, sem nova tentativa com `code`. O 404 só é recusa (401) com o corpo JSON do GoTrue; sem esse corpo, dá 503. O `error_code` nunca sai da API nem vai a log;
    - **no envelope (feito no 07b):** `aead-envelope` por finalidade, com o prefixo de AAD terminando em `:<versão>:`; base64url canônica no `open`; `kid` em `[a-z0-9]{1,16}` preso à regex do contrato; texto claro até 768 **bytes**, e o excesso não é selado. O formato `s1` da pretensão é provado por vetor gravado: quem mexer no `aead-envelope` roda o `salary-cipher.test.ts`. O `expiresIn` é inteiro, e menor que 1 dá 503 (07f);
    - **cabeçalhos de saída ao GoTrue (07c):** lista fechada (`apikey`, `content-type`, `accept` e, só no logout, `authorization`). Nunca `X-Forwarded-For`, `X-Real-IP`, `Forwarded` nem cabeçalho do cliente, e o simulado prova isso;
    - **boot (07g):** o anel do refresh, as idades, o `amr` e o `API_BEHIND_PROXY` são lidos em falha fechada, e o boot recusa chave repetida entre o anel da pretensão e o do refresh;
    - **envio à API (F1-EXT-04 parte 2):** quando virar trilha, só envia com `consent.isGranted()` e com sessão, e um teste prova isso. O `source` leva `platform` e `extractorVersion`, a base do monitoramento dos seletores (spike-metrics §3.4 e §3.5).
11. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/` por script (o `auth.ts` é a §4.8 e o `index.ts` a §4.9), e a §9 ganha uma linha.
12. **E2E com fixture real:** cada teste de plataforma usa uma URL própria (o `clickAction` acha a aba pela URL), e a rota serve o CSS pelo nome do arquivo. Intermitência de `sem_acesso` vai para o QA-04.
13. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

---

## Próximo prompt (sessão nova)

```text
Equipe, sigam em ciclo estrito. Trilha F1-API-07, commit 07c (porta e adapter do GoTrue), sem gastar cota e sem chamar o Supabase real.

1. [ORCHESTRATOR]: leiam STATE.md (bloco "HITL-036 fechado e Trilha F1-API-07 em andamento"), o ADR-004 §6.3 (partição 07a a 07h e as condições do [APPSEC]), D4 ("Peças novas" e os passos do GoTrue), D7 (mapa de erros e a emenda do 404), D8 item 5, §4.2 (GoTrue simulado) e §4.7 (M-13), e o ADR-018 D5. Confiram que 07a (c51b809) e 07b (905d85f) estão no branch.
2. [ARCHITECT] + [APPSEC]: 07c = porta application/ports/auth-token-gateway.ts (exchangePkce, refresh e logout; { ok: true, tokens } ou { ok: false, reason: "recusado" | "nao_recebido" | "pode_ter_rotacionado" }; nunca rejeita) e adapter infrastructure/supabase/gotrue-token-client.ts, sem SDK, no molde do postgrest-user-client: recusa sb_secret_ e eyJ; URL fixa de SUPABASE_URL; redirect "error", 5 s, 32 KiB, sem retry; corpo { auth_code, code_verifier }; projeção de { access_token, refresh_token, expires_in, token_type }; 404 só é "recusado" com o corpo JSON do GoTrue e error_code string; o error_code nunca sai nem vai a log; lista fechada de cabeçalhos de saída, nunca X-Forwarded-For, X-Real-IP, Forwarded ou cabeçalho do cliente. GoTrue simulado em socket real (test/support/fake-gotrue.ts, QA-02, prazos de socket-deadlines.ts) que registra os cabeçalhos recebidos, aceita só { auth_code, code_verifier } e dá 400 para "code", responde 404 { error_code: "flow_state_not_found" } no reuso, e parametriza 400/401/403/404/422.
3. [DEV] + [QA_EVALS]: TDD, 100% de cobertura, mutação M-13 (pode ter rotacionado → não recebido; 404 sem corpo → recusado) e mutantes dirigidos (cabeçalho repassado, projeção por spread, redirect seguido), turbo em série e depcruise. Emenda do ADR-018 D5 marcada no ADR-004 §6.1. Se a sessão ainda estiver leve depois do commit, sigam para o 07d (keysReady e amr); senão, parem e reciclem (AGENTS §4.4).
4. [SCRIBE]: STATE a cada commit; no fim, SESSION-LOG, BACKLOG e o next-step reescrito mantendo as trilhas. Commit local, sem push.
```
