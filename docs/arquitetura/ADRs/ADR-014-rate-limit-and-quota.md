---
tipo: adr
id: ADR-014
titulo: "Rate limit por usuário e por IP, cota diária idempotente e QuotaLedger em Redis (E0 e Camada 3): portas na aplicação, cliente REST do Upstash sem dependência nova, chaves com HMAC e falha fechado"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]), dentro do ADR-001 §5.1 e §5.5 aprovados no HITL-001. Não muda contrato público."
data: 2026-10-21
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "F1-API-03 (apps/api: application/ports, application/limits, infrastructure/{redis,limits,crypto,time}, presentation/edge e main.ts)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-007-api-edge](ADR-007-api-edge.md)", "[ADR-009-llm-provider-router](ADR-009-llm-provider-router.md)", "[ADR-010-log-allowlist-and-telemetry](ADR-010-log-allowlist-and-telemetry.md)", "[ADR-013-jwt-verification](ADR-013-jwt-verification.md)", "[threat-model](../threat-model.md)", "*upstash-redis*", "*BACKLOG §F1-API-03*"]
---

# ADR-014: Rate limit, cota diária e `QuotaLedger` em Redis

## 1. Contexto

- O ADR-001 §5.1 põe o **rate limit** por usuário e por IP no `onRequest`, logo depois do JWT, e a **cota diária** idempotente por `requestId` depois da validação do corpo. Erros possíveis: 401, 429 com `Retry-After` e 503.
- O ADR-009 D6 deixou o `QuotaLedger` como porta, com *fakes*. A implementação em Redis precisa da folga de 15% e do **breaker diário global** de LLM (T7, mitigação 10).
- O **SR-06** pede que rate limit e cota falhem **fechado** em *timeout* ou erro de Redis. O **T39** lembra que o `@upstash/ratelimit` **libera** a requisição em *timeout* por padrão. O **SR-17** (T23, item 6) pede que nenhuma chave escrita no Redis tenha IP ou `sub` em claro.
- O HITL-007 está fechado: banco Free em `us-east-1`, *eviction* desligado e só o token Standard no `.env` da API.
- O requisito (`ideia_projeto.md`, linha 211) dá o exemplo de **5 por minuto** por usuário no `/analyze`, mais o limite por IP para contas criadas em massa.

## 2. Decisões

### D1. Portas na aplicação, guardas com prazo, adapters na infraestrutura e hooks na apresentação
```ts
// application/ports/rate-limiter.ts
type RateLimitClass = "padrao" | "analise";
type RateLimitDecision =
  | { ok: true }
  | { ok: false; reason: "limite_excedido"; retryAfterSeconds: number }
  | { ok: false; reason: "indisponivel" };
interface RateLimiter { check(cls, subject: { userId; clientAddress }, signal): Promise<RateLimitDecision> }

// application/ports/daily-quota.ts
type DailyQuotaDecision =
  | { ok: true; repeated: boolean }
  | { ok: false; reason: "esgotada"; retryAfterSeconds: number }
  | { ok: false; reason: "indisponivel" };
interface DailyQuota { consume(userId, requestId, signal): Promise<DailyQuotaDecision> }
```
- `application/limits/limit-guards.ts`: `RateLimitGuard` e `DailyQuotaGuard` envolvem as portas com **prazo** (corrida com `Clock.sleep`, como o router do ADR-009), **validação da forma** do resultado e captura de exceção. Qualquer coisa fora do contrato vira `indisponivel`. **Nunca rejeitam.**
- `application/limits/` também tem a política (constantes) e os algoritmos puros: janela deslizante, dia da cota e `Retry-After`. Eles são testados sem Redis.
- O `QuotaLedger` continua com a porta do ADR-009; o router já impõe o prazo de 250 ms e a falha fechada.
- `infrastructure/redis/upstash-rest-client.ts` é o **único** lugar que fala com o Upstash. Os três adapters ficam em `infrastructure/limits/`. O HMAC fica em `infrastructure/crypto/`, e o `SystemClock` (relógio monotônico real), em `infrastructure/time/`.
- `presentation/edge/rate-limit.ts` (hook `onRequest`) e `presentation/edge/daily-quota.ts` (fábrica de `preHandler` para a rota de análise do F1-API-04).
- **Os guardas são obrigatórios no `buildApp`**, como o verificador do ADR-013: não há padrão que libere tudo.

