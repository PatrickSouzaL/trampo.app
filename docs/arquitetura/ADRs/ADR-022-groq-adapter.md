---
tipo: adr
id: ADR-022
titulo: "Adapter do Groq (F1-LLM-01 parte 2): URL fixa conferida no boot, corpo de lista fechada sem tools no modo nao_estrito com o prompt compartilhado, tetos e tabela de status sem ler corpo de erro, reserva de tokens e bloqueio por Retry-After no QuotaLedger, teto de 3 s no router e contadores do g3/g4 na telemetria"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]) dentro do HITL-028 (1A, 2A) e do HITL-029 (3A). Não muda contrato público, nem EXTRACTION_PROMPT_VERSION, nem LLM_OUTPUT_GUARD_VERSION. O adapter não é ligado no main.ts antes do aceite do p3/g4 (spike-metrics §2.8) e do T28."
data: 2026-10-26
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "F1-LLM-01 parte 2 (apps/api/src/infrastructure/llm/groq-extractor.ts, infrastructure/llm/llm-http.ts, application/llm/llm-provider-router.ts, application/limits/limit-policy.ts, application/ports/quota-ledger.ts, infrastructure/limits/redis-quota-ledger.ts, application/ports/telemetry.ts e application/telemetry/extraction-telemetry.ts)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-008-llm-output-guard](ADR-008-llm-output-guard.md)", "[ADR-009-llm-provider-router](ADR-009-llm-provider-router.md)", "[ADR-010-log-allowlist-and-telemetry](ADR-010-log-allowlist-and-telemetry.md)", "[ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md)", "[ADR-015-job-facts-cache](ADR-015-job-facts-cache.md)", "[ADR-020-cloudflare-workers-ai-adapter](ADR-020-cloudflare-workers-ai-adapter.md)", "*spike-metrics*", "[threat-model](../threat-model.md)", "*llm*", "*BACKLOG §F1-LLM-01*"]
---

# ADR-022: adapter do Groq

## 1. Contexto

O HITL-028 escolheu a cadeia **Groq `openai/gpt-oss-20b` sem `strict` + guard → Workers AI → determinístico**, com teto de 3 s no Groq (1A e 2A). O HITL-029 3A liberou o adapter do Groq em paralelo ao aceite do `p3`/`g4`, sem ligar no `main.ts`.

O molde é o adapter da Workers AI ([ADR-020-cloudflare-workers-ai-adapter](ADR-020-cloudflare-workers-ai-adapter.md) D2 a D9 e §6.2). A chamada que já funcionou é a do spike (`evals/spikes/s1-extraction/providers.ts`):
- `json_schema` sem `strict`;
- `reasoning_effort: "low"`;
- sem `tools`.

Além do que o molde já resolve, o S-1 mostrou três lacunas no `QuotaLedger` ([ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md) D6) e no router:
1. **Os tokens só são contados no 200.** O router só chama `recordUsage` com `ok: true`. Uma recusa 400, um 5xx ou uma chamada abortada pelo teto de 3 s também gastam a cota do Groq (§2.3: "as recusas também gastam"), e o ledger não vê nada disso. Além disso, o `reserve` só lê os tokens já gastos. Então N análises simultâneas passam todas pelo mesmo saldo antes de qualquer `recordUsage`.
2. **O `Retry-After` do TPD é cortado.** O Groq mandou `retry-after` de 417 s a 887 s no TPD (§2.3). O router limita o resfriamento a 120 s (ADR-009 D5), então, com o TPD esgotado, cada análise toma um 429 a cada 2 minutos.
3. **O resfriamento é por processo** (`InMemoryProviderStateStore`, ADR-009 D1). Ele se perde num restart e não vale entre instâncias (S-5).

Também ficaram desenhadas, à espera deste adapter, duas peças:
- o teto da tentativa por provedor ([ADR-009-llm-provider-router](ADR-009-llm-provider-router.md) §5);
- os contadores do `g3` e do `g4` na telemetria ([ADR-008-llm-output-guard](ADR-008-llm-output-guard.md) G3-4 e G4-2).

### 1.1 Fatos medidos no S-1 (chamadas reais, 2026-10-24 a 2026-10-26)
| Fato | Fonte |
|---|---|
| `POST https://api.groq.com/openai/v1/chat/completions`, `Authorization: Bearer`, formato OpenAI | `providers.ts` do spike; *llm* |
| Sucesso: `choices[0].message.content` string, com `finish_reason: "stop"` em todas as 83 chamadas; `usage.prompt_tokens`, `completion_tokens` (já com o raciocínio) e `completion_tokens_details.reasoning_tokens` | *spike-metrics* §2.3 |
| `strict: true` recusa 28% com `400 json_validate_failed`, e o corpo do erro traz a geração recusada em `error.failed_generation`; `strict: false` com `p2`/`g3` teve 83/83 respostas 200 | §2.2, §2.7 |
| Latência p50 0,93 s, p95 1,29 s, máx. 1,45 s (`p2`) | §2.7 |
| Entrada p95 de ~2,5k tokens com o `p2`; saída máx. de 704 tokens com o raciocínio; ~2,4k tokens por chamada | §2.3, §2.7 |
| Cabeçalhos `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` sempre; `retry-after` só no 429 | §2.3 |
| 429 `rate_limit_exceeded` com `retry-after` de 46 s (TPM) e de 417 s a 887 s (TPD) | §2.3 |
| Limites da organização: 30 RPM, 1.000 RPD, 8.000 TPM e 200.000 TPD; ZDR ligado | *llm*; STATE (S-1) |

