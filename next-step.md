# Próximo passo: Trilha W1 (curta) ou S3a (desenho da autenticação da extensão), numa sessão nova

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie um dos prompts abaixo. Nenhuma trilha espera o humano agora.

## O que acabou de ser entregue (2026-10-31)

### Trilha D2b: extratores do LinkedIn e da Gupy (S-2, parte 2; F1-EXT-03 parte 2)
- **Commits `c664056`** (correção de 4 fixtures) **e `5c2dd4e`** (código), locais e sem push. Nenhum prompt, guard, contrato ou permissão mudou.
- **Desenho** (ADR-023 D11): uma função só, `extractJobText(limites, plataforma)` em `src/extraction/job-extractor.ts` (o antigo `generic-extractor.ts`).
  - A plataforma escolhe só a raiz, e a regra de descarte (D4) continua uma só.
  - `li1`: `.details-pane__content`. `gu1`: `main#main`. Sem a raiz visível, roda o `ge1`.
  - A raiz da plataforma achada decide mesmo com pouco texto, para a lista do LinkedIn nunca entrar no lugar da vaga.
- **Service Worker** (ADR-024 §6):
  - o `platformForUrl` lê só o host da URL que o `activeTab` entrega no clique (`https`, `linkedin.com`/`*.linkedin.com`, `*.gupy.io`; o resto vai para o genérico);
  - a URL não é guardada nem registrada;
  - a versão do retorno precisa bater com a plataforma pedida, e o `CapturedJob` ganha `linkedin` e `gupy`.
- **Fixtures:** em 4 das 7 páginas do LinkedIn, o trecho proibido da D2a era o título da própria vaga aberta. Ele foi trocado por outro cartão da lista (só os `.json`, varredura do §4 limpa).
- **Medição** (spike-metrics §3.4):
  - `li1` 21/21 trechos (o `ge1` dava 0/21), `gu1` 21/21 e `ge1` na GeekHunter 21/21, sem nenhum proibido;
  - o genérico nas três: GeekHunter 7/7, Gupy 7/7 e LinkedIn 0/7. **A GeekHunter não justifica extrator próprio**, e nenhum HITL foi aberto para ela;
  - **`maxNodes` fica em 50.000:** a maior página tem 4.875 nós, e o teto lido inteiro leva 541 ms;
  - **monitoramento:** `linkedin`/`gupy` com `ge1` na telemetria quer dizer seletor quebrado; alarme acima de 20% num dia e recoleta trimestral.
- **Prova:**
  - unidade 168/168 com 100%;
  - `test:browser` 108/108, com a cobertura de bloco de 100% e o gate nas 21 fixtures reais;
  - E2E no build de produção 34/34, com o host real do LinkedIn e da Gupy roteado para as fixtures, e prova negativa;
  - mutação 32/32; lint, typecheck, depcruise e turbo 21/21 em série.
- **`[APPSEC]`:** sem veto. Residual: o **LinkedIn logado** não foi medido (as fixtures são públicas). Nele, o `li1` cai no `ge1`, que pode pegar a lista junto com a vaga. Isso virou o **HITL-033** (opcional).
- **Atualizados:** ADR-023 (D11 e §6), ADR-024 §6, spike-metrics §3.4, fixtures-dom §7, BACKLOG, HITL-QUEUE, STATE e SESSION-LOG.

### Antes (ainda valendo)
- **Trilha D2a** (`994d782`, `f7eac1f`): 21 fixtures reais anonimizadas.
- **Trilha L1** (`adb392d`): cadeia Groq → Workers AI → determinístico ligada no `main.ts`.
  - Pendência do próximo prompt (`p4`): "`null` quando a vaga não declara experiência" em `yearsExperienceMin` (spike-metrics §2.11).
- **Trilhas F e G** (`3ec75a5`, `d15ee9b`): captura no Service Worker e UI do Side Panel, ainda sem enviar à API.

### Pendências do humano
- Nenhuma bloqueia trilha.
- **HITL-033 (opcional):** salvar de 2 a 3 vagas do LinkedIn **logado**, mantendo o CSS sem extensão. Isso dá o seletor logado (`li2`) e a medida do "ver mais" fechado. Vale fazer antes do envio à API.
- O push continua não autorizado, e já são vários commits locais no `spike/s1-extraction`. Quando quiser, autorize o push e o PR.

---

## Como usar: trilhas

**Regra de ouro:** nenhuma trilha da tabela gasta cota de LLM. A API chama o Groq de verdade quando sobe, então quem subir a API localmente para testar à mão gasta cota real.

| Trilha | Sessão | Gasta cota? | Espera |
|---|---|---|---|
| **W1** | Calibrar o `rpd` da Workers AI pelos neurônios medidos (74 de média, 101 de p95 → 99 publicado e 84 efetivo; emenda ao ADR-020 D9, com teste da fórmula) | não | nada (sessão curta, do lado seguro) |
| **S3a** | Desenho do S-3 (autenticação da extensão, F1-EXT-05): ADR-004 como proposta, sem código. Destrava o envio à API (F1-EXT-04 parte 2) | não | nada (termina num HITL de aprovação do ADR) |

