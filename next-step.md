# Próximo passo: F1-API-07, commit 07f (casos de uso `ExchangeSession`, `RefreshSession` e `EndSession`) numa sessão nova

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie o prompt do fim deste arquivo. Não há HITL aberto para a trilha.

## O que acabou de ser entregue (2026-11-07, sessão 4)

### F1-API-07, commit 07e (`ac3c2c7`): limitador local pré-JWT, orçamento de saída e *bulkhead*
- **Limitador local** (`presentation/edge/pre-auth-limit.ts`):
  - em memória, sem nenhum comando Redis antes do JWT;
  - janela deslizante de 60 s com a conta do ADR-014 D4 (a negada conta);
  - chave `<classe>:HMAC(RATE_KEY_PEPPER, balde)`, com IPv6 por /64;
  - `auth_troca` 10/min e `auth_renovacao` 30/min;
  - 10.000 baldes vivos, com transbordo por classe e sem despejo (só sai o balde vencido, de peso zero);
  - o hook entra no `onRequest` da própria rota (07g) e foi provado numa rota de prova com o `buildApp` real: proxy confiável, IP não confiável e sem `TRUST_PROXY`.
- **Orçamento de saída e *bulkhead*** (`application/auth/gotrue-egress.ts`):
  - registro exato de 300 s, que nunca estoura na virada;
  - `troca` até 14, total no `/token` até 74 e reserva de 37 para a renovação;
  - *bulkhead* de 4 com `retryAfterSeconds: 5`, decidido antes do orçamento; nenhuma negação consome vaga;
  - o logout passa só pelo *bulkhead*, até o 07h conferir o balde dele;
  - os tetos do P19 (150 e 30 por 5 min por IP) estão presos por teste.
- **`API_BEHIND_PROXY`** (`presentation/edge/behind-proxy-env.ts`): só `true` ou `false`, obrigatória fora de `NODE_ENV=test` exato e concordando com o `TRUST_PROXY` (`false` com saltos também derruba). O nome entrou sem valor no `.env.example`. A leitura no boot é do 07g.
- **Prova:**
  - API de 3.220 para 3.293 testes, 100% nas 4 métricas;
  - mutação 41/41: o M-16 e os dirigidos (IPv6 fora do /64, `X-Forwarded-For` de IP não confiável, reserva ignorada, janela fixa e outros). O mutante da vaga do *bulkhead* que não volta na rejeição sobreviveu na 1ª rodada e virou asserção;
  - turbo 21/21 em série e depcruise sem violações (452 módulos);
  - na 1ª rodada do turbo, 1 caso de `edge-socket.test.ts` (arquivo não tocado) falhou uma vez. Passou 3/3 isolado e na 2ª rodada completa, no padrão de intermitência do QA-02;
  - o gitleaks não está instalado. O *pepper* dos testes novos é gerado em runtime.
- **Cofre:**
  - ADR-014 com D10 novo, nota de ordem no D8 e a decisão de 2026-10-21 de pé no §3;
  - ADR-004 com a "Emenda do 07e" no D8 e a marca no §6.1;
  - STATE, BACKLOG e SESSION-LOG atualizados, com backups no scratchpad.
- Nada chamou o Supabase real nem provedor de LLM. Nenhuma rota nova e nenhuma mudança de comportamento da API.

### Pendências do humano
- Nenhum HITL aberto para as trilhas.
- **Aviso para depois do 07g:** o boot vai exigir `API_BEHIND_PROXY` fora de `NODE_ENV=test`. Quem subir a API localmente precisa acrescentar `API_BEHIND_PROXY=false` ao `apps/api/.env` (com `TRUST_PROXY=false`). O 07g registra isso no runbook.
- Push autorizado nesta sessão: o `spike/s1-extraction` vai ao `origin` com o 07e e o commit deste arquivo.

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM nem chama o Supabase real. A API chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **F1-API-07 (07f → 07h)** | BFF do ADR-004 (D4 a D8), na partição do ADR-004 §6.3. Feitos: 07a (`c51b809`), 07b (`905d85f`), 07c (`86fe1ef`), 07d (`7e6c5d5`) e 07e (`ac3c2c7`). Faltam, um commit por vez: **07f** `ExchangeSession`, `RefreshSession` e `EndSession`; **07g** rotas e borda, com a leitura do anel, das idades e do `API_BEHIND_PROXY` no boot; **07h** contrato no job `db` (§4.3) e regra do gitleaks | não | nada |
| **F1-DB-02** | Custom Access Token Hook por migration (ADR-004 D5): recusa com 403 a sessão com mais de 24 h, grants mínimos e `test:db` da recusa na emissão e na renovação. Depois, HITL de aplicação no projeto real (molde do HITL-023) | não | nada; o P18 (CA-15) depende dela, mesmo com o ADR-004 aceito por sobreposição do veto |
| **F1-EXT-05a → F1-EXT-05b → F1-EXT-05c → F1-SEC-01** | Resto do ADR-004, uma trilha por vez: Service Worker e manifesto (com `auth` no `CONTRACTS_ALLOWED` e o painel proibido de importá-lo), painel, E2E com IdP falso e threat model v2 | não | a trilha anterior (a F1-EXT-05a espera a F1-API-07) |