**Não confirmado:**
- se o TPD do Groq zera num horário fixo ou numa janela móvel. O ledger conta por dia UTC (ADR-014 D6), e o D7 abaixo cobre a diferença;
- se o `strict: false` ainda pode dar `400 json_validate_failed`. Não aconteceu em 83 chamadas com o `p2`, e o D6 trata o 400 do mesmo jeito em qualquer caso;
- a forma exata da chave de API. O spike só usou uma chave, e o D8 confere a forma com folga.

## 2. Decisões

### D1. Prompt compartilhado e modelo fixo no código
- O adapter usa `buildExtractionMessages` e `EXTRACTION_RESPONSE_SCHEMA` de `application/llm/extraction-prompt.ts` ([ADR-020-cloudflare-workers-ai-adapter](ADR-020-cloudflare-workers-ai-adapter.md) D1), sem cópia. **Nenhum commit deste ADR muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`.** Um teste confere as duas constantes contra os valores do aceite (`p3` e `g4`).
- **Modelo: constante `GROQ_MODEL = "openai/gpt-oss-20b"`, sem variável de ambiente.** O T28 (mitigação 1) exige que todo modelo passe pelo gate do golden dataset. Então trocar de modelo é mudança de código, com aceite. Um teste confere a constante contra o `JobFactsCacheEntrySchema.shape.model` ([ADR-015-job-facts-cache](ADR-015-job-facts-cache.md) §5). O `reasoning_effort` (D4) só vale para essa família.
- O nonce vem de `randomBytes(16)`, um por chamada, como no ADR-020 D1.

### D2. Adapter em `infrastructure/llm`, implementando a porta sem mudá-la
```ts
createGroqExtractor(config: {
  apiKey: string;
  fetch?: typeof fetch; randomNonce?: () => string; baseUrl?: URL;   // só para os testes
}): JobFactsExtractor   // provider = "groq", model = GROQ_MODEL
```
- A porta `JobFactsExtractor` (ADR-009 D1) não muda. O adapter devolve a string bruta, e o router roda a guarda (ADR-009 D2).
- Sem logger. Toda falha vira um valor do enum da porta, e `call` **nunca rejeita**.
- **Helpers compartilhados:** `parseRetryAfterMs`, `readCapped`, `decodeUtf8` e a leitura do envelope com o *reviver* saem do adapter da Workers AI para `infrastructure/llm/llm-http.ts`. É uma refatoração sem mudança de comportamento, num commit próprio (§4). O import do spike S-1 muda no mesmo commit.

### D3. URL fixa e conferida no boot
- `GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions"`, montada **uma vez**, no construtor.
- O construtor confere:
  - `url.href` igual, byte a byte, a `origin + "/openai/v1/chat/completions"`;
  - `protocol === "https:"`;
  - `host === "api.groq.com"` em produção;
  - `search` e `hash` vazios.

  Qualquer desvio lança no boot.
- O `baseUrl` dos testes troca só a origem (o caminho é fixo), e o construtor de produção não o recebe. Nada da requisição entra na URL.
- `redirect: "manual"`: o 3xx chega como status e vira `erro_permanente`, sem 2ª requisição e sem levar o token para o `Location` (emenda do ADR-020 §6.2).

### D4. Corpo de lista fechada, sem `tools` (SR-01)
```json
{ "model": "openai/gpt-oss-20b",
  "messages": [ {"role":"system","content":"…"}, {"role":"user","content":"…"} ],
  "response_format": { "type": "json_schema",
                       "json_schema": { "name": "job_facts", "strict": false, "schema": <EXTRACTION_RESPONSE_SCHEMA> } },
  "reasoning_effort": "low", "include_reasoning": false,
  "temperature": 0, "max_completion_tokens": 1024 }
```
- **Exatamente estas 7 chaves** no nível de cima, as 2 de `response_format` e as 3 de `json_schema`. Em cada mensagem, só `role` e `content`. É o corpo medido no aceite (`nao_estrito`), menos o teto do spike (2.048).
- **Proibidas**, cada uma com teste: `tools`, `tool_choice`, `functions`, `function_call`, `parallel_tool_calls`, `stream`, `n`, `logprobs`, `top_logprobs`, `user`, `service_tier`, `stop`, `seed`, `metadata`, `store` e qualquer chave fora da lista. O `user` sairia como identificador para o provedor (LGPD), e o `stream` mudaria o envelope.
- `max_completion_tokens: 1024` (`GROQ_MAX_COMPLETION_TOKENS`). A saída máxima medida foi de 704 tokens com o raciocínio (*spike-metrics* §2.5, item 5). Saída truncada vira `finish_reason: "length"`, e o D6 a trata como `erro_permanente`.
- **Teto do corpo enviado:** 48 KiB (`GROQ_MAX_REQUEST_BYTES`), igual ao da Workers AI. Corpo acima do teto não sai e dá `erro_permanente`.
- **Cabeçalhos:** só `authorization`, `content-type: application/json` e `accept: application/json`.