**O que vem depois:**
- **S3a concluída e aprovada:** a implementação do F1-EXT-05 e, em seguida, o envio à API (F1-EXT-04 parte 2) viram trilhas.
- **HITL-033 respondido:** uma trilha curta acrescenta o seletor do LinkedIn logado (`li2`) e mede o "ver mais" fechado.

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`.
2. **Nenhuma sessão muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`** sem um HITL mandar. O próximo prompt (`p4`) carrega a linha do `null` de `yearsExperienceMin` e passa pelo aceite completo (§8.1 por efeito, §8.3 com ruído).
3. **Nenhuma trilha chama provedor.** Para testar a API à mão, lembre que ela agora gasta cota do Groq.
4. **O avaliador do S-1 tem a equivalência de nome** (`stackKey` no `score.ts`). Ninguém muda a regra sem refazer o relatório de todas as versões e o `s1-effect.json`.
5. **O critério de stack é o efeito na nota** (golden-dataset-spec §8.1), e o **§8.3 tem o ruído**. Cada aceite novo de prompt ou guard roda o `S1_MODE=effect` e, se cair mais de 2 pp, o `S1_MODE=noise`. Hoje este último está preso ao `p3`/`g4`; uma versão nova ajusta a trava na mesma tarefa.
6. **A cadeia de produção passa pelo `composeProductionApp`.** Provedor novo ou troca de modelo exige o gate do golden dataset antes (T28), e o teste do `main.ts` confere que ele não recebe ganchos de teste.
7. **Testes novos de socket real seguem o QA-02**, com o prazo folgado de `test/support/socket-deadlines.ts` para protocolo e fluxo.
8. **Fixtures reais:** qualquer fixture nova ou alterada passa de novo pelo runbook fixtures-dom §2 a §4 (script no scratchpad, varredura antes do `git add`, commit próprio). O trecho proibido precisa existir na página e não pode aparecer na raiz da vaga (§7); o gate confere.
9. **O extrator é um só** (`job-extractor.ts`, ADR-023 D11):
   - a regra de descarte (D4) vale para todas as plataformas, e qualquer mudança nela passa pelo `test:browser` inteiro, com a cobertura de 100% e a mutação;
   - seletor novo de plataforma muda a versão (`li1` → `li2`), entra na tabela literal dentro da função e precisa de fixture real no gate;
   - o texto da vaga não vai ao painel (ADR-024 D4), link é proibido por lint, e erro sai do catálogo pelo `code` (ADR-025).
10. **O envio à API (F1-EXT-04 parte 2) ainda não é trilha.** Quando for, o Service Worker só envia com `consent.isGranted()`, e um teste prova isso. O `source` leva `platform` e `extractorVersion`, que são a base do monitoramento dos seletores (spike-metrics §3.4).
11. **Mudança de contrato atualiza o cofre na mesma tarefa** (DOC-01): a §4 do `contratos-zod` é regerada do `src/`, e a §9 ganha uma linha.
12. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

**Sugestão de ordem:** a W1, que é curta, e depois a S3a.

---

## Prompts

### Trilha W1: `rpd` da Workers AI pelos neurônios medidos
```text
Equipe, sigam em ciclo estrito. Trilha W1 do next-step: recalibrar o rpd da Workers AI (emenda ao ADR-020 D9).
1. [ORCHESTRATOR]: leiam STATE.md, ADR-020 D9 e §9, ADR-014 D6 e spike-metrics §2.8 (neurônios: 74 de média, 101 de p95).
2. [ARCHITECT] + [APPSEC]: a fórmula passa a usar o p95 medido (floor(10.000 ÷ 101) = 99 publicado, 84 efetivo), com a medida no código como no GROQ_TOKEN_MEASUREMENT; confiram que o breaker global (400/dia) e o TPD do Groq continuam mandando.
3. [DEV] + [QA_EVALS]: limit-policy.ts e testes (fórmula com medidas sintéticas, 100%, mutação, turbo em série). Nenhuma chamada a provedor.
4. [SCRIBE]: ADR-020 (emenda ao D9), STATE, SESSION-LOG e commit local. Reescrevam o next-step mantendo as trilhas.
```

### Trilha S3a: desenho da autenticação da extensão (S-3, F1-EXT-05), sem código
```text
Equipe, sigam em ciclo estrito. Trilha S3a do next-step: desenho do S-3 (autenticação da extensão, F1-EXT-05) como proposta.
1. [ORCHESTRATOR]: leiam STATE.md, BACKLOG (S-3, F1-EXT-05, F1-EXT-04), ADR-001 §5.0 (item 6: token só no Service Worker), ADR-013 (JWT ES256, JWKS), ADR-024, ADR-025 e o threat-model (T9, T22).
2. [ARCHITECT] + [APPSEC]: ADR-004 com status proposto: como a extensão obtém o JWT do Supabase (chrome.identity.launchWebAuthFlow ou o portal), onde o token vive (só storage.session no Service Worker), renovação, revogação, logout e o que o painel vê. Sem host_permissions amplos; listar o que muda no manifesto, se algo mudar.
3. Sem código. [QA_EVALS]: critérios de aceite e o plano de teste (unidade, E2E com IdP falso, prova de que o token nunca chega ao painel nem ao extrator).
4. [SCRIBE]: ADR-004 proposto, HITL de aprovação na HITL-QUEUE, STATE, SESSION-LOG. Reescrevam o next-step mantendo as trilhas.
```
