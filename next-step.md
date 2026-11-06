# Próximo passo: responder o HITL-035 (ação externa), depois a F1-AUTH-00 numa sessão nova

## O que acabou de ser entregue (2026-11-04)

### Trilha S3b: HITL-035 aberto, com o runbook `auth-extensao`
- **Runbook novo** `base/03-infra-runbook/auth-extensao.md`, sem nenhum valor de segredo e sem código de produto:
  - **parte 1, credenciais:** par RSA da extensão gerado pelo Node fora do repositório (a privada vai para o gerenciador de senhas e o `.pem` é apagado), `TRAMPO_EXTENSION_KEY` só com a pública, ID derivado, `chrome-extension://<id>` no `CORS_ALLOWED_ORIGINS`, anel da selagem separado do anel da pretensão;
  - **parte 2, painel do Supabase (D15):** Redirect URL única e exata, Email, Phone e Anonymous desligados, ES256 e 900 s, novos cadastros desligados depois da conta do autor, limites de taxa (P19) e o hook (P18);
  - **parte 3, pré-spike P4 a P8:** 8 casos (A a H) num perfil descartável, com funções de PowerShell que só imprimem nomes, status e booleanos, e logout `global` em cada sessão aberta.
- **QA do runbook, offline:** vetor do RFC 7636, derivação do ID conferida contra o Node, URL do `authorize` e leitura do retorno. O par de teste foi apagado.
- **Errata no ADR-004 §4.1:** o challenge do vetor do RFC 7636 estava errado (`E9Melhoe2…`). O certo é `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`. Sem a correção, o teste do `pkce.ts` falharia.
- **P18 pela documentação:** o Custom Access Token Hook aparece como "Free, Pro" e recusa a emissão com `http_code`. Falta só confirmar no painel.

### Antes (ainda valendo)
- **HITL-034 fechado:** valem as 14 recomendações do ADR-004 §7. O ADR continua `proposto` até o HITL-035, o pré-spike e o spike.
- **Trilhas D2a a D2d:** extratores `li1`, `li2`, `gu1` e `so1`, com o "ver mais" fechado no `li2` (ADR-023 D13). A intermitência do E2E está no QA-04.
- **Trilha W1:** `rpd` da Workers AI pelo p95 medido.
- **Trilha L1:** cadeia Groq → Workers AI → determinístico ligada no `main.ts`. Pendência do próximo prompt (`p4`): "`null` quando a vaga não declara experiência" em `yearsExperienceMin` (spike-metrics §2.11).
- **Trilhas F e G:** captura no Service Worker e UI do Side Panel, ainda sem enviar à API.

### Pendências do humano
- **HITL-035 (aberto):** siga o runbook `auth-extensao.md`. Partes 1 e 2 (cerca de 35 min) e o pré-spike (40 a 60 min). Responda também as 2 perguntas:
  1. Site URL até o S-5: (A) recomendada, `https://<id>.chromiumapp.org/`; (B) página estática numa origem nossa; (C) manter a atual, se não for `localhost`.
  2. Os runbooks `supabase-setup`, `upstash-redis` e `regiao-custo-zero` foram movidos, apagados de propósito, ou a equipe deve reescrevê-los?
- Nunca cole no chat código, token, chave ou URL de retorno. Só a saída das funções.
- O push continua não autorizado. Já são vários commits locais no `spike/s1-extraction`. Quando quiser, autorize o push e o PR.

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM. A API chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **F1-AUTH-00** | Contratos do ADR-004 D7 em `packages/contracts/src/auth.ts`, export `./auth`, `ACCESS_TOKEN_MAX_CHARS` em `limits.ts` (fonte única), com os ajustes que o pré-spike pedir (nome do campo do código, `AuthCodeSchema` como UUID ou não, com ou sem `state`). Cobertura de 100% e DOC-01 | não | HITL-035 fechado, com o P4 e o P8 aprovados |
| **F1-API-07 → F1-EXT-05a/b/c → F1-SEC-01** | Resto da implementação do ADR-004, uma trilha por vez (BFF na API, Service Worker e manifesto, painel, E2E com IdP falso, threat model v2) | não | a trilha anterior |

