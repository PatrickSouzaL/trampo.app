# Próximo passo: F1-API-07, commit 07g (rotas e borda do BFF, com a composição no boot) numa sessão nova

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie o prompt do fim deste arquivo. Não há HITL aberto para a trilha.

## O que acabou de ser entregue (2026-11-07, sessão 5)

### F1-API-07, commit 07f (`e1af5d0`): casos de uso `ExchangeSession`, `RefreshSession` e `EndSession`
- **Peças** (`apps/api/src/application/auth/`):
  - `exchange-session.ts`, `refresh-session.ts`, `end-session.ts` e o comum `auth-session.ts`;
  - código puro, com as portas injetadas (`AuthTokenGateway`, `RefreshSealer`, `AccessTokenVerifier`, `GotrueEgress`, `Clock`) e o relógio de parede `now` (epoch em ms);
  - o resultado é uma união discriminada para o 07g mapear pelo D7: `sessao` (200), `nao_autenticado` (401), `indisponivel` (503, com `retryAfterSeconds` ou `null`), `entrada_invalida` (400) e `encerrada` (204, só no logout). O `reason` é a mensagem do catálogo do D8 item 7;
  - nenhuma rota nova.
- **Ordem:**
  - troca: Zod → `keysReady()` → `run("troca")` → GoTrue, com 1 chamada só → verificação → selagem;
  - renovação: Zod → `open` → idade máxima → inatividade (sem rede e sem orçamento) → `keysReady()` → `run("renovacao")` → GoTrue → verificação → `sid` igual → selagem com o mesmo `sst` e um `iat` novo;
  - no "pode ter rotacionado", a renovação faz **uma** nova tentativa: mesmo `rt`, outro `run("renovacao")` e 2 s pelo `withDeadline`. Qualquer falha dela é 503, inclusive a recusa;
  - logout: `run("logout")`. `ok` dá 204; o resto, 503.
- **Política depois do GoTrue:** dão 503 `auth_token_fora_da_politica`:
  - qualquer `ok: false` do `verify` e o `sessionId` nulo;
  - `expires_in` ou `exp − iat` acima de 900;
  - `expiresIn = floor(min(expires_in, 900 − idade))` menor que 1. A idade conta os milissegundos: 899 s exatos dão 1; 899,5, 900 e 909 s dão 503;
  - selagem recusada, ou resposta fora do `AuthSessionResponseSchema` (reparse estrito, montada campo a campo).

  O `sid` divergente dá 401 sem selar o refresh novo.
- **Porta do verificador:** o `ok` do `verify` ganhou `lifetime { issuedAt, expiresAt }`, fora do `Principal`. As emendas estão no ADR-004 D6 e no ADR-013 D1.
- **GoTrue simulado:** ganhou a opção `accessToken` (JWS assinado). A pilha real (adapter, `jose`, AEAD e orçamento) foi provada em socket (`test/auth-session-stack.test.ts`): exatamente 1 chamada na troca e, nos modos `lento` e `corta`, 2 com o mesmo `rt` na renovação.
- **Prova:**
  - API de 3.293 para 3.422 testes, 100% nas 4 métricas;
  - mutação 50/50, com M-09, M-10, M-11, o "orçamento antes do `open`" do M-16 e dirigidos;
  - 10.000 envelopes forjados consomem 0 do orçamento, e o *replay* do genuíno para na 75ª chamada;
  - turbo 21/21 em série na 2ª rodada, e depcruise sem violações (465 módulos);
  - na 1ª rodada, o caso feliz do teste novo de socket pedia `expiresIn` 899 ou 900 com o relógio real e recebeu 898 sob carga. A asserção virou a faixa de 880 a 900; a conta exata fica nos testes com relógio controlado.
- **Cofre:** ADR-004 com a "Emenda do 07f" no D4 e no D6 e as marcas no §6.1 e no §6.3; ADR-013 D1 com a emenda datada; STATE, BACKLOG e SESSION-LOG atualizados, com backups no scratchpad.
- Nada chamou o Supabase real nem provedor de LLM.

