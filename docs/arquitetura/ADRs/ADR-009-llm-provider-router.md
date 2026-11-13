---
tipo: adr
id: ADR-009
titulo: "LlmProviderRouter (Camada 3): portas em application, prazo global com orçamento de 2 chamadas, 429 com troca e resfriamento, circuit breaker por provedor, QuotaLedger que falha fechado e guarda de saída no router"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]), dentro do ADR-001 §5.5 (C9) aprovado no HITL-001 e da cadeia do HITL-012. Não muda contrato público."
data: 2026-10-19
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "F1-LLM-03 (apps/api/src/application/llm e apps/api/src/application/ports)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-008-llm-output-guard](ADR-008-llm-output-guard.md)", "[threat-model](../threat-model.md)", "*HITL-QUEUE*", "*BACKLOG*"]
---

# ADR-009: `LlmProviderRouter` (Camada 3)

## 1. Contexto

O ADR-001 §5.5 define a política da Camada 3: cadeia configurável, prazo global de 12 s, no máximo 2 chamadas de LLM por análise, retry só para rede ou 5xx, troca imediata no 429 com `Retry-After`, *circuit breaker* por provedor e `QuotaLedger` com folga. O threat model cobra isso em T7 (exaustão de cota e custo), T28 (*downgrade* de provedor), T30 (indisponibilidade do free tier) e T39 (limitador que falha aberto).

Esta tarefa entrega **só** o router, as portas e *fakes* de teste. Os adapters HTTP (Groq e Cloudflare) dependem do S-1 (HITL-003) e o `QuotaLedger` em Redis depende do HITL-007.

## 2. Decisões

### D1. Portas em `apps/api/src/application/ports`
Interfaces, sem implementação de rede. A fronteira do ADR-008 D1 continua: `application` só importa `zod` e `@trampo/contracts`.

```ts
interface Clock { nowMs(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }  // monotônico
interface Random { next(): number }                                                          // [0, 1)
interface JobFactsExtractor {                                                                // um por provedor
  readonly provider: LlmProviderId; readonly model: string;
  call(payload: LlmJobPayload, attempt: { signal: AbortSignal; timeoutMs: number }): Promise<ProviderCallOutcome>;
}
type ProviderCallOutcome =
  | { ok: true; raw: string; usage: TokenUsage }
  | { ok: false; failure: 'limite_de_taxa'; retryAfterMs: number | null }
  | { ok: false; failure: 'erro_transitorio' | 'erro_permanente' };
interface QuotaLedger {
  reserve(provider, signal): Promise<'permitido' | 'provedor_esgotado' | 'global_esgotado'>;
  recordUsage(provider, usage): Promise<void>;
}
interface ProviderStateStore { get(provider): ProviderState; set(provider, state): void }
```

- **`LlmJobPayload` tem um único campo, `text`** (o texto selecionado pelo `RelevantSectionSelector`). Não existe campo para perfil, critérios, `userId`, token ou URL (D2 do ADR-001; AGENTS §1.3). O router entrega ao adapter **o mesmo objeto** que recebeu.
- **`Clock.sleep` resolve, nunca rejeita**, inclusive quando o `signal` aborta. É a base do *timeout* por tentativa e do *jitter*, e permite um relógio falso de eventos discretos nos testes.
- `Random` é injetado para o *jitter* ser determinístico nos testes.
- O `ProviderStateStore` é **síncrono** e a implementação de produção é `InMemoryProviderStateStore` (por processo). O estado compartilhado entre instâncias é decisão do S-5 (hospedagem); se vier a ser Redis, a porta muda num ADR próprio.

### D2. O router roda a guarda de saída, não o adapter (refina o ADR-008 D2)
- O ADR-008 dizia que o adapter chama o guard. Aqui o **adapter devolve a string bruta** e **o router chama o `LlmOutputGuard`**. Assim é **impossível** um provedor entregar fatos sem a guarda, e a guarda é a mesma para todos (T28, mitigação 2).
- Falha do guard vira `saida_invalida`, conta como falha do provedor no *breaker* e libera a 2ª chamada em **outro** provedor. O motivo do guard (enum fechado) vai para a trilha.