**O que vem depois:**
- **HITL-035 fechado e pré-spike aprovado:** começa a F1-AUTH-00 (contratos), a primeira trilha de implementação do ADR-004. Se o P4, o P7 ou o P8 falharem, vale o recuo do D14 (o ADR volta a desenho, com HITL novo), e nenhuma trilha de implementação começa.
- **Site URL (pergunta 1 do HITL-035):** com a opção A, a F1-AUTH-00 aplica a emenda ao D15 do ADR-004.
- **F1-EXT-05a concluída:** o envio à API (F1-EXT-04 parte 2) vira trilha.

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`.
2. **Nenhuma sessão muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`** sem um HITL mandar. O próximo prompt (`p4`) carrega a linha do `null` de `yearsExperienceMin` e passa pelo aceite completo (§8.1 por efeito, §8.3 com ruído).
3. **Nenhuma trilha chama provedor.** Para testar a API à mão, lembre que ela agora gasta cota do Groq.
4. **O avaliador do S-1 tem a equivalência de nome** (`stackKey` no `score.ts`). Ninguém muda a regra sem refazer o relatório de todas as versões e o `s1-effect.json`.
5. **O critério de stack é o efeito na nota** (golden-dataset-spec §8.1), e o **§8.3 tem o ruído**. Cada aceite novo de prompt ou guard roda o `S1_MODE=effect` e, se cair mais de 2 pp, o `S1_MODE=noise`.
6. **A cadeia de produção passa pelo `composeProductionApp`.** Provedor novo ou troca de modelo exige o gate do golden dataset antes (T28).
7. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts`.
8. **Fixtures reais:** qualquer fixture nova ou alterada passa de novo pelo runbook fixtures-dom §2 a §4 e pelas emendas do §8 (script fora do repositório, varredura antes do `git add`, commit próprio). O trecho proibido precisa existir na página e não pode aparecer na raiz da vaga; o recolhido (com "ver mais" fechado) precisa entrar no texto (ADR-023 D13).
9. **O extrator é um só** (`job-extractor.ts`, ADR-023 D11 e D12):
   - a regra de descarte (D4) vale para todas as plataformas, e qualquer mudança nela passa pelo `test:browser` inteiro, com a cobertura de 100% e a mutação;
   - cada seletor de plataforma tem a sua versão (`li2` logado, `li1` público, `gu1`, `so1`); seletor novo ganha versão nova e precisa de fixture real no gate;
   - o *clamp* só deixa de cortar na própria raiz de uma versão com `verMais` (hoje só o `li2`, D13); estender isso a outra raiz passa pelo `[APPSEC]`;
   - **depois que o envio à API existir, qualquer mudança no D4 muda todas as versões**;
   - o texto da vaga não vai ao painel (ADR-024 D4), link é proibido por lint, e erro sai do catálogo pelo `code` (ADR-025).
10. **A autenticação segue o ADR-004 (desenho aprovado no HITL-034, com as 14 recomendações):** o token só no Service Worker; o painel nunca lê `storage` nem recebe token; o extrator nunca recebe nada da sessão.
    - **O envio à API (F1-EXT-04 parte 2)**, quando virar trilha, só envia com `consent.isGranted()` e com sessão, e um teste prova isso. O `source` leva `platform` e `extractorVersion`, a base do monitoramento dos seletores (spike-metrics §3.4 e §3.5).
11. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/`, e a §9 ganha uma linha.
12. **E2E com fixture real:** cada teste de plataforma usa uma URL própria (o `clickAction` acha a aba pela URL), e a rota serve o CSS pelo nome do arquivo. Intermitência de `sem_acesso` vai para o QA-04.
13. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

---

## Próximo prompt (sessão nova, depois do HITL-035)

```text
Equipe, sigam em ciclo estrito. HITL-035: 
HITL-035 parte 1 concluída.

HITL-035 parte 2 concluída:
- Site URL = A
- P18: disponível no painel
- P19: Token Refresh = 150 requests/5 min per IP; Sign-up/sign-in = 30 requests/5 min per IP.
- Pergunta 2 (Runbooks): Apagados de propósito (arquitetura BFF no Edge os tornou obsoletos).

HITL-035 parte 3 concluída (pré-spike validado, nenhum recuo da Etapa 6 acionado):
- Caso A: st_volta_igual True, code na query. 1ª troca HTTP 200 (access_token retornado). 2ª troca falhou (HTTP 404, flow_state_not_found). P4, P5, P7 e P8 aprovados.
- Caso B (Sem verifier): status ≠ 200. P8 aprovado.
- Caso C (Verifier errado): status ≠ 200. P8 aprovado.
- Caso D (Código vencido): status ≠ 200 (minutos_do_code > 5). P8 aprovado.
- Caso E (Fora da lista): host_igual Falso. P6 aprovado.
- Caso F (Caminho arbitrário): bloqueado/não resolveu via Site URL raiz. P6 aprovado.
- Caso G (Negação): code_presente Falso, error_code e error_description presentes. P4 aprovado.
- Caso H (Google feliz): Fluxo completo com sucesso. P4 e P7 aprovados.

Todos os portões do AppSec (P4 a P8) foram integralmente aprovados. Pode iniciar a F1-AUTH-00 imediatamente: 


1. [ORCHESTRATOR]: leiam STATE.md, HITL-QUEUE (HITL-035), o runbook auth-extensao §3.2 e o ADR-004 (§1.4, §3, D7, D14, D15).
2. [QA_EVALS] + [APPSEC]: registrem P4 a P8, P18 e P19 no spike-metrics §4, com o veredito de cada ponto pelo critério do §1.4. Se o P4, o P7 ou o P8 falharem: parem, apliquem o recuo do D14 e abram um HITL novo, sem código.
3. Se passarem: [ARCHITECT] ajusta o D7 ao que o pré-spike mostrou (nome do campo do código, AuthCodeSchema, state ou Q6) e, com a opção A da pergunta 1, emenda o D15; [DEV] + [QA_EVALS] fazem a F1-AUTH-00 (packages/contracts/src/auth.ts, export ./auth, ACCESS_TOKEN_MAX_CHARS em limits.ts, 100% de cobertura, contratos-zod §4 e §9).
4. [SCRIBE]: fechem o HITL-035, atualizem BACKLOG, STATE e SESSION-LOG e reescrevam o next-step mantendo as trilhas. Commit local, sem push.
```