### D2. Sem dependência nova: cliente REST próprio, só com `fetch`
Conferidos no npm em 2026-10-21:

| Pacote | Versão | Publicada | Dependências | Proveniência |
|---|---|---|---|---|
| `@upstash/ratelimit` | 2.2.0 | 2026-09-23 | `@upstash/core-analytics` 0.0.10 (2024) e *peer* `@upstash/redis` | SLSA v1 |
| `@upstash/redis` | 1.39.0 | 2026-09-21 | `uncrypto` 0.1.3 (2023) | SLSA v1 |

As duas passam da quarentena de 3 dias do T26 e têm licença MIT. **Mesmo assim foram recusadas:**
- o `@upstash/ratelimit` libera no *timeout* por padrão (T39), traz analytics (custa comandos e é a dependência transitiva mais antiga) e faz a lógica em scripts Lua (`EVALSHA`). Nenhum Redis simulado executa esses scripts, então a regra que importa ficaria **sem teste**;
- o `@upstash/redis` faz *retry* com *backoff* por padrão (o que estoura o prazo da borda) e decodifica a resposta por conta própria. Ele não resolve nada que um `fetch` com `AbortSignal` não resolva;
- o protocolo é pequeno e documentado: `POST {url}/multi-exec` com `Authorization: Bearer`, corpo `[["CMD", ...], ...]` e resposta `[{ "result": ... }, ...]` (*upstash-redis* §4).

**Toda a lógica fica em TypeScript.** O Redis só recebe `INCR`, `INCRBY`, `DECR`, `GET`, `PEXPIRE`, `EXPIRE`, `SADD`, `SCARD` e `SREM`, dentro de uma transação (`MULTI`/`EXEC`, atômica no servidor). Assim, o Redis simulado dos testes reproduz a semântica de verdade.

### D3. Cliente REST: falha fechado em qualquer desvio
- `POST {UPSTASH_REDIS_REST_URL}/multi-exec`, com `redirect: "error"`, sem `?_token=` e com `AbortSignal.any([sinal do chamador, AbortSignal.timeout(200 ms)])`.
- No máximo 16 comandos por transação. A resposta é lida com teto de **16 KiB**, contando os bytes durante a leitura.
- **Só HTTP 200**, JSON válido, array com **exatamente** um item por comando, cada item `{ result: inteiro | string | null }` estrito. Um único `{ error }` (o Upstash segue executando os outros comandos da transação), um campo a mais, um tipo inesperado ou um status 401, 400 ou 5xx → `null`.
- O cliente **nunca rejeita**: devolve os resultados ou `null`. Cada adapter ainda confere o tipo de cada resultado (ex.: `INCR` inteiro ≥ 1, `PEXPIRE` = 1, `GET` nulo ou dígitos).

### D4. Rate limit: janela deslizante aproximada, por usuário **e** por IP
| Classe | Usuário | IP | Janela |
|---|---|---|---|
| `padrao` (toda rota protegida sem classe própria, inclusive inexistente) | 60 | 120 | 60 s |
| `analise` (o `/v1/analyze` do F1-API-04) | **5** | 20 | 60 s |
| `criterios` (o `PUT /v1/criteria` do F1-API-05; emenda do ADR-021 D8.2) | 10 | 30 | 60 s |

- A rota declara a classe em `config.rateLimit`. Valor desconhecido em tempo de execução vale a classe **mais estrita**.
- **Emenda do [ADR-021-criteria-routes](ADR-021-criteria-routes.md) D8.2 (2026-10-24, F1-API-05 commit 4):** entra a classe `criterios`, com 10 por minuto por usuário e 30 por IP, para o `PUT /v1/criteria`. Cada requisição dessa rota é uma cifragem e uma escrita no banco. O `GET` fica na `padrao`.
  - A `analise` continua a mais estrita nas duas dimensões, provado por teste contra todas as classes.
  - O valor desconhecido continua caindo na `analise`.
  - A classe tem contadores próprios no Redis (`rl:criterios:…`).
