# Próximo passo: F1-API-07, commit 07d (`keysReady()` e `amr`) numa sessão nova

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie o prompt do fim deste arquivo. Não há HITL aberto para a trilha.

## O que acabou de ser entregue (2026-11-07, sessão 2)

### Veto do ADR-004 sobreposto (decisão do humano)
- O [[ADR-004-extension-auth]] passou a `aceito` antes do P3 e do P18. O `[APPSEC]` registrou a sobreposição no frontmatter, no aviso do topo e no §3, e o STATE, o BACKLOG e o HITL-036 (adendo) acompanham.
- **O que não mudou:**
  - o P3 (manifesto sem `host_permissions`, F1-EXT-05a, CA-01) e o P18 (hook, F1-DB-02, CA-15) seguem obrigatórios para fechar essas trilhas e o F1-EXT-05;
  - se um deles falhar, abre-se HITL para o status e a contingência (D14);
  - até a F1-DB-02 ser aplicada, seguem os residuais que dependem do hook: T48, sessão órfã e chave vazada junto com o `storage.session`.

### F1-API-07, commit 07c (`86fe1ef`): porta e adapter do GoTrue
- **Porta** `application/ports/auth-token-gateway.ts`:
  - métodos `exchangePkce`, `refresh` e `logout`, com `signal` opcional;
  - resultado `{ ok: true, tokens }` ou `{ ok: false, reason: "recusado" | "nao_recebido" | "pode_ter_rotacionado" }`;
  - nunca rejeita.
- **Adapter** `infrastructure/supabase/gotrue-token-client.ts`, sem SDK:
  - recusa `sb_secret_` e `eyJ`; URL fixa de `SUPABASE_URL`; `redirect: "error"`, 5 s, 32 KiB, sem retry;
  - corpo `{ auth_code, code_verifier }`;
  - projeção de 4 campos, um a um, sem *spread*;
  - o 404 só é `recusado` com o corpo JSON do GoTrue e `error_code` string, e o `error_code` nunca sai do adapter;
  - **lista fechada de cabeçalhos:** `apikey`, `content-type` e `accept` no `/token`; `apikey`, `authorization` e `accept` no `/logout`.
- **GoTrue simulado** `test/support/fake-gotrue.ts`, em socket real (QA-02):
  - registra os cabeçalhos recebidos e aceita só `{ auth_code, code_verifier }` (400 para `code`);
  - responde 404 `flow_state_not_found` no reuso, e as recusas são parametrizadas em 400/401/403/404/422;
  - rotaciona o refresh;
  - nos modos `lento` e `corta`, processa o pedido antes de perder a resposta.
- **Decisões de implementação**, registradas no ADR-004 D4 ("Emenda do 07c"):
  - entrada fora da forma dá `nao_recebido` sem rede;
  - entre as falhas do `fetch`, só a conexão que nem abriu e o redirecionamento são `nao_recebido`;
  - prazo e socket cortado são `pode_ter_rotacionado`;
  - o logout dá `ok` com 2xx ou 401.
- **Prova:**
  - API de 2.991 para 3.147 testes, 100% nas 4 métricas;
  - mutação 38/38: o M-13 em 8 operadores, mais 30 dirigidos (cabeçalho repassado, projeção por *spread*, redirect seguido ou `manual`, retry no adapter, `code` no corpo…);
  - turbo 21/21 em série e depcruise sem violações (440 módulos);
  - o gitleaks não está instalado, e a revisão dos literais novos foi manual.
- **Cofre:**
  - emenda do ADR-018 D5 (cliente do GoTrue na tabela), marcada no ADR-004 §6.1;
  - STATE, BACKLOG, HITL-QUEUE e SESSION-LOG atualizados;
  - backups no scratchpad.
- Nada chamou o Supabase real nem provedor de LLM, e o comportamento da API não mudou (nenhuma rota nova).

