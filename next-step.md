# Próximo passo: o HITL-034 (aprovar o ADR-004); sem esperar por ele, a Trilha D2d numa sessão nova

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie o prompt do fim deste arquivo. A esteira principal (login na extensão e envio à API) espera o HITL-034.

## O que acabou de ser entregue (2026-10-31): batelada D2c → W1 → S3a

### Trilha D2c: LinkedIn logado e Solides (HITL-033 fechado; S-2 e F1-EXT-03 parte 3)
- **Commits `08a8fd4`** (só as fixtures) **e `1a0dcb8`** (código), locais e sem push.
- **Fixtures:** 3 buscas do LinkedIn logado e 4 da Solides, com o CSS da plataforma. Marcadores: `[PESSOA]` 2, `[EMPRESA]` 2, `[ENDERECO]` 2 e `[URL]` 1. Revisão de PII por 7 revisores independentes, sem achado bloqueante.
  - O gitleaks local **não rodou**: a execução do binário oficial (versão e SHA-256 conferidos contra o CI) foi negada pela política de permissões. As regras de segredo dele foram refeitas em script, com 0 ocorrências. O job `secrets` do CI confere no push.
- **`li2`** (LinkedIn logado): só a descrição do painel da vaga. O painel também traz blocos tirados do perfil e da rede do usuário, que ficam de fora.
  - **Falha fechada:** no layout logado (`main#workspace`) sem a descrição, nada é lido (`texto_insuficiente`), e o painel oferece colar o texto.
  - O `li1` continua na página pública, e o `ge1` fica como último caso fora dos layouts reconhecidos.
- **`so1`** (Solides): `#vacancy-box-details`. Sem `main`, o `ge1` caía no `body` com a lista inteira. O `platformForUrl` reconhece `vagas.solides.com.br`, e o `PlatformSchema` do contrato ganhou `solides`.
- **Emenda ao D4 (ADR-023 D12):** num rolável interno, vale o que a rolagem alcança. Sem isso, o *app shell* do LinkedIn logado cortava a descrição inteira. As 21 fixtures antigas dão o mesmo resultado.
- **"Ver mais" fechado:** o `li2` lê só as 6 primeiras linhas (382 caracteres no `linkedin-08`). A decisão é a Trilha D2d.
- **Prova:** unidade 180/180 com 100%; contratos 91/91; `test:browser` 136/136 com a cobertura de bloco de 100%; E2E 37/37 no build de produção (a prova negativa derruba os 3 testes novos); mutação 66/66; depcruise e turbo 21/21 em série.

### Trilha W1: `rpd` da Workers AI pelo p95 medido (emenda ao ADR-020 D9)
- **Commit `42977c9`**, local e sem push. Nenhuma chamada a provedor.
- `floor(10.000 ÷ 101)` = 99 publicado e 84 efetivo por dia (antes, 54 e 45). A medida fica em `WORKERS_AI_NEURON_MEASUREMENT`, no padrão do `GROQ_TOKEN_MEASUREMENT`.
- Um teste prova que o breaker global (400 por dia) e o TPD do Groq (56 por dia com a reserva cheia) continuam mandando.
- **Prova:** API com 2.903 testes e 100%; mutação 12/12; turbo 21/21 em série.

### Trilha S3a: desenho da autenticação da extensão (S-3 itens 3 e 4, F1-EXT-05), sem código
- **ADR-004** (`base/02-arquitetura/ADRs/ADR-004-extension-auth.md`) com `status: proposto`. A aprovação é o **HITL-034**, com 14 perguntas e uma recomendação para cada.
- **Desenho:** `chrome.identity.launchWebAuthFlow` com PKCE S256 aberto pelo Service Worker; troca, renovação e logout por um BFF sem estado na API; refresh selado num envelope que só a API abre, com idade máxima e inatividade; tokens só em `storage.session`, manipulados só pelo Service Worker; o painel vê só `{ autenticado, erro }` com os códigos do ADR-025; manifesto com só `identity` e a `key` a mais.
- **Como foi feito:** 3 propostas independentes, 3 juízes (unanimidade no BFF) e revisão adversarial em três lentes (AppSec, QA e consistência), com 51 achados aplicados.
- **Honesto sobre o limite:** o Chrome deixa o painel ler o `storage.session`. A separação é por código (lint, depcruise, grep do build e meta CSP no painel), provada por canários e heap snapshot no E2E.

### Antes (ainda valendo)
- **Trilhas D2a e D2b:** fixtures reais e extratores `li1` e `gu1`.
- **Trilha L1:** cadeia Groq → Workers AI → determinístico ligada no `main.ts`. Pendência do próximo prompt (`p4`): "`null` quando a vaga não declara experiência" em `yearsExperienceMin` (spike-metrics §2.11).
- **Trilhas F e G:** captura no Service Worker e UI do Side Panel, ainda sem enviar à API.