- **Algoritmo:** a janela atual e a anterior têm contadores próprios (`INCR`, `PEXPIRE` de 2 janelas + 1 s, `GET` da anterior). O peso é `floor(anterior × (janela − decorrido) / janela) + atual`, e passa se for ≤ limite. São 6 comandos por requisição, numa transação só (um único HTTP).
- **A requisição negada também conta.** Quem insiste continua bloqueado, o que vai na direção segura.
- `Retry-After` = segundos até o fim da janela atual, em [1, 60]. Vai no cabeçalho e no `retryAfterSeconds` do `ApiError`.
- **Endereço do cliente:** é o `request.ip` do Fastify (o `trustProxy` do ADR-007 decide se vale o `X-Forwarded-For`). O IPv4 mapeado em IPv6 (`::ffff:a.b.c.d`) vira IPv4. **O IPv6 conta pelo prefixo /64**, porque quem tem um /64 troca de endereço à vontade. Um valor que não é IP cai num balde único compartilhado.
- O rate limit roda **só depois de um JWT válido**. Uma inundação sem token, ou com token forjado, não gasta comando do Redis: 500 mil por mês é um orçamento que o atacante esgotaria, e o limitador, falhando fechado, derrubaria a API inteira. O custo antes da autenticação é uma verificação ES256 local (ver §3, resíduo).
- **Emenda do [ADR-004-extension-auth](ADR-004-extension-auth.md) D4 (F1-API-07 07g, 2026-11-07, `b516fd0`):** o `POST /v1/auth/logout` declara a classe `padrao` (60 por usuário e 120 por IP). Ele é protegido, então o rate limit conta no Redis só depois do JWT. As duas rotas públicas do BFF não passam por este rate limit, só pelo limitador local do D10.

### D5. Cota diária: conjunto por usuário e dia, idempotente por `requestId`
- **50 análises por dia por usuário** (hipótese; o Groq dá 50 a 65 por dia por modelo, ADR-001 §8). O dia é o calendário de **UTC−03:00** (Brasília, sem horário de verão desde 2019), para o "volte amanhã" fazer sentido.
- Chave `quota:{hmac(sub)}:{dia}` (um *set* Redis). Transação: `SADD chave requestId`, `SCARD chave` e `EXPIRE chave 172800`.
- **Passa se `SCARD ≤ 50`.** `SADD` = 0 marca uma repetição: o mesmo `requestId` passa de novo sem cobrar outra vez (retry de rede).
- **Negado e novo** (`SADD` = 1): `SREM` em melhor esforço. Isso mantém o *set* limitado a 50 mais a concorrência e devolve a resposta certa à repetição de um pedido que já tinha passado. Se o `SREM` falhar, sobra um membro a mais, ou seja, a contagem fica **maior**, o lado seguro.
- `Retry-After` = segundos até a meia-noite de Brasília (≤ 86.400, o teto do contrato).
- **Refina o ADR-001 §5.1:** o ADR previa `SET NX` em `quota:req:{user}:{requestId}`, com uma chave por análise. Contar essas chaves exigiria Lua (sem teste) ou duas viagens não atômicas. Com o *set*, a marca de idempotência e a contagem saem da mesma transação.
- O `requestId` é conferido de novo como UUID no guarda, sem confiar só na rota. Ele é aleatório do cliente e não identifica ninguém. O `sub` só aparece dentro do HMAC.

### D6. `QuotaLedger` em Redis (ADR-009 D6) e breaker diário global
| Provedor | RPM | RPD | TPM | TPD | Fonte |
|---|---|---|---|---|---|
| `groq` | 30 | 1.000 | 8.000 | 200.000 | *llm* (por modelo, na organização) |
| `cloudflare_workers_ai` | 60 | 200 | — | — | **Hipótese.** O limite real é de 10.000 *neurons* por dia, e os *neurons* por chamada só serão conhecidos no S-1 |
| `ollama` | — | — | — | — | Local, só em dev |
| `google_ai_studio` | sem política: **sempre `provedor_esgotado`** | | | | HITL-012 |