### D3. Resultado fechado, sem texto do LLM e sem dado de perfil
```ts
type ExtractionOutcome =
  | { ok: true; facts: JobFacts; sanitization: LlmOutputSanitization; provider; model; usage; trail }
  | { ok: false; reason: 'timeout' | 'limite_de_taxa' | 'saida_invalida' | 'erro_provedor' | 'circuito_aberto' | 'cota_esgotada'; trail };
type RouterTrailEntry = { provider: LlmProviderId; outcome: <reason> | 'ok'; called: boolean; guardRejection?: LlmOutputRejection };
```
- **Nunca lança.** Qualquer exceção de adapter, ledger ou store vira um motivo do enum.
- A trilha só tem enums e booleanos: serve para métrica e telemetria (F1-OBS-01) sem carregar resposta, prompt ou vaga (SR-12). O router **não tem logger**.
- O `reason` final é o da última etapa da cadeia; prazo insuficiente dá `timeout`, cota global ou ledger com falha dá `cota_esgotada`.

### D4. Prazo global e por tentativa
| Constante | Valor | Regra |
|---|---|---|
| `ANALYSIS_DEADLINE_MS` | 12.000 | O chamador (F1-API-04) cria o `Deadline` no início da análise com `deadlineAfter(clock, ANALYSIS_DEADLINE_MS)`. |
| `ATTEMPT_TIMEOUT_MAX_MS` | 10.000 | Cada chamada recebe `min(10 s, restante − 300 ms)`. |
| `DEADLINE_RESERVE_MS` | 300 | Folga para o resto do funil (fusão, nota e resposta). |
| `MIN_ATTEMPT_MS` | 2.500 | Com menos que isso restante, **não chama**: vai para o fallback com `timeout`. |
| `LEDGER_TIMEOUT_MS` | 250 | Teto do `reserve`. Estourou: falha fechado (D6). |

- O *timeout* é uma corrida entre a chamada e `clock.sleep(timeoutMs)`. Quem perde é abortado pelo `AbortSignal` (o adapter cancela o HTTP), e uma rejeição tardia é absorvida.
- Consequência provada por propriedade: **o router sempre resolve até o prazo**, porque nenhuma etapa começa sem `MIN_ATTEMPT_MS` restantes e toda etapa tem teto.

> **Emenda desenhada (§5, 2026-10-25, *HITL-QUEUE §HITL-028* 2A):** o `ATTEMPT_TIMEOUT_MAX_MS` passa a ser **por provedor**, com 3 s no Groq e 10 s nos demais. Entra no código com o adapter do Groq (F1-LLM-01 parte 2).

### D5. Orçamento, retry, 429 e saída inválida
- **No máximo 2 chamadas (`MAX_LLM_CALLS_PER_ANALYSIS`) por análise**, somando retry e troca de provedor. Pular um provedor (resfriamento, *breaker* aberto, cota) **não** gasta orçamento.
- **Retry** só para `erro_transitorio` (rede ou 5xx): uma vez, no mesmo provedor, depois de *jitter* de 200 a 600 ms, se o orçamento e o prazo (`MIN_ATTEMPT_MS` depois do *jitter*) permitirem e o *breaker* ainda admitir. Nunca para `erro_permanente` (4xx), 429 ou *timeout*.
- **HTTP 429:** troca **imediata** de provedor. O provedor entra em resfriamento por `Retry-After` limitado a [1 s, 120 s]; sem o cabeçalho, ou com valor inválido, 60 s. O 429 **não** conta como falha no *breaker*: o provedor está vivo, só sem cota.
- **Timeout, `erro_permanente` e saída inválida:** contam como falha e passam ao próximo provedor.

### D6. Circuit breaker por provedor e cota
- **Breaker** (funções puras sobre `ProviderState`): abre com **3 falhas seguidas** ou **≥ 50% de falha nas últimas 10 chamadas**; fica aberto **60 s**; depois, meio-aberto com **1 sonda** (as análises concorrentes pulam o provedor enquanto a sonda está em voo). Sonda bem-sucedida fecha e zera; sonda com falha reabre por 60 s.
- **`QuotaLedger.reserve`** antes de **cada** chamada: `provedor_esgotado` pula o provedor (roteia **antes** de tomar 429); `global_esgotado` é o **breaker diário global** de LLM (T7, mitigação 10) e encerra a cadeia com `cota_esgotada`. A folga de 15% abaixo do limite publicado é responsabilidade da implementação em Redis (HITL-007).
- **Falha fechado (T39):** `reserve` que lança, rejeita, devolve valor fora do enum ou passa de `LEDGER_TIMEOUT_MS` encerra a cadeia com `cota_esgotada`. Nenhuma chamada sai sem reserva confirmada.
- `recordUsage` é disparado sem bloquear a resposta, e sua falha é absorvida: a contabilidade não pode derrubar uma análise que já deu certo.