### Pendências do humano
- Nenhum HITL aberto para as trilhas.
- **Aviso para depois do 07g:** o boot vai exigir `API_BEHIND_PROXY` fora de `NODE_ENV=test`. Quem subir a API localmente precisa acrescentar `API_BEHIND_PROXY=false` ao `apps/api/.env` (com `TRUST_PROXY=false`), além do anel `AUTH_REFRESH_SEAL_KEYS` e `AUTH_REFRESH_SEAL_ACTIVE_KEY`. O 07g registra isso no runbook.
- Push autorizado nesta sessão: o `spike/s1-extraction` vai ao `origin` com o 07f e o commit deste arquivo.

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM nem chama o Supabase real. A API chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **F1-API-07 (07g → 07h)** | BFF do ADR-004 (D4 a D8), na partição do ADR-004 §6.3. Feitos: 07a (`c51b809`), 07b (`905d85f`), 07c (`86fe1ef`), 07d (`7e6c5d5`), 07e (`ac3c2c7`) e 07f (`e1af5d0`). Faltam, um commit por vez: **07g** rotas e borda, com o mapa do D7 sobre o resultado dos casos de uso e a leitura do anel, das idades e do `API_BEHIND_PROXY` no boot; **07h** contrato no job `db` (§4.3) e regra do gitleaks | não | nada |
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
7. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts`. O GoTrue simulado da F1-API-07 (`test/support/fake-gotrue.ts`, 07c) segue o mesmo padrão. Os casos de 2 chamadas da renovação (07f, `test/auth-session-stack.test.ts`) usam os modos `lento` e `corta`, que processam o pedido antes de perder a resposta, e a opção `accessToken` emite JWS assinado para o `jose` real. Asserção de tempo com o relógio real fica em faixa folgada; a conta exata vai para o `FakeClock` e o `now` injetado. Se o `edge-socket.test.ts` voltar a falhar no turbo, guarde o nome do caso e leve ao QA-02.
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
    - **porta do GoTrue (07c):** nunca rejeita; o `signal` opcional limita a nova tentativa do `RefreshSession` a 2 s. O mapa dos motivos para 401, 503 ou 204 é dos casos de uso (07f), não do adapter;
    - **verificador (07d):** o `keysReady()` usa só o cache do `RemoteJWKSet`. O `amr` exige todo método na lista. Quem assinar token de teste usa o `supabaseClaims`, que já traz `amr` oauth. Desde o 07f, o `ok` também traz `lifetime { issuedAt, expiresAt }`, fora do `Principal`: quem montar verificador falso precisa dele (o `test/auth-fakes.ts` tem o `TEST_LIFETIME`);
    - **contenção (07e):**
      - os casos de uso (07f) chamam o GoTrue só por `GotrueEgress.run`, e a negação chega como `indisponivel` com o `retryAfterSeconds` dela; o 07g monta um só `createGotrueEgress` por processo, compartilhado pelas três rotas;
      - o limitador local entra no `onRequest` de cada rota pública no 07g, que também prova "0 comandos no Redis falso antes do JWT" nas rotas reais e liga a linha amostrada `auth_limite_local`;
    - **casos de uso (07f):** o 07g só traduz o resultado, sem regra nova:
      - `sessao` → 200 com o corpo `session` como está;
      - `nao_autenticado` → 401 `NAO_AUTENTICADO`;
      - `indisponivel` → 503 `SERVICO_INDISPONIVEL` com o `retryAfterSeconds` (o `null` usa o padrão da rota);
      - `entrada_invalida` → 400 `PAYLOAD_INVALIDO`;
      - `encerrada` → 204;
      - o `reason` vai só para a linha de log amostrada do catálogo. Na renovação, o 503 `auth_token_fora_da_politica` sempre nasce depois da rotação e registra também `auth_renovacao_perdida` (D6);
      - as dependências são `now: () => Date.now()`, o `systemClock` e as idades do `readAuthSessionEnv`. O `RefreshSession` recusa idades incoerentes na montagem;
    - **boot (07g):** o anel do refresh, as idades e o `API_BEHIND_PROXY` (`readApiBehindProxy` com o `TRUST_PROXY` já validado) são lidos em falha fechada, e o `amr` já é lido desde o 07d. O boot recusa chave repetida entre o anel da pretensão e o do refresh;
    - **envio à API (F1-EXT-04 parte 2):** quando virar trilha, só envia com `consent.isGranted()` e com sessão, e um teste prova isso. O `source` leva `platform` e `extractorVersion`, a base do monitoramento dos seletores (spike-metrics §3.4 e §3.5).
11. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/` por script (o `auth.ts` é a §4.8 e o `index.ts` a §4.9), e a §9 ganha uma linha.
12. **E2E com fixture real:** cada teste de plataforma usa uma URL própria (o `clickAction` acha a aba pela URL), e a rota serve o CSS pelo nome do arquivo. Intermitência de `sem_acesso` vai para o QA-04.
13. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

