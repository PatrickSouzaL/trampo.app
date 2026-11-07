# Próximo passo: F1-API-07, commit 07e (limitador local, orçamento de saída e *bulkhead*) numa sessão nova

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie o prompt do fim deste arquivo. Não há HITL aberto para a trilha.

## O que acabou de ser entregue (2026-11-07, sessão 3)

### F1-API-07, commit 07d (`7e6c5d5`): `keysReady()` e `amr` exigido
- **Porta** `application/ports/access-token-verifier.ts`: `keysReady(): Promise<boolean>`, que nunca rejeita. É a pré-checagem sem token do ADR-004 D6, que o BFF chama antes do GoTrue (07f).
- **Adapter `jose`** (`infrastructure/auth/jose-access-token-verifier.ts`):
  - **P15 respondido:** o `RemoteJWKSet` do `jose` 6.2.12 expõe `fresh`, `reload()` e `jwks()`. O `keysReady()` confere a chave ES256 no cache fresco e, com o cache vencido, recarrega antes. Usa o mesmo cache e o mesmo cooldown do `verify`; qualquer falha é `false`;
  - **`amr`:** lista não vazia de `{ method }` no formato do GoTrue, com **todo** método na lista permitida. `[oauth, password]`, `[]`, ausente e a forma de strings do RFC 8176 são recusados (esta, até o P9);
  - a recusa é `token_invalido` (401 nas rotas protegidas), sem motivo novo na porta. O 503 do BFF é o mapa do 07f.
- **`AUTH_ALLOWED_AMR`** (`infrastructure/auth/allowed-amr-env.ts`):
  - padrão `oauth`; `password` só com `NODE_ENV` exatamente `test`;
  - sem espaço, caixa diferente ou duplicata; o erro não ecoa o valor;
  - lido no `composeApp`, porque o verificador já é montado ali: **vale para `/v1/analyze` e `/v1/criteria`**. O 07g fica com o anel, as idades e o `API_BEHIND_PROXY`.
- **Fixtures:** o `supabaseClaims` passou a trazer `amr` oauth, e os verificadores falsos ganharam `keysReady`. O `test:db` não passa pelo verificador da API e não mudou.
- **Prova:**
  - API de 3.147 para 3.220 testes, 100% nas 4 métricas;
  - mutação 24/24: o M-17 e 23 dirigidos (`keysReady` que rejeita, `password` fora de test, padrão diferente de `oauth`, `amr` vazio aceito, `some` no lugar de `every`, decisão pelo `coolingDown`…). O do `coolingDown` sobreviveu na primeira rodada e virou teste;
  - turbo 21/21 em série e depcruise sem violações (443 módulos);
  - o gitleaks não está instalado, e a revisão dos literais novos foi manual.
- **Cofre:**
  - ADR-013 D1 e D4 emendados, com a marca no ADR-004 §6.1;
  - "Emenda do 07d" no ADR-004 D6;
  - STATE, BACKLOG e SESSION-LOG atualizados;
  - backups no scratchpad.
- Nada chamou o Supabase real nem provedor de LLM, e nenhuma rota nova existe. A única mudança de comportamento é a esperada: token sem `amr` oauth dá 401 nas rotas protegidas.

### Pendências do humano
- Nenhum HITL aberto para as trilhas.
- Push autorizado nesta sessão: o `spike/s1-extraction` foi enviado ao `origin` com o 07d e o commit deste arquivo.

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM nem chama o Supabase real. A API chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **F1-API-07 (07e → 07h)** | BFF do ADR-004 (D4 a D8), na partição do ADR-004 §6.3. Feitos: 07a (`c51b809`), 07b (`905d85f`), 07c (`86fe1ef`) e 07d (`7e6c5d5`). Faltam, um commit por vez: **07e** limitador local pré-JWT, orçamento de saída e *bulkhead* (ADR-014 D10); **07f** `ExchangeSession`, `RefreshSession` e `EndSession`; **07g** rotas e borda, com a leitura do anel no boot; **07h** contrato no job `db` (§4.3) e regra do gitleaks | não | nada |
| **F1-DB-02** | Custom Access Token Hook por migration (ADR-004 D5): recusa com 403 a sessão com mais de 24 h, grants mínimos e `test:db` da recusa na emissão e na renovação. Depois, HITL de aplicação no projeto real (molde do HITL-023) | não | nada; o P18 (CA-15) depende dela, mesmo com o ADR-004 aceito por sobreposição do veto |
| **F1-EXT-05a → F1-EXT-05b → F1-EXT-05c → F1-SEC-01** | Resto do ADR-004, uma trilha por vez: Service Worker e manifesto (com `auth` no `CONTRACTS_ALLOWED` e o painel proibido de importá-lo), painel, E2E com IdP falso e threat model v2 | não | a trilha anterior (a F1-EXT-05a espera a F1-API-07) |