### D7. A cadeia vem de configuração validada (`parseLlmProviderChain`)
- `LLM_PROVIDER_CHAIN` (lista separada por vírgula, itens aparados) passa por Zod no *boot*: sem item vazio, sem repetição e só ids permitidos nesta fase. Isso já limita a cadeia a 2 provedores em produção e 3 em dev, então não há `min`/`max` separados (seriam código equivalente, sem teste que os distinga).
- **`google_ai_studio` é recusado** nas Fases 0 e 1 (HITL-012). **`ollama` só com `allowDevOnlyProviders`** (dev e evals; ADR-001 §5.5).
- Cadeia vazia, inválida, ou sem adapter correspondente, ou adapter com `model` fora do padrão do `JobFactsCacheEntrySchema`: **o construtor lança** no *boot* (falha cedo e fechado). Em tempo de requisição, o router nunca lança.

## 3. Consequências
- **Positivas:** custo e latência máximos por análise conhecidos (2 chamadas, 12 s); um ponto único em que todo resultado ok passou pela guarda; cota e *breaker* evitam martelar provedor sem cota; ledger fora do ar não vira gasto livre.
- **Negativas:** com o ledger fora do ar, toda análise vai para o fallback determinístico (escolha deliberada do T39). O estado do *breaker* é por processo até o S-5.
- **Residual (T28):** um atacante que provoque 429 no Groq empurra a análise para o Cloudflare. Mitigado porque os dois passam pelo mesmo gate do golden dataset (S-1) e pela mesma guarda, e o fallback final é determinístico.
- **Calibração:** todas as constantes são hipóteses do ADR-001 §5.5 e mudam só por ADR depois do S-1.

## 4. Verificação
Prova em `apps/api/test/application/llm-provider-router*.test.ts`, com *fakes* em `test/application/fakes/` (relógio de eventos discretos, extrator roteirizado, ledger em memória e `Random` fixo):
- prazo global, prazo insuficiente, orçamento de 2 chamadas, 429 com troca e `Retry-After` (teto, piso e valor inválido), retry com *jitter*, *breaker* abrindo (3 seguidas e 50% em 10), meio-aberto com sonda única e fechando, cota do provedor, cota global, ledger lento ou com erro, cadeia vazia ou inválida, Gemini recusado e Ollama só em dev;
- **propriedades no fast-check:** para qualquer cadeia, sequência de respostas (inclusive exceções e chamadas que nunca respondem), latências, ledger e prazo inicial, o router **nunca faz mais de 2 chamadas**, **nunca resolve depois do prazo**, **nunca lança**, o ok passa no `JobFactsSchema` e a falha não carrega texto do provedor;
- cobertura de 100% e mutação manual.

**Resultado (2026-10-19):** 82 testes novos (API com 404); propriedade com 1.000 cenários por execução e 60.000 numa caça avulsa, sem contraexemplo; cobertura de 100% (206/206 ramos); mutação 52/52 não equivalentes mortos. Dois mutantes equivalentes tiveram o código removido: a flag `retried` (com orçamento de 2, o retry só cabe depois da 1ª chamada) e o `min`/`max` da cadeia. Um teste fixa as constantes de D4 a D6 contra este ADR.

## 5. Emenda ao D4: teto da tentativa por provedor (desenho, 2026-10-25, *HITL-QUEUE §HITL-028* 2A)

> [!info] Só desenho
> Entra no código junto com o adapter do Groq (F1-LLM-01 parte 2), no mesmo PR. Sem o Groq na cadeia, a tabela não muda nenhum comportamento.