### D5. Chamada e prazo
- `fetch(url, { method: "POST", redirect: "manual", signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(attempt.timeoutMs)]) })`.
- O prazo vem do router, que já aplica o teto de 3 s do Groq (D9). O adapter não tem prazo próprio.
- Sem streaming.

### D6. Tabela de status e mapeamento para a porta

| Situação | Resultado |
|---|---|
| 200; corpo dentro do teto; UTF-8 estrito; *reviver*; envelope válido; `choices[0].message.content` string de até 16 KiB; `finish_reason === "stop"` | `{ ok: true, raw: content, usage }` |
| 200 com `finish_reason` diferente de `"stop"` (`length`, `tool_calls`, `content_filter`…), `content` nulo, `message.tool_calls` presente, `choices` vazio, envelope fora da forma, corpo vazio ou UTF-8 inválido | `erro_permanente` |
| 201 a 299 que não seja 200 | `erro_permanente` (como no ADR-020 §6.2) |
| **429** | `limite_de_taxa`, com `retryAfterMs` do `Retry-After` (`parseRetryAfterMs`: segundos ou IMF-fixdate, senão `null`) |
| **400**, inclusive o `json_validate_failed` | `erro_permanente`, **sem ler o corpo** |
| 408, 500 a 599, falha de rede, aborto, erro durante a leitura do corpo | `erro_transitorio` |
| 3xx e qualquer outro status (401, 403, 404, 413, 422…) | `erro_permanente` |

- **O `400 json_validate_failed` não é distinguido de propósito.** Para distinguir, seria preciso ler o corpo, e o corpo traz `failed_generation`, que é a saída do modelo sobre o texto da vaga. Ela pode ecoar o texto ou a injection plantada. O spike leu esse campo só em memória para o diagnóstico (§2.2.1). Em produção, ele **nunca é lido**. A recusa cai como falha do provedor: conta no *breaker* e libera a Workers AI. O gasto de tokens dela fica coberto pela reserva do D7.
- **O corpo de qualquer não-200 é cancelado sem leitura** (`body.cancel()`). Nada dele vai ao resultado, a uma exceção ou ao log (SR-12).
- **Teto da resposta:** 32 KiB (`GROQ_MAX_RESPONSE_BYTES`), contados em bytes durante a leitura. Acima do teto, `erro_permanente`, e o resto do *stream* é cancelado. A maior resposta útil medida tem 1.227 bytes de conteúdo.
- **Envelope por Zod, sem exigir chave extra:**
  - `choices`: array com pelo menos 1 item;
  - `choices[0].message.content`: string de até 16 KiB ou `null`;
  - `choices[0].finish_reason`: string;
  - `usage` opcional.

  Chaves como `id`, `x_groq`, `system_fingerprint` e `message.reasoning` são toleradas e **nunca copiadas**. Só o `content` sai do adapter.
- **`usage`:** `prompt_tokens` e `completion_tokens` inteiros de 0 a `LEDGER_POLICY.maxTokensPerCall`. Ausente ou fora da forma vira `{ inputTokens: 0, outputTokens: 0 }`. Com zero, o ledger mantém a reserva cheia (D7), que é o lado seguro. O `reasoning_tokens` não sai: ele já está dentro do `completion_tokens`, e a porta não tem campo para ele.

### D7. `QuotaLedger`: reserva de tokens e bloqueio por `Retry-After` (emendas ao [ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md) D6 e ao [ADR-009-llm-provider-router](ADR-009-llm-provider-router.md) D1 e D6)

**D7.1 Limites do Groq.** A tabela do ADR-014 D6 não muda: 30 RPM, 1.000 RPD, 8.000 TPM e 200.000 TPD, com o efetivo em `floor(× 0,85)`. Isso dá 25 RPM, 850 RPD, 6.800 TPM e 170.000 TPD efetivos.

**D7.2 Reserva pessimista de tokens.** `ProviderLimits` ganha `reservedTokensPerCall: number | null`, que vale **3.000 no Groq** (entrada p95 de ~2,5k mais a saída p50 de ~0,4k, arredondado para cima; calibrado no aceite) e `null` nos demais.
- No `reserve`, a mesma transação faz `INCRBY` da reserva no TPM e no TPD, cada um com `EXPIRE`.
- A negação passa a ser `tpm > efetivo` ou `tpd > efetivo`, já contando esta reserva, como as chamadas (`callsExceeded`). Antes era `gasto ≥ efetivo`, sem a reserva.
- Na negação, os `DECR`/`DECRBY` de compensação incluem a reserva, em melhor esforço.
- **`recordUsage` passa a reconciliar.** Ele faz `INCRBY (input + output − reserva)`, um valor que pode ser negativo, no TPM e no TPD.
  - Uso zero ou fora da forma não reconcilia, e a reserva cheia fica.
  - A chamada que não volta 200 (400, 5xx, aborto pelo teto de 3 s) não chama `recordUsage`, e a reserva cheia fica. Isso cobre o gasto que o ledger não via.
