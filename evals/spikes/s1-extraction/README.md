# S-1: extração com provedores reais (spike descartável)

Mede a Camada 2 (ADR-001 §5.5) nos 83 casos do golden dataset `gd1`, com o prompt `p1` e o `LlmOutputGuard` `g2`
reais: Groq `openai/gpt-oss-20b` (chamada própria, porque o adapter espera o S-1) e Cloudflare Workers AI pelo
adapter do ADR-020. O plano é estratificado (decisão do humano em 2026-10-24): 6k nos 83 casos e 4k/8k só onde o
orçamento muda o texto enviado.

## Rodar

```bash
S1_MODE=plan   pnpm --filter @trampo/evals spike:s1 --silent=false   # sem rede: plano e prova do avaliador
S1_MODE=smoke  pnpm --filter @trampo/evals spike:s1 --silent=false   # 1 chamada por provedor
S1_MODE=run    pnpm --filter @trampo/evals spike:s1 --silent=false   # o plano inteiro, retomável
S1_MODE=report pnpm --filter @trampo/evals spike:s1                  # sem rede: refaz out/s1-metrics.json
S1_MODE=diag   pnpm --filter @trampo/evals spike:s1 --silent=false   # refaz em memória as saídas que o guard recusou
```

`S1_PROVIDERS=groq` (ou `cloudflare_workers_ai`) limita a um provedor; `S1_MAX_ITEMS` limita as chamadas.
`S1_GROQ_VARIANT=nao_estrito` manda o `json_schema` sem `strict`, e `S1_ONLY=json_validate_failed` roda só os itens que o
Groq estrito recusou (no arquivo do p1). `S1_BUDGETS=6000` limita os orçamentos (a rodada de aceite do `p2` não refaz a
varredura de 4k/8k). O relatório traz, além de cada variante, o Groq `composto`: a linha estrita aceita mais a
`nao_estrito` onde o estrito foi recusado. As chaves
saem só de `apps/api/.env` (`GROQ_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` e, opcional,
`CLOUDFLARE_WORKERS_AI_MODEL`), sem passar pelo `process.env`.

## Peças

| Arquivo | O quê |
|---|---|
| `env.ts` | Lê só as quatro variáveis do spike do `.env`; nunca imprime valor. |
| `cases.ts` | Casos, micro-payload (`n1` + `sel1` em 4k/6k/8k) e o plano estratificado. |
| `providers.ts` | Groq com `json_schema` estrito, `reasoning_effort: low` e sem `tools`; Workers AI pelo adapter real com `fetch` instrumentado (status, cabeçalhos de lista fechada, código de erro). |
| `runner.ts` | Percorre o plano, aplica o guard, mede o JSON cru, procura o canário e dá ritmo pelos cabeçalhos; para no teto diário. |
| `score.ts` | Métricas por campo do golden-dataset-spec §8.1 e §8.2 (aliases do `td1`, dobra de cidade do ADR-002). |
| `report.ts` | Agrega todas as versões em `out/s1-metrics.json`, inclusive o Groq `composto`, o gate do `gd2` (golden-dataset-spec §8.2) por grupo e a comparação com o `p1` (tokens de entrada pareados por caso e as métricas que o `p2` mira). |
| `diag.ts` | `S1_MODE=diag`: issues do Zod (caminho, código e valor só com forma de enum) e o guard simulado sem os itens fora do enum, em `out/s1-diag.json`; não grava linha no JSONL. |
| `store.ts` | `out/s1-results.<prompt>-<guard>.jsonl` (um arquivo por versão, com `promptVersion` e `guardVersion` em cada linha), sem texto de vaga nem saída bruta. A rodada do `p1`/`g2` está arquivada em `s1-results.p1-g2.jsonl`. |

## Limites conhecidos

- O maior texto normalizado do `gd1` tem 5.602 caracteres: em 8k o payload é idêntico ao de 6k em todos os casos, e
  4k só muda o texto em 9. A varredura de orçamento não prova nada acima de 6k.
- T4 é aproximado: conta termos de stack fora do gabarito e das alternativas nos casos de negação. O gabarito não lista os
  termos negados, então no gate do `gd2` o T4 dá `revisar` (com os termos), e a revisão manual fica na spike-metrics.
- Neurônios da Workers AI são calculados pelo preço publicado do Llama 3.3 70B, não lidos da API (que não os devolve).
- `out/` guarda os fatos saneados (inclusive `title` e `city`) para repontuar sem cota; é ignorado pelo git.