- O efetivo é `floor(publicado × 0,85)` (15% de folga).
- **Emenda (Trilha W1, 2026-10-31):** o RPD da Workers AI vem do p95 medido de neurônios por chamada: 99 publicado e 84 efetivo ([ADR-020-cloudflare-workers-ai-adapter](ADR-020-cloudflare-workers-ai-adapter.md) §10). A linha da tabela é a hipótese original. O breaker global de 400 continua sendo o teto do dia.
- **Breaker diário global:** **400 chamadas de LLM por dia** no serviço inteiro, somando os provedores (hipótese para a Fase 1, de uso pessoal: 50 análises × 2 chamadas × 4 de margem).
- Os dias e minutos dos provedores são em **UTC** (o Cloudflare zera às 00:00 UTC).
- **`reserve`:** uma transação com `INCR` + `EXPIRE` do global do dia, do RPM e do RPD do provedor, mais `GET` dos tokens do minuto e do dia, quando há limite de tokens. Global acima do teto → `global_esgotado`. RPM ou RPD acima, ou tokens no teto → `provedor_esgotado`. Na negação, os `DECR` de compensação vão em melhor esforço (se falharem, a contagem fica maior, o lado seguro).
- **Falha fechado:** Redis com erro, lento, travado ou com resposta inesperada → `global_esgotado`, que encerra a cadeia com `cota_esgotada` (ADR-009 D6). O adapter nunca rejeita, e o router continua com a própria corrida de 250 ms.
- **`recordUsage`:** `INCRBY` dos tokens no minuto e no dia, em melhor esforço. Uso fora da forma (negativo, fracionário ou acima de 10⁶) é ignorado.

> [!note] Emendas do [ADR-022-groq-adapter](ADR-022-groq-adapter.md) D7 (2026-10-26, desenho)
> - **Reserva pessimista de tokens:** `reservedTokensPerCall` (3.000 no Groq, `null` nos demais) entra no TPM e no TPD já no `reserve`, e a negação passa a contar a reserva. O `recordUsage` reconcilia com `real − reserva`, e a chamada sem 200 fica com a reserva cheia. Entra no commit 3.
> - **Implementado em 2026-10-27** (commit `1b07950`, local). Dois ajustes de implementação, sem mudar a decisão:
>   - o provedor sem limite de tokens (Workers AI e Ollama) deixou de ler TPM/TPD no `reserve`: os dois `GET` nunca decidiam nada, e a transação dele cai de 8 para 6 comandos. Um teste da política impõe que todo provedor com TPM ou TPD tenha reserva;
>   - o `INCRBY` da reserva aceita inteiro com sinal. A reconciliação que cruza a virada do minuto ou do dia UTC cai na janela nova e pode deixá-la negativa. O desvio é de no máximo (reserva − uso) por chamada que cruza a virada, e a soma das duas janelas fica exata (risco residual aceito no [ADR-022-groq-adapter](ADR-022-groq-adapter.md) §5).
> - **Bloqueio por `Retry-After`:** `recordRateLimit` grava `llm:block:{provider}` com `PX` em [1 s, 1 h] (60 s com `null`). O `reserve` lê a chave na mesma transação e, se ela existir, responde `provedor_esgotado`. Entra no commit 4.
> - **Bloqueio implementado em 2026-10-27** (commit `27aa181`, local), sem mudar a decisão. `null`, negativo ou não finito vira 60 s, e o `PX` leva o valor arredondado para cima. Um `EXISTS` fora de 0/1 falha fechado. Um 429 posterior com `Retry-After` menor sobrescreve o bloqueio: é a informação mais recente do provedor.
> - A linha da Workers AI na tabela acima está desatualizada: o `rpd` publicado é 54, e o efetivo é 45 ([ADR-020-cloudflare-workers-ai-adapter](ADR-020-cloudflare-workers-ai-adapter.md) §6.2).

### D7. Chaves pseudonimizadas (SR-17, T23 item 6)
- `HMAC-SHA256(RATE_KEY_PEPPER, "<domínio>:<valor>")`, truncado em **32 hex** (128 bits). Os domínios `sub` e `ip` são separados, para o mesmo valor não colidir entre eles.
- O `RATE_KEY_PEPPER` é **obrigatório**: base64url de **pelo menos 32 bytes** (43 caracteres ou mais). Valor curto ou com outros caracteres derruba a subida. Uma frase digitada à mão não passa, e o HMAC continua resistente à força bruta sobre o espaço IPv4.
- Prova: o Redis simulado registra **todo argumento** de todo comando, e o teste falha se aparecer o IP, o prefixo /64, o `sub`, ou o `sub` sem hífens.
- **Rotação do *pepper*:** troca as chaves, e os contadores recomeçam do zero. É aceitável (zera, no máximo, um dia de cota).