**O que vem depois:**
- **F1-API-07 concluída:** começa a F1-EXT-05a.
- **F1-EXT-05a concluída:** o envio à API (F1-EXT-04 parte 2) vira trilha.
- **HITL-036:** fechado em 2026-11-07 (P6 aprovado). O spike S-3 não depende mais dele.
- **F1-DB-02 concluída:** abre o HITL de aplicação do hook.
- **Spike S-3 completo (P1 a P20):** depois das F1-EXT-05x e da F1-DB-02. Depois dele, o fechamento do F1-EXT-05 pelos CAs do §4.10. O ADR-004 já está `aceito` por sobreposição do veto, mas o P3 e o P18 seguem obrigatórios. O **P9** confirma o formato real do `amr` (hoje só a lista de objetos do GoTrue passa).
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
    - **verificador (feito no 07d):** o `keysReady()` usa só o cache do `RemoteJWKSet` (a validade do cache decide a nova busca, não o cooldown). O `amr` exige todo método na lista, e a lista é parâmetro obrigatório do adapter. Quem assinar token de teste usa o `supabaseClaims`, que já traz `amr` oauth. **Os casos de uso (07f) tratam qualquer `ok: false` do `verify` depois do GoTrue como 503 `auth_token_fora_da_politica`**, inclusive o `amr`, e chamam o `keysReady()` antes do orçamento e do GoTrue (M-10);
    - **boot (07g):** o anel do refresh, as idades e o `API_BEHIND_PROXY` são lidos em falha fechada (o `amr` já é lido desde o 07d), e o boot recusa chave repetida entre o anel da pretensão e o do refresh;
    - **envio à API (F1-EXT-04 parte 2):** quando virar trilha, só envia com `consent.isGranted()` e com sessão, e um teste prova isso. O `source` leva `platform` e `extractorVersion`, a base do monitoramento dos seletores (spike-metrics §3.4 e §3.5).
11. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/` por script (o `auth.ts` é a §4.8 e o `index.ts` a §4.9), e a §9 ganha uma linha.
12. **E2E com fixture real:** cada teste de plataforma usa uma URL própria (o `clickAction` acha a aba pela URL), e a rota serve o CSS pelo nome do arquivo. Intermitência de `sem_acesso` vai para o QA-04.
13. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

---

## Próximo prompt (sessão nova)

```text
Equipe, sigam em ciclo estrito de DevSecOps. Trilha F1-API-07, commit 07e (limitador local pré-JWT, orçamento de saída e bulkhead), sem gastar cota e sem chamar o Supabase real. O push do branch está autorizado ao fim do escopo.

1. [ORCHESTRATOR]: leiam STATE.md (bloco "HITL-036 fechado e Trilha F1-API-07 em andamento", com o 07d), o ADR-004 D4 ("Ordem na borda" e passos 3 e 5), D8 (itens 4 e 5, com os tetos do P19), §4.2 ("Limitador local", "Proxy", "Orçamento de saída" e "Bulkhead"), §4.7 (M-16), §6.1 (ADR-014) e §6.3 (07e), e o ADR-014 (D4, D8 e §3, decisão de 2026-10-21). Confiram que 07a (c51b809), 07b (905d85f), 07c (86fe1ef) e 07d (7e6c5d5) estão no branch.
2. [ARCHITECT] + [APPSEC]: 07e = limitador local pré-JWT em memória (presentation/edge/pre-auth-limit.ts: janela deslizante, chave HMAC com o RATE_KEY_PEPPER, IPv6 por /64, auth_troca 10/min e auth_renovacao 30/min, 10.000 baldes com transbordo sem despejo, API_BEHIND_PROXY); orçamento de saída em janela deslizante de 300 s (application/auth/gotrue-egress.ts: troca até 14, total no /token até 74, renovacao com reserva mínima de 50%, consumido só depois do Zod e do open) e bulkhead de 4 com retryAfterSeconds 5. Os tetos do P19 (150 e 30 por 5 min por IP) ficam presos por teste. Nada disso fica ligado a rota antes do 07g (condição 1 do §6.3): o hook nasce testado com rota de prova, como o auth.test.ts faz com /probe. O limitador não substitui o Redis e falha para o lado restritivo (não é o ephemeral cache do T39).
3. [DEV] + [QA_EVALS]: TDD, 100% de cobertura, mutação M-16 (limiares +1, chave sem HMAC, transbordo que despeja, orçamento antes do open, bulkhead 5) e dirigidos (IPv6 fora do /64, X-Forwarded-For de IP não confiável aceito, reserva da renovação ignorada, janela fixa no lugar da deslizante), turbo em série e depcruise. Emenda do ADR-014 (D10 novo, D8 com a nova ordem dos hooks) marcada no ADR-004 §6.1. Se a sessão ainda estiver leve depois do commit, sigam para o 07f (casos de uso); senão, parem e reciclem (AGENTS §4.4).
4. [SCRIBE]: STATE a cada commit; no fim, SESSION-LOG, BACKLOG e o next-step reescrito mantendo as trilhas. Commit e push do spike/s1-extraction.
```