- A porta não muda de assinatura. Muda só a semântica do `recordUsage`, que passa a ser "ajusta a reserva".
- **Efeito no TPM efetivo:** com a reserva de 3.000, o reserve deixa passar 2 chamadas por minuto antes da reconciliação. Depois dela, com ~2,4k reais, passam no máximo 2 por minuto de forma estável (2 × 2,4k + 3k = 7,8k > 6,8k). Para uso pessoal, com 50 análises por dia, isso basta. Com o TPD efetivo de 170.000, ficam ~70 análises por dia no Groq. A partir daí, a Workers AI responde.

**D7.3 Bloqueio por `Retry-After`.** A porta `QuotaLedger` ganha:
```ts
recordRateLimit(provider: LlmProviderId, retryAfterMs: number | null): Promise<void>;   // melhor esforço, nunca rejeita
```
- O router chama em todo `limite_de_taxa`, sem bloquear, como o `recordUsage` (ADR-009 D6). O resfriamento por processo do `circuit-breaker` continua igual, em [1 s, 120 s].
- **Redis:** `SET llm:block:{provider} 1 PX <ms>`, com `ms = clamp(retryAfterMs ?? 60.000, 1.000, 3.600.000)`. O teto de 1 h é maior que os 887 s medidos no TPD. O `reserve` lê a chave na mesma transação (`EXISTS`): se ela existir, a resposta é `provedor_esgotado`, com a compensação dos contadores.
- O id do provedor é um enum de cardinalidade fechada, sem dado de usuário, então a chave não leva HMAC (o SR-17 é para chave derivada de usuário ou IP).
- **Por que no ledger e não só no router:** o ledger é compartilhado entre instâncias e sobrevive a um restart. Subir o teto do resfriamento do router para 1 h resolveria só o processo atual.
- **`Retry-After` hostil:** ele só vem da URL fixa (D3), por TLS. O pior caso é o Groq ficar fora por 1 h, com a análise na Workers AI, o que é degradação e não falha aberta.

**D7.4 Falha fechado (T39) mantida.** O `EXISTS` e os `INCRBY` entram na transação que já existe. Resposta fora da forma, erro ou lentidão continuam dando `global_esgotado`.

### D8. Variáveis de ambiente (só nomes; valores no `.env`, nunca no cofre)
| Nome | Forma no boot (Zod) |
|---|---|
| `GROQ_API_KEY` | `^gsk_[A-Za-z0-9_-]{20,200}$`. A mensagem de erro do boot cita só o nome da variável. A forma é conferida com a chave real só na ligação no `main.ts` (sessão posterior ao aceite), por comprimento e prefixo, sem exibir a chave |

- Não há `GROQ_MODEL` (D1) nem `GROQ_BASE_URL` (D3).
- **Token só no *closure*.** A chave fica só no objeto de cabeçalhos dentro do *closure* do adapter. Ela não é campo do objeto devolvido e não aparece em `toString`, `JSON.stringify`, `util.inspect` ou mensagem de erro. Um teste com canário confere isso em todo resultado e em toda exceção interna.
- `GROQ_API_KEY` já está no `.env.example` (sem valor), com o aviso do ZDR. O comentário ganha a forma do D8.

### D9. Teto da tentativa por provedor no router ([ADR-009-llm-provider-router](ADR-009-llm-provider-router.md) §5, sem mudança)
- Entra no código como desenhado no ADR-009 §5:
  - `ROUTER_POLICY.attemptTimeoutMaxMs` vira `Record<LlmProviderId, number>`, com `groq` em 3.000 ms e os demais em 10.000 ms;
  - cada chamada recebe `min(teto do provedor, restante − 300 ms)`;
  - o retry usa o mesmo teto;
  - `MIN_ATTEMPT_MS` fica global.
- Com o Groq travado, a Workers AI recebe 8,7 s.

### D10. Contadores do `g3` e do `g4` na telemetria (emenda ao [ADR-010-log-allowlist-and-telemetry](ADR-010-log-allowlist-and-telemetry.md) D5 e D6)
- O `LlmExtractionEvent` ganha:
  ```ts
  guardNormalizations: {
    offEnumItemsRemoved: number;     // g3
    absentValuesNormalized: number;  // g3
    stackOverlapsResolved: number;   // g4
  }
  ```
  São inteiros seguros ≥ 0, saturados em 8.192 na cópia (o teto de 8 KiB da guarda já limita a contagem real abaixo disso), e todos ficam 0 na falha.
- `llmExtractionEvent` copia só esses três números do `sanitization` do `ExtractionOutcome`. O ADR-010 D5 dizia que o evento "não tem caminho para o `sanitization`". O caminho aberto aqui é estreito: três inteiros. Nenhum texto, tag ou campo dos fatos passa, e um teste por propriedade confere isso com canários nos fatos.
- **Métrica nova** no catálogo do D6:

  | Métrica | Tipo | Rótulos | Valor |
  |---|---|---|---|
  | `llm_guard_normalization_total` | contador | `provider`, `kind` (`fora_do_enum`, `ausencia_normalizada`, `sobreposicao_de_stack`) | o contador do evento, só quando > 0 |

