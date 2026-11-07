# Próximo passo: F1-API-07, commit 07h (contrato no job `db` e regra do gitleaks) numa sessão nova

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie o prompt do fim deste arquivo. Não há HITL aberto para a trilha.

## O que acabou de ser entregue (2026-11-07, sessão 6)

### F1-API-07, commit 07g (`b516fd0`): rotas e borda do BFF, com a composição no boot
- **Rotas** (`apps/api/src/presentation/routes/auth.ts`), registradas só com a opção `auth` do `buildApp`:
  - `POST /v1/auth/exchange` e `POST /v1/auth/refresh` são públicas; `POST /v1/auth/logout` é protegido, na classe `padrao`;
  - as 3 têm `bodyLimit` de 2.048, Zod estrito e `Cache-Control: no-store` em toda resposta, inclusive nos erros dos hooks globais;
  - o mapa do D7 é um `switch` sobre o `kind`, sem regra nova:
    - `sessao` → 200;
    - `nao_autenticado` → 401, sem `WWW-Authenticate`;
    - `indisponivel` → 503, com `Retry-After` só quando o orçamento ou o *bulkhead* o dão;
    - `entrada_invalida` → 400;
    - `encerrada` → 204;
  - caso de uso que rejeita dá 503, nunca 500.
- **Borda:**
  - `PUBLIC_ROUTES` ganhou as 2 públicas, que nunca leem `Authorization`;
  - `EXTENSION_ROUTES` ganhou as 3 rotas;
  - `EXTENSION_ONLY_ROUTES` dá 403 à origem de web, e `ORIGIN_REQUIRED_ROUTES` dá 403 sem `Origin`. As duas comparam o caminho cru **e** o padrão casado, porque o roteador decodifica `%61uth`;
  - o limitador local do 07e entra no `onRequest` das públicas, com a linha `auth_limite_local`.
- **Logs:** `presentation/logging/auth-log-sampler.ts` escreve 1 linha por motivo a cada 60 s, por instância, com o contador `suprimidas` (chave nova na allowlist do ADR-010). As 10 mensagens do D8 item 7 entraram no catálogo. Na renovação, o 503 fora da política registra também `auth_renovacao_perdida`.
- **Boot** (`composeApp`, em falha fechada e sem ecoar valor):
  - `API_BEHIND_PROXY` lido contra o `TRUST_PROXY`;
  - anel do refresh e idades;
  - chave repetida entre o anel da pretensão e o do refresh recusada (`KeyringReuseError`, fecha a pendência do 07b);
  - um só `GotrueEgress`, um limitador local e uma amostragem por processo, e o mesmo verificador das rotas protegidas.
- **Prova:**
  - API de 3.422 para 3.518 testes, 100% nas 4 métricas;
  - mutação 50/50 (M-14 com uma linha do mapa por mutante, M-15 e dirigidos). Um mutante sobreviveu na 1ª rodada, "`Origin` obrigatório só pelo caminho cru": a segunda trava do handler o mascarava. O teste do `%61uth` passou a exigir 0 chamadas ao limitador;
  - todos os casos dirigidos do prompt passaram, inclusive "0 comandos no Upstash simulado antes do JWT nas rotas reais" e o SR-12 com as peças reais nos caminhos 200, 401, 429 e 503;
  - turbo 21/21 em série na 2ª rodada. Na 1ª, o caso `chunked acima do limite` do `edge-socket.test.ts` (arquivo não tocado) falhou uma vez e passou 3/3 isolado: é o padrão do QA-02;
  - depcruise sem violações (469 módulos).
- **Cofre:**
  - emendas datadas no ADR-007 D6, no ADR-010 D1 e D2, no ADR-013 D2, no ADR-014 D4 e no ADR-021 D8.3;
  - ADR-004 com a "Emenda do 07g" no D4, no D5 e no D8 e as marcas no §6.1 e no §6.3;
  - runbook `auth-extensao` com o §1.5 novo (subir a API na máquina local);
  - STATE, BACKLOG e SESSION-LOG atualizados, com backups no scratchpad.
- **Pendente (07i):** as métricas `auth_*_total` do D8 item 7. A porta `Telemetry` não tem evento de auth, e o exportador é do S-5.
- Nada chamou o Supabase real nem provedor de LLM.