---

## Próximo prompt (sessão nova)

```text
Equipe, sigam em ciclo estrito de DevSecOps. Trilha F1-API-07, commit 07g (rotas e borda do BFF, com a composição no boot), sem gastar cota e sem chamar o Supabase real. O push do branch está autorizado ao fim do escopo.

1. [ORCHESTRATOR]: leiam o STATE.md (bloco "HITL-036 fechado e Trilha F1-API-07 em andamento", com o 07f) e o ADR-004:
   - D4: tabela das rotas, "Ordem na borda" e as emendas do 07c e do 07f;
   - D5 (anel) e D6 (as emendas do 07d e do 07f);
   - D7 (mapa de erros) e D8 itens 1, 2, 4 e 7 (com a "Emenda do 07e");
   - §4.2 inteiro (PUBLIC_ROUTES, CORS, Corpo, Limitador local, Proxy, Rotas públicas ignoram Authorization, Logs amostrados, Resposta, Logout, SR-12);
   - §4.7 (M-14 e M-15) e §6.3 (07g).
   Leiam também o ADR-014 D10, o ADR-007 D6, o ADR-013 D2 e o ADR-021 D8.3. Confiram que o 07a (c51b809), o 07b (905d85f), o 07c (86fe1ef), o 07d (7e6c5d5), o 07e (ac3c2c7) e o 07f (e1af5d0) estão no branch.
2. [ARCHITECT] + [APPSEC]: o 07g tem estas peças:
   - presentation/routes/auth.ts com as 3 rotas do D4, traduzindo o resultado dos casos de uso pelo D7 sem regra nova;
   - PUBLIC_ROUTES exata, EXTENSION_ONLY_ROUTES com Origin obrigatório e sem curinga, bodyLimit de 2.048 e Cache-Control: no-store em toda resposta, inclusive erro;
   - o limitador local (pre-auth-limit) no onRequest das 2 rotas públicas, que nunca leem Authorization; o logout fica protegido, na classe padrao;
   - logs de catálogo amostrados (D8 item 7, com auth_renovacao_perdida e auth_limite_local);
   - composição no boot, em falha fechada: anel do refresh, idades, API_BEHIND_PROXY com o TRUST_PROXY já validado e um só GotrueEgress; o boot recusa chave repetida entre o anel da pretensão e o do refresh (pendência do 07b);
   - emendas do ADR-007 D6, ADR-013 D2, ADR-014 D4 (logout na classe padrao), ADR-021 D8.3 e ADR-010;
   - runbook com o aviso do API_BEHIND_PROXY=false e do anel no .env local.
3. [DEV] + [QA_EVALS]: TDD com o GoTrue simulado e o buildApp real. Cobertura de 100% e mutação do M-14 (um mutante por linha do mapa do D7) e do M-15 (rotas por prefixo; Origin opcional). Casos dirigidos:
   - /v1/auth/exchange/, %61uth, GET e PUT;
   - sem Origin nas públicas dá 403;
   - "0 comandos no Redis falso antes do JWT" nas rotas reais;
   - canário de Authorization nas públicas;
   - 1.000 recusas em 1 min geram 1 linha por motivo;
   - 4 chaves e no-store em 200 e nos erros;
   - SR-12 nos caminhos 200, 401, 429 e 503.
   Rodem o turbo em série e o depcruise. Se a sessão ainda estiver leve depois do commit, sigam para o 07h; senão, parem e reciclem (AGENTS §4.4).
4. [SCRIBE]: atualizem o STATE a cada commit. No fim, atualizem o SESSION-LOG e o BACKLOG e reescrevam o next-step mantendo as trilhas. Façam o commit e o push do spike/s1-extraction.
```