- Os outros contadores do `sanitization` (`urlsRemoved`, `hiddenOrMarkupRemoved` e os demais) ficam de fora. O sinal de injection já chega por `analysis_injection_level_total`, e acrescentá-los é decisão de outro ADR.
- O `TelemetryEventSchema` continua estrito, e o evento sem o campo novo passa a ser inválido. Os produtores são só o `AnalyzeJob`, pela função pura, e mudam no mesmo commit.

## 3. Auditoria do `[APPSEC]` (sem veto)

| Ameaça ou SR | Como o desenho responde | Critério de aceite |
|---|---|---|
| **SR-01** (sem `tools`) | Corpo de lista fechada (D4) | 1. Teste do corpo exato (7 + 2 + 3 chaves, só `role` e `content`) e da lista de proibidas; propriedade (fast-check) para qualquer texto |
| **LGPD / ADR-001 D2** | Só o texto selecionado vai no envelope; sem `user`; ZDR ligado | 2. Payload com campos extras forçados por cast não vaza nada além de `text`; nenhuma chave `user` ou `metadata` |
| **SSRF / exfiltração do token** | URL fixa conferida no boot; `redirect: "manual"` (D3) | 3. Testes negativos de `baseUrl` com caminho, *query*, *fragment*, credencial e `http:`; 301, 302, 303, 307 e 308 dão `erro_permanente`, com um 2º servidor recebendo zero requisições |
| **SR-12** (segredo e texto em log) | Sem logger; corpo de não-200 cancelado sem leitura; `failed_generation` nunca lido; chave só no *closure* (D6, D8) | 4. Canários de chave, texto da vaga e `failed_generation` (num 400 simulado) ausentes de todo resultado, de `JSON.stringify`/`util.inspect` do adapter e de toda exceção interna |
| **Parse hostil** | Tetos de 48 KiB e 32 KiB, UTF-8 estrito, *reviver*, `content` até 16 KiB (D4, D6) | 5. Testes: 32 KiB + 1; UTF-8 inválido; `__proto__` e `constructor` no envelope; `content` com 16 KiB + 1; `message.reasoning` e `x_groq` ignorados |
| **T1/T2** (injection) | Prompt compartilhado com nonce por chamada; LLM sem tools; guarda no router | 6. Nonce novo a cada chamada; texto com `vaga id=` ou com o nonce não sai do adapter |
| **T7** (cota e custo) | Teto de 1.024 tokens de saída; reserva pessimista de 3.000; bloqueio por `Retry-After` compartilhado (D4, D7) | 7. Ledger contra o Upstash simulado: reserva e reconciliação, inclusive negativa; reserva cheia sem `recordUsage`; N reservas simultâneas negadas acima do efetivo; `llm:block` com piso, teto e `null` → 60 s; `EXISTS` positivo → `provedor_esgotado` com compensação; resposta fora da forma → `global_esgotado` |
| **T28** (*downgrade*) | Mesma guarda; fora da produção até o aceite; modelo fixo no código (D1) | 8. Nenhuma ligação no `main.ts`; o teste do `composeApp` continua sem o Groq; versões `p3` e `g4` conferidas |
| **T30** (indisponibilidade) | Tabela do D6 inteira; teto de 3 s no router (D9) | 9. Tabela do D6 em teste; o Groq que nunca responde é abortado em 3 s, e a Workers AI recebe 8,7 s; as propriedades do ADR-009 §4 com tetos sorteados |
| **SR-12 na telemetria** | Só três inteiros saem do `sanitization` (D10) | 10. Propriedade: para qualquer `ExtractionOutcome`, o evento passa no schema estrito e não contém texto dos fatos; catálogo de métricas fixado contra este ADR |

**Riscos residuais aceitos:**
- **Recusa 400 sem motivo:** o `json_validate_failed` vira `erro_permanente` como os outros 400. O motivo só aparece no spike, nunca em produção.
- **Reserva estimada:** 3.000 tokens é hipótese. O aceite do `p3` mede o p95 real, e o valor muda por emenda.
- **TPD por janela móvel** (não confirmado): o ledger conta por dia UTC. O bloqueio do D7.3 cobre o caso em que o Groq ainda está esgotado depois da meia-noite UTC.
- **Forma da chave** (D8): conferida com a chave real só na ligação.

## 4. Partição em commits atômicos (Trilha B2)
Cada commit traz testes, cobertura de 100%, mutação (um mutante por vez, script fora do repositório) e o `[SCRIBE]` atualiza o STATE e este ADR (§5) antes do próximo. Nenhum muda `EXTRACTION_PROMPT_VERSION` ou `LLM_OUTPUT_GUARD_VERSION`, nenhum chama o Groq real, e nenhum liga no `main.ts`.

