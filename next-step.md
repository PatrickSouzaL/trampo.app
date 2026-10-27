# Próximo passo: trilhas paralelas enquanto a cota do Groq não zera

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie **um** dos prompts abaixo.

## O que acabou de ser entregue (2026-10-26)

### `g4` (commit `90867d9`, local, sem push; ADR-008 §6)
- Um termo que aparece nas duas listas de stack:
  - sai do `stackRequired` e fica no `stackNiceToHave`;
  - a comparação é em minúsculas, como no contrato, e contra o desejável final.
- Contador `stackOverlapsResolved`, fora do `injectionSignal`. Isso resolve as 3 recusas do Groq no aceite do `p2`.
- 13 testes e 2 propriedades novas. Mutação com 14 de 15 mortos (1 equivalente). A 1ª rodada achou 2 testes que faltavam, e eles foram escritos.

### `p3` (commit `61474d0`, local, sem push; ADR-020 §8)
- **Só a linha de stack mudou**, e um teste prova isso pelo hash do `p2`:
  - só entra nome de tecnologia;
  - conceito, prática e área ficam fora;
  - "vence nos dois" sai do prompt, porque o `g4` já garante essa regra.
- Nenhum falso positivo do aceite anterior (ETL, MDM...) virou exemplo no prompt.
- **Teto de tokens:** a conta offline usa a pior razão medida no `p2` (3,2 caracteres por token) e dá 393 tokens. O teto real de +400 é conferido no aceite.
- **Relatório do S-1:** o novo `previousComparisons` compara o `p3`/`g4` com o `p2`/`g3` nos mesmos casos e lista o que caiu mais de 2 pp. Foi provado sem gastar cota.

### Verificação
- API com 2.677 testes e cobertura de 100%.
- Turbo inteiro com 21 de 21 tarefas verdes, em série; depcruise sem violações.
- Mutação do prompt com 8 de 8 mortos.
- `[APPSEC]` sem veto. Nenhum pedido a provedor foi feito.

### Pendências do humano
- Nenhum HITL aberto. O push continua não autorizado.

---

## Como usar: trilhas

**Regra de ouro:** só a **Trilha A** espera a cota do Groq. As outras andam hoje, em qualquer ordem entre si.

| Trilha | Sessão | Gasta cota do Groq? | Espera a Trilha A? |
|---|---|---|---|
| **A** | Aceite do `p3`/`g4` | **sim, um dia inteiro** | — |
| **B1** | Desenho do adapter do Groq (sem código) | não | não |
| **B2** | Adapter do Groq, commits atômicos, **sem ligar no `main.ts`** | não | não (depende da B1) |
| **C** | QA-02 (testes de socket instáveis) | não | não |
| **D** | S-2 com fixtures sintéticas (extrator genérico e técnicas de ocultação do T2) | não | não |
| **E** | DOC-01 (sincronizar o `contratos-zod` do cofre com o código) | não | não |

**O que de fato espera a Trilha A:**
- ligar a cadeia Groq → Workers AI → determinístico no `main.ts`;
- fechar o S-1 (modelo primário e gate por modelo do F1-EVL-01).

Nada nas trilhas B a E depende do resultado do aceite.