### D8. Ordem, instâncias e ambiente
- `onRequest`: CORS → tipo de mídia → JWT → **rate limit**. `preHandler` (depois da validação do corpo) da rota de análise: **cota diária**.
  - **Emenda do [ADR-004-extension-auth](ADR-004-extension-auth.md) (F1-API-07 07e, 2026-11-07, `ac3c2c7`):** nas duas rotas públicas de auth (ligadas no 07g), o limitador local do D10 entra no `onRequest` **da própria rota**, que o Fastify roda depois dos globais. Ali o JWT e o rate limit passam sem efeito (rotas públicas), então a ordem efetiva é CORS → tipo de mídia → limitador local → `bodyLimit` de 2.048 → Zod. O limitador local **não é o *ephemeral cache* do T39**: não guarda decisão do Redis, não substitui o rate limit no Redis (que segue sendo o único das rotas protegidas) e falha para o lado restritivo (transbordo sem despejo).
- O cliente REST, o HMAC, os adapters e os guardas são **criados uma vez no `main.ts`**. Não há instância por requisição nem *cache* em memória entre requisições: o *ephemeral cache* do T39 não existe aqui.
- `UPSTASH_REDIS_REST_URL` (origem `https` exata; `http` só em *loopback*, para o Redis simulado), `UPSTASH_REDIS_REST_TOKEN` (1 a 512 caracteres, sem espaço) e `RATE_KEY_PEPPER` são **obrigatórios** e validados no *boot*. Sem eles, a API não sobe. Só os **nomes** entram no `.env.example`.

### D9. Respostas e logs
- Limite excedido → **429 `LIMITE_DE_TAXA`** com `Retry-After`. Cota → **429 `COTA_DIARIA_ESGOTADA`** com `Retry-After`. Redis indisponível ou fora do contrato → **503 `SERVICO_INDISPONIVEL`**. **Nunca 200.**
- Mensagens novas no catálogo do ADR-010: `limite_indisponivel` e `cota_indisponivel` (nível `warn`, sem campos). Nenhuma chave, IP, `sub`, `requestId` ou contagem vai para o log. A lista fechada do `streamWrite` já impediria isso.

### D10. Limitador local pré-JWT, orçamento de saída e *bulkhead* do GoTrue
> [!note] Emenda do [ADR-004-extension-auth](ADR-004-extension-auth.md) D8 itens 4 e 5 (F1-API-07 commit 07e, 2026-11-07, `ac3c2c7`). Nenhuma rota usa estas peças antes do 07g (ADR-004 §6.3, condição 1).

- **Limitador local** (`presentation/edge/pre-auth-limit.ts`), só nas rotas públicas de auth (`POST /v1/auth/exchange` e `POST /v1/auth/refresh`):
  - em memória do processo, **sem nenhum comando Redis antes do JWT** (§3);
  - janela deslizante de 60 s com a conta do D4 (janela atual + fração da anterior), e a negada também conta;
  - `auth_troca` 10/min e `auth_renovacao` 30/min por balde. O balde é o do D4 (IPv4 mapeado vira IPv4, IPv6 pelo /64, não-IP num balde único), sobre o `request.ip`;
  - chave `<classe>:HMAC-SHA256(RATE_KEY_PEPPER, "ip:<balde>")`, com o mesmo pseudonimizador do D7: nem o IP nem o /64 ficam em claro na memória (SR-17 por analogia);
  - no máximo 10.000 baldes vivos. Cheio, os novos dividem um balde de transbordo **por classe**, e nenhum balde vivo é despejado. Só sai da tabela o balde vencido (sem uso há duas janelas, peso zero). A tabela fica em ordem de último uso, e a varredura tira do começo até o 1º balde vivo (custo amortizado constante);
  - excedido: 429 `LIMITE_DE_TAXA` com `Retry-After` até o fim da janela atual, em [1, 60]. Nada vai a log no 07e: a linha amostrada `auth_limite_local` entra no 07g (ADR-004 D8 item 7).