### Pendências do humano
- **HITL-034:** aprovar o ADR-004 e responder as 14 perguntas do §7 ("HITL-034: aprovado com as recomendações", ou só as perguntas que mudarem). Bloqueia o login na extensão (F1-EXT-05) e, por tabela, o envio à API.
- **Depois do HITL-034:** a equipe abre o HITL-035 (par de chaves da extensão, anel de chaves da selagem e configuração do Auth no painel do Supabase). Nenhum segredo vai para o cofre.
- **Inconsistência do cofre a esclarecer:** o HITL-004 diz que o runbook `supabase-setup` foi mantido, mas ele não existe em `base/03-infra-runbook/` (também faltam `upstash-redis` e `regiao-custo-zero`). O HITL-035 vai perguntar se foram movidos ou apagados.
- O push continua não autorizado. Já são vários commits locais no `spike/s1-extraction`. Quando quiser, autorize o push e o PR.

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM. A API chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **D2d** | "Ver mais" fechado no LinkedIn logado: hoje o `li2` lê só as 6 primeiras linhas. Opções: (a) o painel avisa para abrir o "ver mais" e capturar de novo, sem mudar o D4; (b) exceção do *clamp* só para a caixa da descrição, com emenda ao ADR-023 e auditoria do `[APPSEC]`. Recomendação: (a) | não | nada |
| **F1-AUTH-00 → F1-API-07 → F1-EXT-05a/b/c → F1-SEC-01** | Implementação do ADR-004, uma trilha por vez (contratos, BFF na API, Service Worker e manifesto, painel, E2E com IdP falso, threat model v2) | não | HITL-034, HITL-035 e o pré-spike manual (P4 a P8) |

**O que vem depois:**
- **HITL-034 aprovado:** o `[SCRIBE]` abre o HITL-035 e o roteiro do pré-spike manual (sem código de produto).
- **F1-EXT-05a concluída:** o envio à API (F1-EXT-04 parte 2) vira trilha.

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`.
2. **Nenhuma sessão muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`** sem um HITL mandar. O próximo prompt (`p4`) carrega a linha do `null` de `yearsExperienceMin` e passa pelo aceite completo (§8.1 por efeito, §8.3 com ruído).
3. **Nenhuma trilha chama provedor.** Para testar a API à mão, lembre que ela agora gasta cota do Groq.
4. **O avaliador do S-1 tem a equivalência de nome** (`stackKey` no `score.ts`). Ninguém muda a regra sem refazer o relatório de todas as versões e o `s1-effect.json`.
5. **O critério de stack é o efeito na nota** (golden-dataset-spec §8.1), e o **§8.3 tem o ruído**. Cada aceite novo de prompt ou guard roda o `S1_MODE=effect` e, se cair mais de 2 pp, o `S1_MODE=noise`.
6. **A cadeia de produção passa pelo `composeProductionApp`.** Provedor novo ou troca de modelo exige o gate do golden dataset antes (T28).
7. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts`.
8. **Fixtures reais:** qualquer fixture nova ou alterada passa de novo pelo runbook fixtures-dom §2 a §4 e pelas emendas do §8 (script fora do repositório, varredura antes do `git add`, commit próprio). O trecho proibido precisa existir na página e não pode aparecer na raiz da vaga; o recolhido (com "ver mais" fechado) também precisa existir na página.
9. **O extrator é um só** (`job-extractor.ts`, ADR-023 D11 e D12):
   - a regra de descarte (D4) vale para todas as plataformas, e qualquer mudança nela passa pelo `test:browser` inteiro, com a cobertura de 100% e a mutação;
   - cada seletor de plataforma tem a sua versão (`li2` logado, `li1` público, `gu1`, `so1`); seletor novo ganha versão nova e precisa de fixture real no gate;
   - **depois que o envio à API existir, qualquer mudança no D4 muda todas as versões**;
   - o texto da vaga não vai ao painel (ADR-024 D4), link é proibido por lint, e erro sai do catálogo pelo `code` (ADR-025).
10. **A autenticação segue o ADR-004 aprovado:** o token só no Service Worker; o painel nunca lê `storage` nem recebe token; o extrator nunca recebe nada da sessão.
    - **O envio à API (F1-EXT-04 parte 2)**, quando virar trilha, só envia com `consent.isGranted()` e com sessão, e um teste prova isso. O `source` leva `platform` e `extractorVersion`, a base do monitoramento dos seletores (spike-metrics §3.4 e §3.5).
11. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/`, e a §9 ganha uma linha.
12. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

---

## Próximo prompt (sessão nova, sem esperar o HITL-034)

```text
Equipe, sigam em ciclo estrito. Trilha D2d do next-step: "ver mais" fechado no LinkedIn logado (ADR-023 D12).
1. [ORCHESTRATOR]: leiam STATE.md, ADR-023 (D4 e D12), ADR-024, ADR-025 e spike-metrics §3.5.
2. [ARCHITECT] + [APPSEC]: decidam entre (a) aviso no painel para abrir o "ver mais" e capturar de novo, sem mudar o D4, e (b) exceção do clamp só para a caixa da descrição da plataforma. Registrem a decisão no ADR-023.
3. [DEV] + [QA_EVALS]: implementem com 100% de unidade, test:browser (fixture linkedin-08), E2E no build de produção, mutação e turbo em série. Nenhuma chamada a provedor.
4. [SCRIBE]: ADR-023, ADR-025 (se mexer no painel), BACKLOG, STATE, SESSION-LOG e commit local. Reescrevam o next-step mantendo as trilhas.
```