**Cuidados para as trilhas não se atrapalharem:**
1. **Uma sessão por vez nesta pasta.** Todas usam o mesmo branch e o mesmo `STATE.md`. A Trilha A entra entre duas sessões quaisquer, assim que a cota zerar.
2. **Nenhuma sessão B a E muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`.** Se mudar, o aceite passa a medir outra coisa. Se uma sessão precisar mudar alguma das duas, ela para e registra no STATE.
3. **Nenhuma sessão B a E chama o Groq real.** Os testes usam *fakes*, e qualquer *smoke* com o provedor fica para a Trilha A.
4. Ao fim de cada sessão, o `[SCRIBE]` reescreve este arquivo **mantendo a tabela de trilhas**: tira a trilha concluída e acrescenta a que ela liberou.

**Sugestão de ordem para hoje:** B1 → C → B2 → D → E. A Trilha A entra quando a cota zerar. O humano estima 24 h depois da rodada do `p2`, feita em 2026-10-26.

**Algo que o humano pode adiantar durante o dia (opcional, sem bloquear nada):** para a parte real do S-2, salvar o HTML de 3 a 5 vagas do LinkedIn e da Gupy. Pela janela anônima, use "Salvar como → Página da Web, somente HTML", sem estar logado, e guarde **fora do repositório**. A Trilha D gera o runbook de anonimização antes de qualquer arquivo entrar no git.

---

## Prompts

### Trilha A: aceite do `p3`/`g4` (só com a cota do Groq zerada)
```text
Equipe, sigam em ciclo estrito. Trilha A do next-step: aceite do p3/g4 (spike-metrics §2.8, ADR-020 §8.4).
1. [ORCHESTRATOR]: leiam STATE.md, spike-metrics §2.7 e §2.8 e ADR-020 §8. Confirmem pnpm, Node, o branch spike/s1-extraction e que os HEADs do p3 e do g4 (61474d0 e 90867d9) estão no histórico. Confirmem com o humano que a cota do Groq zerou antes de qualquer chamada.
2. [QA_EVALS]: S1_MODE=plan (sem rede) e um smoke de 1 chamada por provedor. Depois, S1_MODE=run S1_BUDGETS=6000 S1_GROQ_VARIANT=nao_estrito, com saída em out/s1-results.p3-g4.jsonl, e S1_MODE=report.
3. [QA_EVALS] + [APPSEC]: julguem pelo gate (precisão de stack ≥ 0,85, recall ≥ 0,80, JSON válido ≥ 98% no Groq, +400 tokens sobre o p1, gate de segurança do gd2, regressões do previousComparisons e contador do g4). Revisem o T4 à mão e confiram que as linhas gravadas não têm texto de vaga, canário nem saída bruta.
4. [SCRIBE]: spike-metrics §2.8, ADR-020 §8.6, STATE e SESSION-LOG. Se o gate passar, o próximo passo é ligar a cadeia no main.ts (com o adapter do Groq, se a Trilha B2 já tiver terminado). Se falhar, abram um HITL com as opções. Reescrevam o next-step mantendo as trilhas que faltam.
```

### Trilha B1: desenho do adapter do Groq (sem código)
```text
Equipe, sigam em ciclo estrito. Trilha B1 do next-step: desenho do adapter do Groq (F1-LLM-01 parte 2, HITL-028 1A/2A e HITL-029 3A). Sem código nesta sessão, e sem chamar o Groq real.
1. [ORCHESTRATOR]: leiam STATE.md, ADR-020 (D2 a D9, que é o molde do adapter da Workers AI), ADR-009 D4 e §5, ADR-010 D5 e G3-4/G4-2 do ADR-008, spike-metrics §2.5 e o providers.ts do spike S-1 (a chamada do Groq que já funcionou: json_schema sem strict, reasoning_effort low, sem tools).
2. [ARCHITECT] + [APPSEC]: escrevam o ADR-022 (adapter do Groq) com critérios de aceite:
   - URL fixa e conferida no boot;
   - corpo de lista fechada sem tools (SR-01), com nao_estrito e o mesmo prompt compartilhado;
   - tetos de envio e de leitura e a tabela de status, incluindo o 400 json_validate_failed;
   - Retry-After e os limites do Groq (TPD de 200K, RPM e TPM) no QuotaLedger;
   - o token só no closure;
   - a emenda do teto de 3 s ao router (ADR-009 §5);
   - a emenda ao ADR-010 para levar os contadores do g3 e do g4 à telemetria.
   Façam a partição em commits atômicos. O adapter não é ligado no main.ts.
