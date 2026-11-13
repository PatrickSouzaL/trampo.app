---
tipo: adr
id: ADR-015
titulo: "JobFactsCache (E3): política de escrita na aplicação, revalidação completa na leitura, SET NX EX no Upstash e falha como miss"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]), dentro do ADR-001 §5.4 (C8) aprovado no HITL-001. Não muda contrato público."
data: 2026-10-21
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "F1-CACHE-01 (apps/api: application/cache, application/ports, infrastructure/cache e infrastructure/redis)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-005-job-text-normalizer](ADR-005-job-text-normalizer.md)", "[ADR-008-llm-output-guard](ADR-008-llm-output-guard.md)", "[ADR-009-llm-provider-router](ADR-009-llm-provider-router.md)", "[ADR-011-deterministic-signals-and-fact-resolver](ADR-011-deterministic-signals-and-fact-resolver.md)", "[ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md)", "[threat-model](../threat-model.md)", "*upstash-redis*", "*BACKLOG §F1-CACHE-01*"]
---

# ADR-015: `JobFactsCache` (E3)

## 1. Contexto

- O ADR-001 §5.4 (C8) fixa o cache de `JobFacts`:
  - **chave** `jobfacts:v1:{extractorVersion}:{textHash}`, com TTL de 10 dias;
  - **leitura** com parse seguro e `JobFactsCacheEntrySchema`; se falhar, é *miss*, a chave é apagada e sai um alerta `cache_corrompido`;
  - **escrita** só com saída válida, sem remoção classificada como injection, injection `baixa`, `effectiveConfidence ≥ 0,5` e análise não degradada, por `SET … NX EX`.
- O **SR-08** pede: não gravar com injection, baixa confiança ou degradado; revalidar na leitura; `SET NX`. O **T11** (envenenamento do cache compartilhado) lista as mesmas mitigações.
- O ADR-014 deixou pronto o cliente REST do Upstash, que falha fechado e nunca rejeita. O *eviction* está desligado (*upstash-redis* §3): o TTL é quem limpa.
- O C8 também diz: "troca de prompt, **modelo** ou schema nunca serve fato velho".

## 2. Decisões

### D1. A política fica na aplicação; o Redis só guarda strings
```ts
// application/ports/job-facts-cache-store.ts
type CacheStoreRead = { ok: true; value: string | null } | { ok: false };
type CacheStoreWrite = "gravado" | "ja_existia" | "indisponivel";
interface JobFactsCacheStore {
  read(key, signal): Promise<CacheStoreRead>;                         // GET
  writeIfAbsent(key, value, ttlSeconds, signal): Promise<CacheStoreWrite>; // SET NX EX
  remove(key, signal): Promise<void>;                                  // DEL, melhor esforço
}
```
- `application/cache/job-facts-cache.ts` (`JobFactsCache`) monta a chave, decide a escrita, serializa, revalida a leitura e dá prazo a cada operação. Ele **nunca rejeita**.
- `infrastructure/cache/redis-job-facts-store.ts` é o adapter sobre o `RedisTransactions` do ADR-014: um comando por operação, com cada resposta conferida (`SET` devolve `"OK"` ou `null`; `GET` devolve string ou `null`).
- O cliente REST ganha **limites por instância**. O cache usa uma instância própria, com string de até 16.384 caracteres e resposta de até 128 KiB. A instância do rate limit continua com 64 e 16 KiB.

### D2. Chave versionada, inclusive pela guarda e pelo orçamento
- `extractorVersion = jf-{prompt}-s{schema}-{normalizador}-{seletor}-{guarda}-b{orçamento}`, por exemplo `jf-p1-s1-n1-sel1-g2-b6000` (25 de 32 caracteres do `VersionTagSchema`).
- A guarda entra na versão porque o que ela aceita define o que o cache guarda. O orçamento entra porque muda o texto que o LLM recebe.
- A versão do prompt chega com o adapter do Groq (F1-LLM-01 parte 2), e até lá o chamador passa a tag. O construtor confere a versão montada contra o `VersionTagSchema` e **lança no boot** se não servir.
- `textHash` é o sha256 do texto **normalizado** (ADR-005). A chave não tem nada do usuário.

### D3. Política de escrita (SR-08): todas as condições, na ordem
O candidato é a **saída da guarda** (`JobFacts` antes da fusão), que não depende do usuário. Uma recusa devolve só o motivo:

| Condição | Recusa |
|---|---|
| Análise degradada (fallback ou etapa com falha) | `degradada` |
| Injection da Camada 1 ≠ `baixa` | `injecao_no_texto` |
| `sanitization.injectionSignal` (URL, oculto ou marcação removidos da saída) | `injecao_na_saida` |
| `effectiveConfidence` < 0,5, ou não finito | `baixa_confianca` |
| Provedor fora de `PRODUCTION_PROVIDERS` (o Ollama de dev nunca grava no cache compartilhado), ou par provedor/modelo fora da cadeia configurada | `provedor_nao_permitido` |
| Fatos que não são **ponto fixo da guarda** (D5) ou entrada que não passa no `JobFactsCacheEntrySchema` | `fatos_fora_do_contrato` |
| `textHash` fora do formato sha256 | `fatos_fora_do_contrato` |

- Só então vem `SET chave valor NX EX 864000`: o primeiro que escreve ganha, e ninguém sobrescreve (`ja_existia`).
- A escrita é um efeito colateral do sucesso: o `AnalyzeJob` (F1-API-04) a dispara sem bloquear a resposta.

### D4. Leitura: tudo é conferido de novo, e qualquer dúvida é *miss*
1. `GET`. Sem valor → `ausente`. Redis fora do contrato, lento ou travado → `indisponivel` (sem `DEL`).
2. String acima de 16.384 caracteres → `corrompido`.
3. `JSON.parse` que recusa `__proto__` e `constructor` (o mesmo parse da guarda, agora exportado) → `JobFactsCacheEntrySchema` estrito.
4. Coerência com a chave: `extractorVersion` e `textHash` iguais aos pedidos. `extractedAt` não pode estar mais de 5 minutos no futuro, nem ser mais velho que o TTL mais 1 dia.
5. **Ponto fixo da guarda** (D5).
6. Provedor e modelo fora da cadeia atual → `obsoleto`. É um fato válido de um modelo que saiu da configuração, e o C8 manda não servi-lo.

- `corrompido` e `obsoleto` disparam `DEL` em melhor esforço. Assim, a próxima escrita volta a ser possível, já que o `SET NX` não sobrescreve.
- O resultado leva só o motivo. Quem registra o alerta `cache_corrompido` é o `AnalyzeJob` (F1-API-04), pelo catálogo do ADR-010. O cache não tem logger.

### D5. "Ponto fixo da guarda" na escrita e na leitura
- `guard.inspect(JSON.stringify(fatos))` precisa dar `ok`, com todos os contadores de saneamento em zero, `injectionSignal` falso e os mesmos fatos (comparação canônica).
- Isso garante que o que sai do cache é exatamente o que uma resposta limpa do LLM produziria hoje, inclusive teto em bytes, NFKC e remoção de URL, invisível e marcação. Uma entrada adulterada no Redis (por quem tenha o token) não passa nenhum texto que a guarda barraria.
- Se a guarda mudar de versão, a chave muda (D2), e o fato velho não é nem lido.

### D6. Prazos e falha como *miss*
| Constante | Valor | Regra |
|---|---|---|
| `ttlSeconds` | 864.000 (10 dias) | ADR-001 §5.4 |
| `minConfidence` | 0,5 | `CACHE_MIN_CONFIDENCE` do ADR-001 |
| `entryMaxChars` | 16.384 | Só na leitura. Na escrita, o `JobFactsSchema` já limita a entrada bem abaixo disso, e um teste falha se o schema crescer a ponto de passar do teto |
| `lookupTimeoutMs` | 150 | Corrida com o `Clock`. Estourou → `indisponivel` (*miss*) |
| `storeTimeoutMs` | 250 | Estourou → `indisponivel` |
| `clockSkewMs` | 300.000 | Tolerância do `extractedAt` no futuro |

- **Cache não é controle de segurança: é otimização.** Falhar como *miss* significa chamar o LLM, e o custo disso já é limitado pelo rate limit, pela cota e pelo `QuotaLedger` (ADR-014). Falhar como *hit* seria servir um fato não conferido: isso **nunca** acontece.

## 3. Auditoria `[APPSEC]` (antes do código), com foco no SR-08
- **Sem veto.** Restrições que viraram critério de aceite:
  1. **Uma recusa por condição da D3**, cada uma testada isoladamente (as outras condições válidas) e sem nenhum comando ao Redis.
  2. **Dev não envenena o compartilhado:** o Ollama nunca grava, e uma entrada do Ollama lida no Redis é recusada.
  3. **Adulteração no Redis:** campo a mais, `__proto__` (inclusive escapado), tipo errado, versão ou hash trocados, `extractedAt` no futuro ou velho demais, URL ou invisível no título ou numa tag, JSON truncado e string gigante (acima de 16.384 caracteres). Tudo vira *miss*, com `DEL`.
  4. `SET NX EX` com o TTL certo; uma segunda escrita não sobrescreve a primeira.
  5. Redis lento, travado, com erro ou com resposta inesperada: a leitura é *miss* e a escrita, `indisponivel`. Nunca *hit*.
  6. **Sem dado de usuário:** o valor gravado tem só os campos estritos da entrada. A propriedade confere que nenhum canário do perfil aparece no valor. A chave só tem versão e hash.
  7. Nenhum teste toca o Upstash real.