| # | Commit | Arquivos principais | Critérios do §3 |
|---|---|---|---|
| 1 | `refactor(api)`: helpers HTTP de LLM compartilhados (D2) | `infrastructure/llm/llm-http.ts`; adapter da Workers AI e import do spike | os 150 testes da Workers AI passam sem mudança; typecheck do `@trampo/evals` |
| 2 | `feat(api)`: teto da tentativa por provedor no router (D9; ADR-009 §5) | `llm-provider-router.ts` e testes do router | 9 (parte do router) |
| 3 | `feat(api)`: reserva pessimista de tokens no ledger (D7.2; emenda ao ADR-014 D6) | `limit-policy.ts`, `redis-quota-ledger.ts` | 7 (reserva e reconciliação) |
| 4 | `feat(api)`: bloqueio por `Retry-After` no ledger (D7.3; emenda ao ADR-009 D1 e D6) | `ports/quota-ledger.ts`, `redis-quota-ledger.ts`, router, ledger falso | 7 (`llm:block`) |
| 5 | `feat(api)`: adapter do Groq (D1 a D6, D8), contra um Groq simulado em *socket* real (`test/infrastructure/fakes/fake-groq.ts`) | `infrastructure/llm/groq-extractor.ts`, `.env.example` | 1 a 6, 8, 9 (tabela) |
| 6 | `feat(api)`: contadores do `g3`/`g4` na telemetria (D10; emenda ao ADR-010 D5 e D6) | `ports/telemetry.ts`, `extraction-telemetry.ts`, `in-memory-telemetry.ts` | 10 |

- Os commits 2, 3, 4 e 6 não dependem do 5 e podem ir em qualquer ordem entre si, depois do 1. A ordem da tabela vai do menor risco ao maior.
- **Fora da B2:** ligar a cadeia no `main.ts` (com o *smoke* de 1 chamada pelo adapter real e a forma da chave conferida) espera o aceite do `p3`/`g4` (Trilha A).

## 5. Consequências
- **Positivas:**
  - o primário da cadeia ganha adapter provado sem rede e sem gastar cota;
  - o ledger passa a contar o que o Groq realmente cobra e respeita o `Retry-After` do TPD entre instâncias;
  - o fallback para a Workers AI deixa de ser anulado por um Groq travado;
  - a telemetria passa a medir as normalizações do `g3` e do `g4` em produção.
- **Negativas:**
  - a porta `QuotaLedger` ganha um método, e todo *fake* e adapter precisa implementá-lo;
  - a reserva pessimista limita o Groq a ~2 chamadas por minuto;
  - o `LlmExtractionEvent` muda de forma.
- **Próximo:** a Trilha B2 foi concluída em 2026-10-27 (os 6 commits abaixo). ~~Depois do aceite do `p3`/`g4`, a ligação no `main.ts`~~ **feita na Trilha L1 (2026-10-30, §6)**, com o *smoke* de 1 chamada pelo adapter real, a forma da `GROQ_API_KEY` conferida com a chave real (D8) e a reserva de 3.000 tokens recalibrada com a medida (D7.2).
- **Riscos residuais acrescentados na implementação:**
  - a reconciliação que cruza a virada do minuto ou do dia UTC cai na janela nova e pode deixá-la negativa. O desvio é de no máximo (reserva − uso) por chamada que cruza a virada, e a soma das duas janelas fica exata (commit 3);
  - um 429 posterior com `Retry-After` menor sobrescreve o `llm:block`: é a informação mais recente do provedor (commit 4);
  - `message.tool_calls: null` é tolerado como ausência (formato OpenAI); qualquer outro valor, inclusive `[]`, é `erro_permanente` (commit 5).
- **Progresso da B2:**
  - commit 1 (`4220bee`, 2026-10-27): `infrastructure/llm/llm-http.ts` com `parseRetryAfterMs`, `readCapped`, `decodeUtf8`, `parseEnvelope` (reviver), `failureForStatus` e `usageFrom`; adapter da Workers AI e spike S-1 usando o módulo; 150/150 da Workers AI sem mudança, 27 testes novos, 100%, mutação 11/11 (o mutante `status <= 600` expôs a falta de teste do 600, agora coberto), depcruise verde
  - commit 2 (`5cc746d`, 2026-10-27): `ROUTER_POLICY.attemptTimeoutMaxMs` por provedor (Groq 3 s, demais 10 s), congelado e injetável só nos testes; Groq travado abortado em 3 s com a Workers AI em 8,7 s; retry com o mesmo teto; propriedade do §4 com tetos sorteados (nenhuma tentativa acima do teto); 2.708 testes, 100%, mutação 9/9, depcruise verde
  - commit 3 (`1b07950`, 2026-10-27): `reservedTokensPerCall` (Groq 3.000) somado ao TPM/TPD no `reserve` com `INCRBY`+`EXPIRE`, negação acima do efetivo já com a reserva, compensação com `DECRBY`, `recordUsage` reconciliando (uso − reserva, inclusive negativo); 4 reservas simultâneas → 2 negadas; Groq sem 200 fica com a reserva cheia; provedor sem TPM/TPD deixou de ler tokens (6 comandos) e a política impõe reserva a quem tem TPM/TPD; **residual aceito:** reconciliação que cruza a virada do minuto/dia UTC desloca até (reserva − uso) para a janela nova; 2.722 testes, 100%, mutação 17/17
  - commit 4 (`27aa181`, 2026-10-27): `recordRateLimit` na porta, no ledger em Redis (`SET llm:block:{provider} 1 PX` em [1 s, 1 h], 60 s com `null`/inválido) e no fake; `EXISTS` no `reserve` → `provedor_esgotado` com compensação, valendo entre instâncias e após restart; o router grava em todo 429 sem esperar; 2.748 testes, 100%, mutação 16/16
  - commit 5 (`f6e2cb8`, 2026-10-27): `infrastructure/llm/groq-extractor.ts` e `test/infrastructure/fakes/fake-groq.ts`; corpo de 7 chaves (`nao_estrito`, 1.024 tokens), URL fixa conferida no boot (origem de teste: `https:` ou `http:` só no loopback), `redirect: "manual"`, tetos 48/32/16 KiB, sucesso só com 200 + `finish_reason: "stop"`, corpo de não-200 cancelado sem leitura (`failed_generation` nunca lido), chave `gsk_…` só no closure; **decisão de implementação:** `message.tool_calls: null` é tolerado como ausência (formato OpenAI) e qualquer outro valor, inclusive `[]`, é `erro_permanente`; `.env.example` com a forma da chave; não ligado no `main.ts` (teste confere), `p3`/`g4` conferidas; 113 testes (critérios 1 a 6, 8 e 9), 2.861 na API, 100%, mutação 33/33
  - commit 6 (`797c04b`, 2026-10-27): `guardNormalizations` (3 inteiros do `sanitization`, saturados em 8.192, zerados na falha) no `LlmExtractionEvent`, schema estrito; métrica `llm_guard_normalization_total{provider, kind}` só quando > 0; propriedade com canários no `sanitization`; 2.879 testes, 100%, mutação 14/14, turbo 19/19 em série