- **`API_BEHIND_PROXY`** (`presentation/edge/behind-proxy-env.ts`): `true` ou `false` exatos, obrigatória fora de `NODE_ENV=test` exato (sem `NODE_ENV` conta como produção) e concordando com o `TRUST_PROXY`. `true` sem os saltos derruba o boot, e `false` com saltos também (declaração contraditória). Com `NODE_ENV=test` e vazia, segue o `TRUST_PROXY`. A mensagem não repete valor. A leitura no boot entra no 07g.
- **Orçamento de saída** (`application/auth/gotrue-egress.ts`), por instância, no relógio monotônico:
  - registro exato das chamadas numa janela deslizante de 300 s, (agora − 300 s, agora]: nunca estoura na virada;
  - `troca` até 14 e total no `/auth/v1/token` até 74 (troca + renovação, contando a nova tentativa do ADR-004 D4 passo 6), abaixo de 50% dos limites do P19 (30 e 150 por 5 min por IP). Os dois lados ficam presos por teste;
  - reserva da renovação de 37 vagas (50% do total). A troca passa se `T < 14` e `T + max(R, 37) < 74`; a renovação, se `T + R < 74`. Com a troca em 14, a reserva não morde; ela vale por si se a troca crescer (provado com uma política de teste);
  - negado: `orcamento_esgotado`, com `retryAfterSeconds` até a 1ª chamada cuja saída da janela libera a partição, em [1, 300]. A negação não consome nada;
  - o logout (`/auth/v1/logout`) passa só pelo *bulkhead*, sem orçamento, até o 07h conferir no GoTrue local em que balde ele cai.
- ***Bulkhead*:** no máximo 4 chamadas simultâneas ao GoTrue por instância, decidido antes do orçamento (cheio, nenhuma vaga do orçamento é gasta). O excesso é `bulkhead_cheio` com `retryAfterSeconds: 5`. A vaga volta quando a chamada termina, inclusive se ela rejeitar.
- **Quem chama:** os casos de uso do 07f, depois do Zod e, na renovação, depois do `open`. O operador "orçamento antes do `open`" do M-16 se prova lá, assim como o mapa para o 503 do ADR-004 D7. A métrica `auth_orcamento_gotrue{particao,resultado}` entra no 07g.
- **Resíduos:**
  - limitador e orçamento são por instância: com N instâncias, ou com o portal no mesmo IP de saída, os tetos do P19 se dividem (ADR-004 D8 item 5);
  - um IP sozinho esvazia a partição `troca` com o limite de 10/min (residual "sem Cloudflare até o S-5", ADR-004 §3);
  - sob inundação de IPs novos, o transbordo nega também o usuário legítimo e novo. É o lado restritivo, por desenho.
- **Prova (2026-11-07):** API de 3.220 para 3.293 testes, 100% nas 4 métricas. Mutação 41/41, com hash restaurado idêntico: M-16 (limiares +1, chave sem HMAC, transbordo que despeja, *bulkhead* 5, troca e total +1) e dirigidos (IPv6 fora do /64, janela fixa no limitador e no orçamento, reserva ignorada ou fixa, `X-Forwarded-For` de IP não confiável aceito, negada que não conta, varredura que tira balde vivo, vaga do *bulkhead* que não volta na rejeição, `API_BEHIND_PROXY` frouxo, entre outros). Turbo 21/21 em série; depcruise sem violações (452 módulos).