3. [SCRIBE]: ADR-022, STATE e SESSION-LOG, commit local. Reescrevam o next-step mantendo as trilhas (a B2 passa a ter a partição de commits do ADR-022).
```

### Trilha B2: adapter do Groq (depois da B1)
```text
Equipe, sigam em ciclo estrito. Trilha B2 do next-step: implementar o ADR-022 (adapter do Groq), um commit atômico por vez, na partição do próprio ADR, com testes, cobertura de 100% e mutação. Não liguem no main.ts e não chamem o Groq real (só fakes). Não mudem EXTRACTION_PROMPT_VERSION nem LLM_OUTPUT_GUARD_VERSION. [SCRIBE] atualiza STATE e ADR a cada commit (AGENTS §4.2). Se a sessão ficar extensa, parem entre dois commits e reescrevam o next-step mantendo as trilhas.
```

### Trilha C: QA-02
```text
Equipe, sigam em ciclo estrito. Trilha C do next-step: QA-02 (BACKLOG). Os testes de socket real com prazo de relógio de parede (limits-stack, upstash-cache-stack, postgrest-user-client, postgrest-criteria-repository, upstash-rest-client) falham às vezes com a CPU disputada.
1. [ORCHESTRATOR]: leiam STATE.md, a entrada QA-02 do BACKLOG e a decisão do QA-01 (o orçamento não é afrouxado). Reproduzam a falha com a suíte inteira, várias rodadas, e registrem a taxa.
2. [ARCHITECT] + [QA_EVALS]: escolham entre prazo injetado só nos testes (com a política de produção ainda provada pelo FakeClock), um projeto do Vitest em série para esses arquivos ou a primeira conexão medida à parte. Os prazos de produção (150 e 250 ms) não mudam.
3. [DEV] + [QA_EVALS]: implementem, provem com N rodadas da suíte inteira sem falha e rodem a mutação nos testes tocados.
4. [SCRIBE]: BACKLOG (QA-02), STATE e SESSION-LOG, commit local. Reescrevam o next-step mantendo as trilhas.
```

### Trilha D: S-2 com fixtures sintéticas
```text
Equipe, sigam em ciclo estrito. Trilha D do next-step: S-2 (BACKLOG), só a parte que não precisa de página real.
1. [ORCHESTRATOR]: leiam STATE.md, a entrada S-2 do BACKLOG, ADR-001 §5.0 e o threat-model T2 (técnicas de ocultação). Confirmem que F1-EXT-00 a 02 estão prontos.
2. [ARCHITECT] + [APPSEC]: desenhem o extrator genérico autocontido (para scripting.executeScript, sem innerHTML, sem ler atributos, ignorando display:none, visibility:hidden, font-size:0 e as demais técnicas do T2) e o formato das fixtures de DOM anonimizadas. Escrevam o runbook de coleta e anonimização das fixtures reais (o humano salva as páginas) e abram o HITL correspondente, que não bloqueia esta trilha.
3. [DEV] + [QA_EVALS]: extrator genérico e uma fixture adversarial sintética por técnica do T2, com o descarte provado, cobertura de 100% e mutação. Os extratores do LinkedIn e da Gupy esperam as fixtures reais.
4. [SCRIBE]: spike-metrics §3 (parcial), STATE e SESSION-LOG, commit local. Reescrevam o next-step mantendo as trilhas.
```

### Trilha E: DOC-01
```text
Equipe, sigam em ciclo estrito. Trilha E do next-step: DOC-01 (BACKLOG). [SCRIBE] + [ARCHITECT]: sincronizem o contratos-zod do cofre com packages/contracts. A fonte da verdade é o código: veredito de 5 faixas, ARS, pressao_excessiva, summary, reportCatalogVersion, o prefixo @cf/ do model e o teto de 12.288 bytes dos critérios. Nenhum código muda. Atualizem STATE e SESSION-LOG e reescrevam o next-step mantendo as trilhas.
```