## 6. Ligação no `main.ts` (Trilha L1, 2026-10-30, *HITL-QUEUE §HITL-032* 1A e 2A)
Commit `adb392d`, local, sem push. O `p3`/`g4` foi aceito pela A3 (efeito da stack na nota, *spike-metrics* §2.9) e pelo HITL-032 (o `0` de `yearsExperienceMin` como achado sem efeito na nota e o recall de `benefits` como ruído). Nenhuma versão de prompt ou de guard mudou.

### 6.1 Desenho (`[ARCHITECT]`)
- **`composition/production-app.ts`**, um módulo novo que importa o `compose-app.ts` (dependência de mão única, sem ciclo):
  - `createProductionExtractor(provider, env)`: o adapter de produção de um provedor. Só o Groq (`GROQ_API_KEY`) e a Workers AI (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_WORKERS_AI_MODEL`) têm adapter; qualquer outro id lança `ProviderChainConfigError` (segundo cadeado depois do `parseLlmProviderChain`);
  - `productionLlmComposition(env)`: a `LLM_PROVIDER_CHAIN` validada sem provedores de dev, um adapter por provedor **na ordem da cadeia** e o `EXTRACTION_PROMPT_VERSION` do código (`p3`);
  - `composeProductionApp(env)`: o `composeApp` com essa cadeia. É o que o `main.ts` chama.
- **O `composeApp` continua sem conhecer provedor.** A opção `llm` segue opcional para os testes de borda e de critérios, mas a produção não sobe sem a cadeia: a análise só cai no determinístico em tempo de requisição (cota, circuito aberto, falha do provedor), nunca por configuração esquecida.
- **Credencial de provedor fora da cadeia não é lida** (privilégio mínimo). Com `LLM_PROVIDER_CHAIN=groq`, o token da Cloudflare pode faltar.
- **`CLOUDFLARE_WORKERS_AI_MODEL` vazia ou ausente** dá o `WORKERS_AI_DEFAULT_MODEL`, o modelo medido no S-1 (*spike-metrics* §2.8). Outro valor passa pela forma do ADR-020 D3.
- **Ganchos de teste:** `ProductionLlmTestHooks.baseUrls` aponta cada adapter para o servidor simulado em *socket* real. O `main.ts` não os passa, e um teste confere o texto do `main.ts` (`composeProductionApp(process.env);`, sem `composeApp(` e sem `baseUrl`).

### 6.2 Reserva do D7.2 recalibrada
- `GROQ_TOKEN_MEASUREMENT` no `limit-policy.ts` guarda a medida do aceite do `p3` (83 chamadas `ok` em 6k): entrada p95 2.509, saída p50 331, total p95 2.939 e máximo 3.683.
- `groqReservedTokensPerCall()` soma entrada p95 e saída p50 (2.840) e arredonda para cima no passo de 500: **3.000**. O valor não muda, mas agora vem da medida, e não da hipótese.
- A reserva cobre o total p95 (2.939). A cauda (máx. 3.683) passa dela e é reconciliada pelo `recordUsage` com o uso real.
- Um teste fixa a medida, o resultado (3.000), a fórmula com medidas sintéticas (2.400 + 200 → 3.000; 2.400 + 100 → 2.500) e o efeito no TPM efetivo (2 reservas cabem em 6.800).

### 6.3 Forma da chave (D8) e *smoke* de 1 chamada
- **Forma conferida com a chave real, sem exibi-la:** prefixo `gsk_` e comprimento dentro de [24, 204], e o construtor do adapter (regex do D8) aceitou. As credenciais da Workers AI também passaram pela forma do ADR-020 D8 no mesmo boot.
- **Smoke** (script no scratchpad, fora do repositório): a cadeia montada por `productionLlmComposition(process.env)` com o `.env` real, e 1 chamada ao Groq pelo adapter de produção, com o teto de 3 s do router e uma vaga **sintética**, sem dado pessoal.
  - Resultado: `ok` em **884 ms**, com **1.627 tokens de entrada e 253 de saída (1.880)**, abaixo da reserva;
  - a guarda `g4` aceitou, sem sinal de injection;
  - os fatos batem com a vaga: `pleno`, `remoto`, `clt`, 3 anos, stack exigida Node.js/TypeScript/PostgreSQL/Vitest, desejável Redis/Docker e 3 benefícios.
  - O script imprime só booleanos da forma da chave, contagens e os fatos da vaga sintética. Não imprime a chave, o token, a conta nem a saída bruta.

### 6.4 Verificação (`[QA_EVALS]`)
- **Testes novos** no `compose-app.test.ts` (grupo da presentation):
  - a cadeia completa e parcial, a ordem da cadeia e o modelo padrão;
  - 11 falhas fechadas no boot de produção (cadeia ausente, vazia, com Ollama, com Gemini, repetida; chave do Groq ausente, vazia ou fora da forma; conta ou token da Cloudflare ausentes; modelo fora da forma), cada uma com a classe do erro, a variável e nenhum canário na mensagem;
  - o boot de produção sem as variáveis de LLM não sobe;
  - o segundo cadeado (Ollama e Gemini sem adapter);
  - de ponta a ponta com o Groq e a Workers AI simulados: Groq `ok` (`extracao_llm`, chave só no `Authorization`, Workers AI sem chamada, nenhuma credencial no Redis); Groq em 429 → Workers AI responde, com o `llm:block:groq` gravado; os dois recusam → `fallback_deterministico` com 200.
- O teste T28 do adapter foi invertido: o adapter só entra pela composição de produção, e a raiz genérica continua sem ele.
- **API com 2.901 testes e 100%** (3.156 instruções, 2.036 ramos). Typecheck, lint, depcruise (415 módulos, sem violação) e **turbo 21/21 em série**.
- **Mutação 13/13** (um mutante por vez, script fora do repositório). Dois sobreviventes da primeira rodada viraram teste:
  - Ollama permitido na cadeia: o segundo cadeado lançava a mesma classe. O teste agora confere que quem recusa é a validação da `LLM_PROVIDER_CHAIN`;
  - reserva sem a saída: 2.509 sozinho também arredonda para 3.000. A função passou a receber a medida, e o teste usa medidas sintéticas.
  - **Mutante não rodado, de propósito:** ignorar o `baseUrl` dos ganchos mandaria a chave canário dos testes ao Groq real.

### 6.5 Auditoria do `[APPSEC]` (sem veto)
| Vetor | Resposta | Prova |
|---|---|---|
| Configuração esquecida degradando em silêncio | Boot de produção falha fechado sem a cadeia ou sem a credencial de um provedor dela | 11 casos + "sem as variáveis de LLM não sobe" |
| Segredo em log ou erro (SR-12) | Mensagens citam só o nome da variável; credenciais só no *closure* | canários de chave, token e chave malformada ausentes de toda mensagem, do `JSON.stringify` da composição e dos comandos do Redis |
| T28 (*downgrade*) | Ollama e Gemini recusados duas vezes; modelo do Groq fixo no código; `p3`/`g4` conferidos | testes da cadeia, do segundo cadeado e da versão do prompt |
| Privilégio mínimo | Credencial de provedor fora da cadeia não é lida | cadeia só com o Groq sobe sem o token da Cloudflare |
| SSRF por configuração | `baseUrl` só nos ganchos de teste; o `main.ts` não os passa | teste do texto do `main.ts` |
| LGPD (ADR-001 D2) | O *smoke* usou vaga sintética; o payload continua só `text` | script revisado; nada de perfil, critério ou usuário |
| T7 (custo) | Reserva de 3.000 calibrada pela medida; o *smoke* gastou 1.880 tokens | teste da reserva; saída do *smoke* |

**Riscos residuais aceitos:**
- `CLOUDFLARE_WORKERS_AI_MODEL` pode trocar o modelo do fallback sem passar pelo gate (herdado do ADR-020 D8). O `.env.example` avisa que a troca exige o gate antes (T28). Fixar no código, como o Groq, fica para uma emenda se o humano quiser.
- O `rpd` da Workers AI continua na estimativa conservadora (54 publicado, 45 efetivo). O S-1 mediu 74 neurônios por chamada em média (p95 101), o que daria 99 publicado (84 efetivo). Recalibrar é emenda ao ADR-020 D9, do lado seguro, e fica pendente.
- O achado do `p3` (`0` no lugar de `null` em `yearsExperienceMin`) vai para a produção, como decidido no HITL-032 1A. O relatório pode mostrar "0 anos" em vaga sem requisito declarado até o próximo prompt.