### Pendências do humano
- Nenhum HITL aberto para as trilhas.
- Push autorizado nesta sessão: o `spike/s1-extraction` foi enviado ao `origin` com os commits locais (07a, 07b, 07c e os do `next-step.md`).

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM nem chama o Supabase real. A API chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **F1-API-07 (07d → 07h)** | BFF do ADR-004 (D4 a D8), na partição do ADR-004 §6.3. Feitos: 07a (`c51b809`), 07b (`905d85f`) e 07c (`86fe1ef`). Faltam, um commit por vez: **07d** `keysReady()` e `amr` (ADR-013); **07e** limitador local pré-JWT, orçamento de saída e *bulkhead* (ADR-014 D10); **07f** `ExchangeSession`, `RefreshSession` e `EndSession`; **07g** rotas e borda, com a leitura do anel no boot; **07h** contrato no job `db` (§4.3) e regra do gitleaks | não | nada |
| **F1-DB-02** | Custom Access Token Hook por migration (ADR-004 D5): recusa com 403 a sessão com mais de 24 h, grants mínimos e `test:db` da recusa na emissão e na renovação. Depois, HITL de aplicação no projeto real (molde do HITL-023) | não | nada; o P18 (CA-15) depende dela, mesmo com o ADR-004 aceito por sobreposição do veto |
| **F1-EXT-05a → F1-EXT-05b → F1-EXT-05c → F1-SEC-01** | Resto do ADR-004, uma trilha por vez: Service Worker e manifesto (com `auth` no `CONTRACTS_ALLOWED` e o painel proibido de importá-lo), painel, E2E com IdP falso e threat model v2 | não | a trilha anterior (a F1-EXT-05a espera a F1-API-07) |

**O que vem depois:**
- **F1-API-07 concluída:** começa a F1-EXT-05a.
- **F1-EXT-05a concluída:** o envio à API (F1-EXT-04 parte 2) vira trilha.
- **HITL-036:** fechado em 2026-11-07 (P6 aprovado). O spike S-3 não depende mais dele.
- **F1-DB-02 concluída:** abre o HITL de aplicação do hook.
- **Spike S-3 completo (P1 a P20):** depois das F1-EXT-05x e da F1-DB-02. Depois dele, o fechamento do F1-EXT-05 pelos CAs do §4.10. O ADR-004 já está `aceito` por sobreposição do veto, mas o P3 e o P18 seguem obrigatórios.
- **S-5 (troca do Site URL, ADR-004 D15):** a página estática fica pronta antes, numa origem própria. Depois, o humano refaz pelo runbook `auth-extensao` §3 os casos A com `-ComState` (P5), E, F (anotando o `caminho`) e G. Se o `st` deixar de voltar, vale a Q6; se um código chegar a host fora da lista, vale o veto do `[APPSEC]`.

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`.
2. **Nenhuma sessão muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`** sem um HITL mandar. O próximo prompt (`p4`) carrega a linha do `null` de `yearsExperienceMin` e passa pelo aceite completo (§8.1 por efeito, §8.3 com ruído).
3. **Nenhuma trilha chama provedor.** Para testar a API à mão, lembre que ela agora gasta cota do Groq.
4. **O avaliador do S-1 tem a equivalência de nome** (`stackKey` no `score.ts`). Ninguém muda a regra sem refazer o relatório de todas as versões e o `s1-effect.json`.
5. **O critério de stack é o efeito na nota** (golden-dataset-spec §8.1), e o **§8.3 tem o ruído**. Cada aceite novo de prompt ou guard roda o `S1_MODE=effect` e, se cair mais de 2 pp, o `S1_MODE=noise`.
6. **A cadeia de produção passa pelo `composeProductionApp`.** Provedor novo ou troca de modelo exige o gate do golden dataset antes (T28).
7. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts`. O GoTrue simulado da F1-API-07 (`test/support/fake-gotrue.ts`, 07c) segue o mesmo padrão. Os casos de 2 chamadas da renovação (07f) usam os modos `lento` e `corta`, que processam o pedido antes de perder a resposta.
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
    - **cabeçalhos de saída ao GoTrue (feito no 07c):** lista fechada em `GOTRUE_CLIENT_POLICY.outboundHeaders` (`apikey`, `content-type`, `accept` e, só no logout, `authorization`). A interface do adapter não recebe cabeçalho; nunca `X-Forwarded-For`, `X-Real-IP`, `Forwarded` nem cabeçalho do cliente, e o simulado prova isso. Quem mexer no adapter roda a mutação dirigida de novo;
    - **porta do GoTrue (07c):** nunca rejeita; o `signal` opcional serve para o `RefreshSession` (07f) limitar a nova tentativa a cerca de 2 s. O mapa dos motivos para 401, 503 ou 204 é dos casos de uso (07f), não do adapter;
    - **boot (07g):** o anel do refresh, as idades, o `amr` e o `API_BEHIND_PROXY` são lidos em falha fechada, e o boot recusa chave repetida entre o anel da pretensão e o do refresh;
    - **envio à API (F1-EXT-04 parte 2):** quando virar trilha, só envia com `consent.isGranted()` e com sessão, e um teste prova isso. O `source` leva `platform` e `extractorVersion`, a base do monitoramento dos seletores (spike-metrics §3.4 e §3.5).
11. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/` por script (o `auth.ts` é a §4.8 e o `index.ts` a §4.9), e a §9 ganha uma linha.
12. **E2E com fixture real:** cada teste de plataforma usa uma URL própria (o `clickAction` acha a aba pela URL), e a rota serve o CSS pelo nome do arquivo. Intermitência de `sem_acesso` vai para o QA-04.
13. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