**O que vem depois:**
- **F1-API-07 concluída:** começa a F1-EXT-05a.
- **F1-EXT-05a concluída:** o envio à API (F1-EXT-04 parte 2) vira trilha.
- **F1-DB-02 concluída:** abre o HITL de aplicação do hook.
- **Spike S-3 completo (P1 a P20):** depois das F1-EXT-05x e da F1-DB-02. Depois dele, o fechamento do F1-EXT-05 pelos CAs do §4.10. O ADR-004 já está `aceito` por sobreposição do veto, mas o P3 e o P18 seguem obrigatórios. O **P9** confirma o formato real do `amr` (hoje só a lista de objetos do GoTrue passa).
- **S-5 (troca do Site URL, ADR-004 D15):** a página estática fica pronta antes, numa origem própria. Depois, o humano refaz pelo runbook `auth-extensao` §3 os casos A com `-ComState` (P5), E, F (anotando o `caminho`) e G. Se o `st` deixar de voltar, vale a Q6; se um código chegar a host fora da lista, vale o veto do `[APPSEC]`. O S-5 também traz as faixas da Cloudflare para o `TRUST_PROXY` (com `API_BEHIND_PROXY=true`).

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`.
2. **Nenhuma sessão muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`** sem um HITL mandar. O próximo prompt (`p4`) carrega a linha do `null` de `yearsExperienceMin` e passa pelo aceite completo (§8.1 por efeito, §8.3 com ruído).
3. **Nenhuma trilha chama provedor.** Para testar a API à mão, lembre que ela agora gasta cota do Groq.
4. **O avaliador do S-1 tem a equivalência de nome** (`stackKey` no `score.ts`). Ninguém muda a regra sem refazer o relatório de todas as versões e o `s1-effect.json`.
5. **O critério de stack é o efeito na nota** (golden-dataset-spec §8.1), e o **§8.3 tem o ruído**. Cada aceite novo de prompt ou guard roda o `S1_MODE=effect` e, se cair mais de 2 pp, o `S1_MODE=noise`.
6. **A cadeia de produção passa pelo `composeProductionApp`.** Provedor novo ou troca de modelo exige o gate do golden dataset antes (T28).
7. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts`. O GoTrue simulado da F1-API-07 (`test/support/fake-gotrue.ts`, 07c) segue o mesmo padrão. Os casos de 2 chamadas da renovação (07f) usam os modos `lento` e `corta`, que processam o pedido antes de perder a resposta. Se o `edge-socket.test.ts` voltar a falhar no turbo, guarde o nome do caso e leve ao QA-02.
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
    - **no envelope (07b):** `aead-envelope` por finalidade, com o prefixo de AAD terminando em `:<versão>:`; base64url canônica no `open`; `kid` em `[a-z0-9]{1,16}` preso à regex do contrato; texto claro até 768 **bytes**, e o excesso não é selado. O formato `s1` da pretensão é provado por vetor gravado: quem mexer no `aead-envelope` roda o `salary-cipher.test.ts`. O `expiresIn` é inteiro, e menor que 1 dá 503 (07f);
    - **cabeçalhos de saída ao GoTrue (07c):** lista fechada em `GOTRUE_CLIENT_POLICY.outboundHeaders` (`apikey`, `content-type`, `accept` e, só no logout, `authorization`). A interface do adapter não recebe cabeçalho; nunca `X-Forwarded-For`, `X-Real-IP`, `Forwarded` nem cabeçalho do cliente, e o simulado prova isso. Quem mexer no adapter roda a mutação dirigida de novo;
    - **porta do GoTrue (07c):** nunca rejeita; o `signal` opcional serve para o `RefreshSession` (07f) limitar a nova tentativa a cerca de 2 s. O mapa dos motivos para 401, 503 ou 204 é dos casos de uso (07f), não do adapter;
    - **verificador (07d):** o `keysReady()` usa só o cache do `RemoteJWKSet`. O `amr` exige todo método na lista. Quem assinar token de teste usa o `supabaseClaims`, que já traz `amr` oauth. **Os casos de uso (07f) tratam qualquer `ok: false` do `verify` depois do GoTrue como 503 `auth_token_fora_da_politica`**, inclusive o `amr`, e chamam o `keysReady()` antes do orçamento e do GoTrue (M-10);
    - **contenção (07e):**
      - os casos de uso chamam o GoTrue só por `GotrueEgress.run(partição, chamada)`, depois do Zod e, na renovação, depois do `open` e das idades (operador "orçamento antes do `open`" do M-16, que se prova no 07f);
      - a nova tentativa da renovação é um segundo `run("renovacao", …)` e também gasta orçamento;
      - qualquer negação (`orcamento_esgotado` ou `bulkhead_cheio`) vira 503 `SERVICO_INDISPONIVEL` com o `retryAfterSeconds` dela, sem chamar o GoTrue;
      - o logout usa `run("logout", …)`;
      - o limitador local entra no `onRequest` de cada rota pública no 07g, que também prova "0 comandos no Redis falso antes do JWT" nas rotas reais e liga a linha amostrada `auth_limite_local`;
    - **boot (07g):** o anel do refresh, as idades e o `API_BEHIND_PROXY` (`readApiBehindProxy` com o `TRUST_PROXY` já validado) são lidos em falha fechada, e o `amr` já é lido desde o 07d. O boot recusa chave repetida entre o anel da pretensão e o do refresh;
    - **envio à API (F1-EXT-04 parte 2):** quando virar trilha, só envia com `consent.isGranted()` e com sessão, e um teste prova isso. O `source` leva `platform` e `extractorVersion`, a base do monitoramento dos seletores (spike-metrics §3.4 e §3.5).
11. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/` por script (o `auth.ts` é a §4.8 e o `index.ts` a §4.9), e a §9 ganha uma linha.
12. **E2E com fixture real:** cada teste de plataforma usa uma URL própria (o `clickAction` acha a aba pela URL), e a rota serve o CSS pelo nome do arquivo. Intermitência de `sem_acesso` vai para o QA-04.
13. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