- **Dependência nova:** nenhuma.
- **Resíduo (T11, já registrado):** uma extração ruim **sem** sinal de injection fica no cache até o TTL. A invalidação por "discordo" recorrente fica com o F1-OBS.
- **Resíduo:** quem tem o token do Upstash pode **apagar** entradas (o que só custa uma chamada de LLM) ou gravar uma entrada que passe na guarda. Esse atacante já controla o Redis inteiro; a defesa é o token só no servidor e a rotação (*upstash-redis* §4.2).
- **Nota:** o `effectiveConfidence` vem do `FactResolver`, que vê os termos marcados pelo usuário. Por isso o usuário pode, no máximo, **impedir** uma escrita, nunca mudar o que é gravado: o valor é a saída da guarda, que não depende dele.

## 4. Verificação
- Política e leitura contra uma porta em memória com modos de falha; adapter contra o Redis simulado em memória; pilha completa (cache + adapter + cliente REST) contra o Upstash simulado em socket real.
- Propriedades: a saída da guarda é ponto fixo dela mesma (senão as entradas boas nunca dariam *hit*); ida e volta escrita → leitura devolve os mesmos fatos; para qualquer string no Redis, a leitura nunca dá *hit* sem passar no schema e na guarda.
- Cobertura de 100% de linhas e ramos, mutação manual e turbo em série.

**Resultado (2026-10-21, commit `c928716`):**
- 111 testes novos; a API passou de 1.316 para **1.427**, com **100%** de linhas (1.438/1.438) e de ramos (1.161/1.161).
- As 3 propriedades passam: a saída da guarda é ponto fixo dela mesma (com mais de 300 de 1.000 saídas hostis aceitas), ida e volta em 500 casos, e 1.000 strings arbitrárias ou adulteradas no Redis.
- **Mutação 47/47** não equivalentes mortos (script fora do repositório, com hash dos `src` conferido antes e depois). O único equivalente foi a checagem do `textHash` na política de escrita, que repetia o `JobFactsCacheEntrySchema`; o código saiu.
- **Defeitos achados pelos testes e corrigidos antes do commit:**
  - o orçamento negativo passava na versão do extrator, porque `b-1` cabe no padrão da tag (agora exige inteiro positivo);
  - o teto de 16.384 caracteres na **escrita** era inalcançável e saiu (D3 e D6 atualizados). Um teste falha se o schema crescer a ponto de passar do teto.
- **Refatorações sem mudança de comportamento:** o parse sem `__proto__` da guarda foi exportado (`parseJsonWithoutPrototypeKeys`); a corrida de prazo saiu dos guardas do ADR-014 para `application/shared/with-deadline.ts`; o cliente REST ganhou tetos por instância.
- **Achado para o F1-LLM-02:** o padrão do `model` no `JobFactsCacheEntrySchema` (`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$`) recusa os ids da Cloudflare Workers AI, que começam com `@cf/`. O router (ADR-009 D7) e o cache recusariam esse adapter. Isso precisa de decisão de contrato no F1-LLM-02.
- Turbo 18/18 em série (`--force`); depcruise verde (292 módulos).
- O `JobFactsCache` está pronto e provado contra o Upstash simulado. A ligação no `main.ts` (cliente REST com `CACHE_CLIENT_LIMITS` e `extractorVersionTag` com a versão do prompt) fica com o `AnalyzeJob` (F1-API-04).

## 5. Emenda (2026-10-23, F1-LLM-02): id da Workers AI no `model`
Fecha o achado do §4. Por decisão do humano de 2026-10-22, o `model` do `JobFactsCacheEntrySchema` passou a aceitar **só o prefixo exato `@cf/`** no início: `^(?:@cf\/)?[A-Za-z0-9][A-Za-z0-9._:\/-]{0,79}$`, com `.max(80)` para o teto continuar em 80 com o prefixo. Todo outro `@` é recusado, e também `@CF/`, `@cf` sem barra, `@cf//`, `x@cf/` e `@cf/` vazio. O router (ADR-009 D7) valida pelo mesmo `shape.model`.
- **Cache:** uma entrada com `@cf/` só é lida e gravada se o par provedor e modelo estiver na cadeia configurada (D6). O contrato não amarra `@cf/` ao provedor `cloudflare_workers_ai`, e o par da cadeia faz isso.
- **`schemaVersion` continua 1:** a regra só aceita mais. Um *deploy* antigo que leia uma entrada `@cf/` a trata como *miss* e apaga (falha segura).
- **Prova:** 38 testes no contrato, o espelho da gravação e da leitura no cache e a cadeia do router. Mutação com 17 mutantes, 16 mortos e 1 equivalente. Commit `a703ed3`.