---

## Próximo prompt (sessão nova)

```text
Equipe, sigam em ciclo estrito de DevSecOps. Trilha F1-API-07, commit 07d (keysReady() e amr), sem gastar cota e sem chamar o Supabase real. O push do branch está autorizado ao fim do escopo.

1. [ORCHESTRATOR]: leiam STATE.md (bloco "HITL-036 fechado e Trilha F1-API-07 em andamento", com o 07c e a sobreposição do veto), o ADR-004 D6 (verificação antes de repassar e JWKS em falha fechada), D4 (troca passo 2 e 6, renovação passo 4 e 7), §4.2 ("Verificação antes de repassar" e "JWKS"), §4.7 (M-17), §6.1 (ADR-013) e §6.3 (07d), e o ADR-013 D1 e D4. Confiram que 07a (c51b809), 07b (905d85f) e 07c (86fe1ef) estão no branch.
2. [ARCHITECT] + [APPSEC]: 07d = keysReady() na porta application/ports/access-token-verifier.ts e no adapter jose (nunca rejeita; sem chaves, false sem lançar; P15) e o amr exigido (AUTH_ALLOWED_AMR, padrão oauth; password só com NODE_ENV=test e recusado no boot de produção; leitura em falha fechada sem ecoar valor). Atenção: o amr vale para todas as rotas protegidas já existentes (/v1/analyze e /v1/criteria), então é o único commit da partição que muda comportamento antes do 07g. Revejam os testes e fixtures de JWT que hoje não trazem amr. Nenhuma rota nova (condição 1 do §6.3).
3. [DEV] + [QA_EVALS]: TDD, 100% de cobertura, mutação M-17 (amr ignorado) e mutantes dirigidos (keysReady que rejeita, password aceito fora de test, padrão diferente de oauth, amr vazio aceito), turbo em série e depcruise. Emendas do ADR-013 D1 e D4 marcadas no ADR-004 §6.1. Se a sessão ainda estiver leve depois do commit, sigam para o 07e (limitador local, orçamento de saída e bulkhead); senão, parem e reciclem (AGENTS §4.4).
4. [SCRIBE]: STATE a cada commit; no fim, SESSION-LOG, BACKLOG e o next-step reescrito mantendo as trilhas. Commit e push do spike/s1-extraction.
```