## 3. Auditoria `[APPSEC]` (antes do código)
- **Sem veto.** Restrições que viraram critério de aceite:
  1. **Falha fechado provada** com Redis simulado em socket real: lento (acima do prazo), travado (nunca responde), 500, 401, `{ error }` global, `{ error }` em um comando, JSON inválido, array do tamanho errado, tipo errado, campo a mais, corpo acima de 16 KiB e redirecionamento. Em todos os casos: 503 ou negado, **nunca** liberado.
  2. A porta falsa que lança, rejeita, trava ou devolve lixo também dá 503 (o guarda não confia no adapter).
  3. **SR-17:** nenhum argumento enviado ao Redis contém IP, prefixo /64 ou `sub` (com e sem hífens).
  4. **SR-12:** canário de IP, `sub`, `requestId`, token e *pepper* ausente de todas as linhas de log, nos caminhos 200, 429 e 503.
  5. Nenhum teste toca o Upstash real: o simulado roda em `127.0.0.1`, e o `.env` não é lido.
  6. O token vai só no header (nunca na URL), e o adapter não segue redirecionamento (o token não vaza para outro host).
  7. Nada no corpo é lido antes do rate limit; a cota só lê o `requestId` já validado.
- **Dependência nova:** nenhuma (D2). As duas candidatas foram conferidas e recusadas.
- **Resíduo (corrige o ADR-013 §3):** o ADR-013 contava com o limite por IP para cobrir a inundação de tokens forjados. Pelo D4, o limite por IP roda **depois** do JWT, para proteger o orçamento de comandos. A inundação sem token custa só ES256 local e fica para a borda da hospedagem (S-5, registrado no *BACKLOG*). **Aprovado pelo humano em 2026-10-21:** requisição anônima é barrada antes do Redis, para proteger a cota do Upstash (*Denial of Wallet*), e o bloqueio de inundação fica com o provedor de borda (**Cloudflare**).
  - **Segue de pé (emenda do [ADR-004-extension-auth](ADR-004-extension-auth.md), 2026-11-07):** o limitador das rotas públicas de auth (D10) é só em memória e não manda nenhum comando ao Redis antes do JWT.
- **Resíduo:** a janela deslizante aproximada admite, no pior caso, um pequeno excesso na virada de janela. Com o limite baixo e a requisição negada contando, o efeito é pequeno.
- **Resíduo:** o relógio de parede de cada instância define a janela e o dia. Basta NTP, porque a diferença só desloca a janela.

## 4. Verificação
- Testes do cliente REST, dos adapters e dos hooks contra um **Upstash simulado em socket real** (`test/infrastructure/fake-upstash.ts`), com modos lento, travado, com erro e com lixo, e contra portas falsas na presentation.
- Algoritmos puros com propriedades: o peso da janela nunca passa do limite admitido; o `Retry-After` fica em [1, 60]; o dia muda exatamente às 03:00 UTC.
- Cobertura de 100% de linhas e ramos nos arquivos novos, mutação manual e turbo em série (`--concurrency=1`, QA-01).

**Resultado (2026-10-21):**
- 351 testes novos; a API passou de 965 para **1.316**, com **100%** de linhas (1.339/1.339) e de ramos (1.075/1.075). A cobertura passou a incluir `infrastructure/{redis,limits,time}`, os hooks novos e o `api-error.ts`.
- **Mutação 98/98** (script fora do repositório, com hash dos `src` conferido antes e depois). A 1ª rodada deixou 9 sobreviventes, todos lacunas reais de teste, e todos viraram testes:
  - status ≠ 200 com um corpo que seria válido;
  - teto exato de 16 KiB;
  - UTF-8 inválido dentro de uma string;
  - relógio negativo na cota e no `recordUsage`;
  - `::` no meio do IPv6 e IPv4 embutido;
  - zona num IPv4 mapeado;
  - timer solto no abort do `systemClock`.
- **Achado do teste do HMAC:** num *pepper* base64url de 43 caracteres, o último caractere carrega 2 bits de enchimento descartados, então trocá-lo não muda a chave. É inofensivo (os 32 bytes continuam aleatórios), e o teste de rotação troca o primeiro caractere.
- Turbo 18/18 em série (`--force`), depcruise verde (278 módulos), lint e typecheck verdes.
- *Smoke* do JS compilado: sem as variáveis do Upstash ou do *pepper*, ou com *pepper* fraco, o processo sai com código 1 antes de abrir a porta, sem ecoar o valor. Completo, `/health` dá 200 e rota protegida sem JWT válido dá 401.
- O `main.ts` liga o rate limit e a cota. O `createRedisQuotaLedger` está pronto e provado com o router real, mas a ligação dele no `main.ts` fica com o `AnalyzeJob` (F1-API-04), que é quem monta o router.