---

## Próximo prompt (sessão nova)

```text
Equipe, sigam em ciclo estrito de DevSecOps. Trilha F1-API-07, commit 07f (casos de uso ExchangeSession, RefreshSession e EndSession), sem gastar cota e sem chamar o Supabase real. O push do branch está autorizado ao fim do escopo.

1. [ORCHESTRATOR]: leiam STATE.md (bloco "HITL-036 fechado e Trilha F1-API-07 em andamento", com o 07e), o ADR-004 D4 (troca, renovação e logout, passo a passo, com as emendas do HITL-035, da revisão da F1-AUTH-00 e do 07c), D5, D6 ("Emenda do 07d"), D7 (mapa de erros), D8 itens 5 a 7 ("Emenda do 07e"), §4.2 ("Envelope", "GoTrue", "Verificação antes de repassar", "JWKS"), §4.7 (M-09, M-10, M-11 e o "orçamento antes do open" do M-16) e §6.3 (07f), e o ADR-014 D10. Confiram que 07a (c51b809), 07b (905d85f), 07c (86fe1ef), 07d (7e6c5d5) e 07e (ac3c2c7) estão no branch.
2. [ARCHITECT] + [APPSEC]: 07f = application/auth/{exchange-session,refresh-session,end-session}.ts, código puro com as portas injetadas (AuthTokenGateway, RefreshSealer, AccessTokenVerifier, GotrueEgress, Clock), na ordem exata do D4 (troca: formato → keysReady() → GotrueEgress.run; renovação: open → idade máxima → inatividade, as três sem rede → keysReady() → GotrueEgress.run) → GoTrue → verificação (sessionId obrigatório, expires_in e exp − iat ≤ 900, qualquer ok: false do verify vira 503 auth_token_fora_da_politica) → selagem (mesmo sst e iat novo na renovação). expiresIn = floor(min(expires_in, 900 − idade)) e < 1 dá 503. Na renovação, "pode_ter_rotacionado" justifica UMA nova tentativa com o mesmo rt em até ~2 s (signal), com outro run("renovacao"); sid divergente dá 401 depois do refresh, sem selar o novo. Logout: run("logout"), ok → 204, falha → 503. O resultado dos casos de uso é um tipo discriminado que o 07g mapeia para HTTP; nenhuma rota nova (condição 1 do §6.3).
3. [DEV] + [QA_EVALS]: TDD com o GoTrue simulado (modos lento e corta para as 2 chamadas) ou portas falsas, 100% de cobertura, mutação M-09 (> vira >=, ou a regra some, na idade máxima, na inatividade e no sid), M-10 (keysReady depois do GoTrue), M-11 (min() vira expires_in, recusa acima de 900 removida, projeção por spread) e o "orçamento antes do open" do M-16, mais dirigidos (idade 899, 900 e 909 s; 10.000 envelopes forjados consomem 0 do orçamento; replay do envelope genuíno limitado pelo orçamento; exatamente 1 chamada na troca e 2 na renovação que rotaciona). Turbo em série e depcruise. Se a sessão ainda estiver leve depois do commit, sigam para o 07g; senão, parem e reciclem (AGENTS §4.4).
4. [SCRIBE]: STATE a cada commit; no fim, SESSION-LOG, BACKLOG e o next-step reescrito mantendo as trilhas. Commit e push do spike/s1-extraction.
```