> [!note] Emendas do [ADR-022-groq-adapter](ADR-022-groq-adapter.md) (2026-10-26, desenho)
> - Este §5 entra sem mudança no commit 2 da partição do ADR-022 (D9).
> - **Implementado em 2026-10-27** (commit `5cc746d`, local): a tabela, a regra e o `MIN_ATTEMPT_MS` global entraram sem mudança; as verificações do §5.5 estão nos testes do router.
> - **D1 e D6:** a porta `QuotaLedger` ganha `recordRateLimit(provider, retryAfterMs)`, que o router chama em melhor esforço em todo `limite_de_taxa`. O ledger guarda o bloqueio do provedor por até 1 h, entre instâncias. O resfriamento por processo do D5 não muda (ADR-022 D7.3).
> - **D1 e D6 implementados em 2026-10-27** (commit `27aa181`, local): o router chama `recordRateLimit` em todo `limite_de_taxa`, em melhor esforço, sem esperar e engolindo a falha.

### 5.1 Contexto
Com o Groq como primário e a Workers AI como fallback (*spike-metrics* §2.5), a regra atual `min(10 s, restante − 300 ms)` dá ao Groq quase todo o prazo da análise. Se o Groq travar, sobram 1,7 s, abaixo do `MIN_ATTEMPT_MS`, e a Workers AI nem é chamada. O máximo medido do Groq é 1,39 s em 118 chamadas.

### 5.2 Decisões
- **`ATTEMPT_TIMEOUT_MAX_MS` vira uma tabela por provedor** no `ROUTER_POLICY`, com tipo `Record<LlmProviderId, number>`. O tipo total obriga quem acrescentar um provedor ao enum a decidir o teto dele.

  | Provedor | Teto da tentativa | Por quê |
  |---|---|---|
  | `groq` | **3.000 ms** | mais que o dobro do máximo medido (1,39 s); um Groq travado deixa 8,7 s à Workers AI |
  | `cloudflare_workers_ai` | 10.000 ms | p95 medido de 9,9 s; é o último LLM da cadeia |
  | `ollama` | 10.000 ms | só em dev e evals |
  | `google_ai_studio` | 10.000 ms | fora da cadeia nas Fases 0 e 1 (HITL-012); o valor só fecha o tipo |

- **Regra:** cada chamada recebe `min(teto do provedor, restante − 300 ms)`. O retry por `erro_transitorio` no mesmo provedor usa o mesmo teto.
- **O teto mora no router, não no adapter.** A corrida com `clock.sleep` e o `AbortSignal` continuam no router (D4). O adapter só recebe o `timeoutMs` já calculado, como hoje.
- **`MIN_ATTEMPT_MS` continua global (2.500 ms).** Com a Workers AI em p50 de 6,4 s, chamá-la com só 2,5 s restantes tem pouca chance de dar certo. Calibrar o mínimo por provedor fica para a rodada de aceite do S-1, com os dados.
- **`ANALYSIS_DEADLINE_MS` (12 s), `DEADLINE_RESERVE_MS` e o orçamento de 2 chamadas (D5) não mudam.**

### 5.3 Conta do prazo (latências medidas da Workers AI)
| Cenário do Groq | Prazo da Workers AI | Workers AI acima do prazo |
|---|---|---|
| falha rápida (400, 429 ou guard, ~1 s) | 10 s | 5 de 92 (5,4%) |
| travado, teto de 10 s (hoje) | 1,7 s, abaixo do `MIN_ATTEMPT_MS`: **sem fallback** | 92 de 92 |
| travado, teto de 3 s | 8,7 s | 11 de 92 (12%) |

### 5.4 Auditoria do `[APPSEC]` (sem veto)
- Nenhuma superfície nova. O teto menor só encurta a espera, e o router continua resolvendo até o prazo global.
- **T28 (residual) não muda:** quem provoca 429 ou lentidão no Groq empurra a análise para a Workers AI, que passa pela mesma guarda e pelo mesmo gate. Com o teto de 3 s, o atacante que trava o Groq não consegue mais anular o fallback.
- **Custo:** um Groq abortado em 3 s ainda pode ser cobrado. A reserva no ledger já acontece antes da chamada (D6), então o teto diário continua valendo.

### 5.5 Verificação (para a implementação)
- O teste que fixa as constantes do D4 ao D6 passa a fixar a tabela inteira contra este ADR.
- **Novo:** um Groq que nunca responde é abortado em 3 s, e a Workers AI recebe `min(10 s, 12 − 3 − 0,3 s)` = 8,7 s. O retry do Groq também recebe 3 s.
- As propriedades do §4 (no máximo 2 chamadas, nunca depois do prazo, nunca lança) rodam com tetos por provedor sorteados.