### Pendências do humano
- Nenhum HITL aberto para as trilhas.
- **Vale desde o 07g:** fora de `NODE_ENV=test`, a API só sobe com `API_BEHIND_PROXY=false` (junto com `TRUST_PROXY=false`) e o anel `AUTH_REFRESH_SEAL_KEYS` e `AUTH_REFRESH_SEAL_ACTIVE_KEY` no `apps/api/.env`, com chaves diferentes das do `CRITERIA_SALARY_KEYS`. O passo a passo e a tabela dos erros do boot estão no runbook `auth-extensao` §1.5.
- Push autorizado nesta sessão: o `spike/s1-extraction` vai ao `origin` com o 07g e o commit deste arquivo.

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM nem chama o Supabase real. A API chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **F1-API-07 (07h → 07i)** | BFF do ADR-004 (D4 a D8), na partição do ADR-004 §6.3. Feitos: 07a (`c51b809`), 07b (`905d85f`), 07c (`86fe1ef`), 07d (`7e6c5d5`), 07e (`ac3c2c7`), 07f (`e1af5d0`) e 07g (`b516fd0`). Faltam, um commit por vez: **07h** contrato no job `db` (§4.3) e regra `trampo-auth-seal-keys` do gitleaks; **07i** métricas `auth_*_total` do D8 item 7 na porta `Telemetry` | não | nada |
| **F1-DB-02** | Custom Access Token Hook por migration (ADR-004 D5): recusa com 403 a sessão com mais de 24 h, grants mínimos e `test:db` da recusa na emissão e na renovação. Depois, HITL de aplicação no projeto real (molde do HITL-023) | não | nada; o P18 (CA-15) depende dela, mesmo com o ADR-004 aceito por sobreposição do veto |
| **F1-EXT-05a → F1-EXT-05b → F1-EXT-05c → F1-SEC-01** | Resto do ADR-004, uma trilha por vez: Service Worker e manifesto (com `auth` no `CONTRACTS_ALLOWED` e o painel proibido de importá-lo), painel, E2E com IdP falso e threat model v2 | não | a trilha anterior (a F1-EXT-05a espera o 07h; o 07i não a bloqueia) |

**O que vem depois:**
- **07h concluído:** começa a F1-EXT-05a. O 07i entra antes ou depois dela, à escolha do `[ORCHESTRATOR]`, sempre numa sessão própria.
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

---

## Próximo prompt (sessão nova)

```text
Equipe, sigam em ciclo estrito de DevSecOps. Trilha F1-API-07, commit 07h (contrato no job db e regra do gitleaks), sem gastar cota e sem chamar o Supabase real. O push do branch está autorizado ao fim do escopo.

1. [ORCHESTRATOR]: leiam o STATE.md (bloco "HITL-036 fechado e Trilha F1-API-07 em andamento", com o 07g) e o ADR-004:
   - §4.3 inteiro (contrato contra o GoTrue local, com a emenda do HITL-035);
   - §4.8 (gates de CI, regra trampo-auth-seal-keys) e §6.3 (07h);
   - D8 item 5 (o balde do pkce e do /logout, a conferir no GoTrue local) e a condição 3 do [APPSEC] no §6.3.
   Leiam também o ADR-019 (job db) e o packages/ci-policy. Confiram que o 07a a 07g (b516fd0) estão no branch.
2. [ARCHITECT] + [APPSEC]: o 07h tem estas peças:
   - supabase/config.toml espelhando a produção (jwt_expiry = 900, chave ES256 gerada no próprio job e nunca versionada);
   - testes do test:db: o token local no JoseAccessTokenVerifier real (password só com NODE_ENV=test; com AUTH_ALLOWED_AMR=oauth, 401); o GotrueTokenClient renovando e fazendo logout contra o GoTrue de verdade; P10 (rotação e reuso do pai, também depois de 10 s) e P11 (logout global invalida o refresh) em CI;
   - a conferência de em que balde do limite por IP cai o grant_type=pkce e se o /logout conta, no GoTrue local; o resultado fixa por teste os números do D8 item 5 ou abre emenda;
   - regra trampo-auth-seal-keys no .gitleaks.toml (AUTH_REFRESH_SEAL_KEYS e *.pem), com teste no packages/ci-policy;
   - emenda do ADR-019.
   Nada disso roda contra o projeto real: o GoTrue é o da pilha local do job db.
3. [DEV] + [QA_EVALS]: TDD. Cobertura de 100% onde couber, mutação dirigida da regra do gitleaks e dos testes de contrato. Se o Docker não estiver disponível nesta estação, registrem o que só roda no CI e provem localmente o que der. Rodem o turbo em série e o depcruise. Se a sessão ainda estiver leve depois do commit, sigam para o 07i (métricas auth_*_total do D8 item 7 na porta Telemetry, ADR-010 D5 e D6); senão, parem e reciclem (AGENTS §4.4).
4. [SCRIBE]: atualizem o STATE a cada commit. No fim, atualizem o SESSION-LOG e o BACKLOG e reescrevam o next-step mantendo as trilhas. Façam o commit e o push do spike/s1-extraction.
```
