---
tipo: adr
id: ADR-021
titulo: "GET e PUT /v1/criteria: leitura e escrita dos critérios pelo cliente de usuário do PostgREST, pretensão cifrada antes de sair da API e origem da extensão fora da rota"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]) dentro do ADR-001 §5.1, do contrato UserCriteriaSchema, do ADR-007, do ADR-014, do ADR-017 e do ADR-018. Ordem do humano em 2026-10-23 (next-step). Muda o contrato público só por um teto de bytes no UserCriteriaSchema (D3), que nenhum perfil real alcança, e emenda o ADR-007 D6 (CORS por rota) e o ADR-014 D4 (classe `criterios`). Nenhuma migration nova, nenhuma dependência nova, nenhum HITL para desenhar. O fechamento do commit 6 exige push e o job `db` verde (HITL a abrir nessa entrega)."
data: 2026-10-23
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "F1-API-05 (packages/contracts/src/{user-criteria,limits}.ts; apps/api/src/application/{ports/criteria-repository.ts,criteria,limits/limit-policy.ts}; apps/api/src/infrastructure/{supabase,persistence}; apps/api/src/presentation/{edge/cors.ts,routes,build-app.ts}; apps/api/src/composition; apps/api/test/db)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-007-api-edge](ADR-007-api-edge.md)", "[ADR-010-log-allowlist-and-telemetry](ADR-010-log-allowlist-and-telemetry.md)", "[ADR-013-jwt-verification](ADR-013-jwt-verification.md)", "[ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md)", "[ADR-017-analyze-job-and-stream](ADR-017-analyze-job-and-stream.md)", "[ADR-018-postgres-schema-rls-and-criteria](ADR-018-postgres-schema-rls-and-criteria.md)", "[ADR-019-ci-github-actions](ADR-019-ci-github-actions.md)", "[threat-model](../threat-model.md)", "[contratos-zod](../contratos-zod.md)", "*BACKLOG §F1-API-05*"]
---

# ADR-021: `GET` e `PUT /v1/criteria`

## 1. Contexto

O banco já existe no projeto real (HITL-023), com a tabela `user_criteria`, a RLS forçada e o `grant` de `select`, `insert` e `update` a `authenticated` ([ADR-018-postgres-schema-rls-and-criteria](ADR-018-postgres-schema-rls-and-criteria.md) D2 e D3). A leitura também existe: o `SupabaseCriteriaRepository.load` dentro do `CriteriaGuard`, usado pelo `preHandler` do `POST /v1/analyze`. Falta o caminho do portal para **gravar** e **ler** os critérios. Sem ele, a única forma de configurar critérios é escrever direto no PostgREST, e toda análise real responde 409.

Restrições herdadas:
- **Contrato (`user-criteria.ts`):** o `UserCriteriaSchema` é `strictObject`, não tem `userId` e **nunca vai para a extensão nem para o LLM**. A pretensão é "cifrada em repouso".
- **T16 (BOPLA):** `strictObject` em toda entrada, nenhum schema com `userId` e o banco recebe **colunas explícitas**, nunca `insert(body)`.
- **SR-15:** a RLS é a **segunda** barreira; a primeira é o `sub` verificado. O cliente de usuário usa a *publishable* e o JWT do dono, e recusa a *secret* (ADR-018 D5).
- **ADR-018 D4:** AES-256-GCM com AAD por dono, cifrando sempre, inclusive o `null`. Decifragem que falha é 503, nunca 409.
- **ADR-018 §3.2 e §3.3:** a coluna `criteria` não aceita as chaves `salary` e `schemaVersion`, e tem `check (pg_column_size(criteria) <= 16384)`.
- **ADR-007 D6:** o CORS tem uma lista **única** de origens exatas, e hoje ela contém a origem da extensão (para o `/v1/analyze`) e a do portal.

### 1.1 Medida feita para este ADR (2026-10-23, `[ARCHITECT]`)
Um `UserCriteria` com todas as listas no teto, montado e conferido pelo `UserCriteriaSchema` do `dist` dos contratos (script no scratchpad, fora do repositório):

| Caso | Corpo (`JSON.stringify`) | Coluna `criteria` (sem `salary` e `schemaVersion`) |
|---|---|---|
| Texto latino (tags ASCII de 40, cidades de 80, notas de 4 bytes; com notas em `Ã`, 6.328 no corpo) | 7.228 bytes | 7.093 bytes |
| Caracteres de 4 bytes (`\p{L}` astral nas tags, cidades e notas) | **16.828 bytes** | **16.693 bytes** |
| O caso de 4 bytes, todo escapado em `\uXXXX` | 46.028 bytes | — |

**Achado:** um perfil **válido pelo contrato** passa do `check` de 16.384 da coluna (a sobra do `jsonb` sem compressão só aumenta o número). O PUT desse perfil seria recusado pelo banco e viraria um 503 permanente, sem o usuário saber por quê. O D3 fecha a lacuna sem migration.

## 2. Decisões

### D1. Partição em commits atômicos (AGENTS §4.1)
| # | Commit | Camada | Depende de |
|---|---|---|---|
| **1** | Teto de bytes no `UserCriteriaSchema` e `CRITERIA_BODY_MAX_BYTES` (D3) | `@trampo/contracts` | nada |
| **2** | Porta `CriteriaRepository.save` e `CriteriaGuard.save` (D5), com o *fake* | `application` | 1 |
| **3** | `PostgrestUserClient.upsert` e `SupabaseCriteriaRepository.save` (D5 e D6) | `infrastructure` | 2 |
| **4** | CORS por rota (D8.3, emenda ao ADR-007 D6) e a classe `criterios` (D8.2, emenda ao ADR-014 D4) | `presentation/edge` e `application/limits` | nada |
| **5** | Rotas `GET` e `PUT /v1/criteria`, a opção `criteria` do `buildApp` e a ligação no `composeApp` | `presentation` e `composition` | 3 e 4 |
| **6** | `test:db`: escrita pelo adapter real com a RLS real, pior caso de tamanho e concorrência (D10) | `apps/api/test/db` | 5; fecha só com o job `db` verde (push) |

Cada commit fecha com testes, 100% de cobertura nos arquivos tocados, mutação e o `[APPSEC]` do §3. Nenhum commit liga uma escrita sem o guarda.

### D2. As rotas
| | `GET /v1/criteria` | `PUT /v1/criteria` |
|---|---|---|
| Corpo da requisição | nenhum | `UserCriteriaSchema` inteiro (substituição completa) |
| Sucesso | **200** com o `UserCriteria`, validado na saída pelo `serializerCompiler` | **204**, sem corpo |
| Não configurado | **409 `CRITERIOS_NAO_CONFIGURADOS`** (o status do catálogo) | — (o PUT cria) |
| Banco fora do ar, prazo, decifragem que falha, resposta fora do contrato | **503 `SERVICO_INDISPONIVEL`** | **503 `SERVICO_INDISPONIVEL`** |
| Corpo inválido, chave a mais (inclusive `userId`), `schemaVersion` ≠ 1 | — | **400 `PAYLOAD_INVALIDO`**, sem as *issues* do Zod |
| Corpo acima de 16 KiB | — | **413 `PAYLOAD_GRANDE_DEMAIS`**, sem parse |
| Classe de rate limit | `padrao` (60/120) | `criterios` (10/30), D8.2 |
| Cota diária | não | não (nenhuma rota de critérios chama LLM) |

- **Cabeçalhos:** `Cache-Control: no-store` nas duas rotas, em sucesso e em erro. A resposta do GET tem a pretensão em claro, e nenhum cache intermediário ou do navegador pode guardá-la.
- **Sem `DELETE`:** a tabela não tem `grant` de `delete`. Os critérios somem só com a conta (*cascade*, F1-PORTAL-03).
- **409 no GET, e não 404:** o código `CRITERIOS_NAO_CONFIGURADOS` já existe e já leva 409 no catálogo. Um status por rota criaria uma segunda fonte de verdade. O portal decide pelo `code`, não pelo status.
- **PUT com a linha que não abre (chave perdida):** o PUT **não lê** a linha antiga. Ele grava o documento inteiro, cifrado com a chave ativa. Isso é o caminho de recuperação consciente: o usuário mandou critérios completos. O GET dessa linha continua 503, então o portal nunca mostra um formulário vazio como se fosse "não configurado" (a regra do ADR-018 D4 continua de pé).

### D3. Teto de tamanho coerente do contrato ao banco
- **Contrato (commit 1):** `USER_CRITERIA_MAX_JSON_BYTES = 12_288` em `limits.ts`, e um `refine` no `UserCriteriaSchema`: `new TextEncoder().encode(JSON.stringify(valor)).length` **≤ 12.288**, com o erro `criterios_grandes_demais`. É `TextEncoder`, e não `Buffer`, para o mesmo schema rodar no portal e na API. A medida é sobre o valor já parseado (depois do `trim`).
  - **Por que 12 KiB:** o pior caso latino tem 7,2 KB, então nenhum perfil real chega perto. O `jsonb` acrescenta cabeçalhos por elemento (da ordem de 4 bytes por item, ~1 KB no pior caso de ~250 itens), e 12 KiB de JSON ficam abaixo do `check` de 16 KiB com folga. A prova não é a conta: é o teste do D10 no Postgres real.
  - **Alternativa recusada:** subir o `check` do banco por migration. Exigiria um HITL para aplicar no projeto real, e o teto continuaria ausente no contrato que o portal usa para validar o formulário.
  - O `refine` vale também na **leitura**. Uma linha acima do teto (só possível escrevendo direto no PostgREST, um risco já aceito no ADR-018 §3) dá 503, falha fechado.
- **Borda (commit 5):** `CRITERIA_BODY_MAX_BYTES = 16_384` como `bodyLimit` **da rota** PUT, abaixo dos 64 KiB globais (ADR-007). Ele cobre os 12 KiB do contrato mais espaços e quebras de linha de um JSON formatado. Um cliente que escape todo caractere não ASCII em `\uXXXX` pode receber 413 com um perfil válido; o portal usa `JSON.stringify`, que não escapa.
- **Cliente PostgREST (commit 3):** o corpo serializado do `upsert` tem teto de 32 KiB (o mesmo da leitura). Acima disso, `{ ok: false }` sem enviar nada.

### D4. O dono vem só do token (T16, SR-15 primeira barreira)
- O `userId` é sempre o `principal.userId` do JWT verificado (ADR-013). O corpo não tem campo de dono: `strictObject` recusa `userId`, `user_id` e qualquer chave a mais com 400. A rota não tem parâmetro de caminho nem de *query*. Uma *query string* enviada é ignorada.
- O token é o mesmo `bearerToken` que o hook de autenticação já verificou nesta requisição, relido como no `preHandler` do ADR-018 D6. Ele vai ao PostgREST para a RLS valer e não é guardado.
- **Colunas explícitas:** o adapter monta a linha como um literal com exatamente `user_id`, `schema_version`, `criteria`, `salary_ciphertext` e `updated_at`, e a URL leva `columns=` com a mesma lista. Um campo que escapasse do Zod não chega a coluna nenhuma.

### D5. Escrita: porta, guarda e adapter
**Porta (commit 2)**, em `application/ports/criteria-repository.ts`:
```ts
type CriteriaSave = { readonly saved: true } | { readonly saved: false; readonly unavailable: true };
interface CriteriaRepository {
  load(subject: CriteriaSubject, signal?: AbortSignal): Promise<CriteriaLookup>;
  /** Substitui os critérios do dono. Nunca rejeita: qualquer falha é `unavailable`. */
  save(subject: CriteriaSubject, criteria: UserCriteria, signal?: AbortSignal): Promise<CriteriaSave>;
}
```
**Sem caso de uso próprio:** o ADR-018 D5 previa um `UpdateCriteria`, mas ele só repassaria a chamada. O `CriteriaGuard` já é a camada de aplicação da escrita.

**`CriteriaGuard.save` (commit 2)**, no mesmo molde do `load`:
1. Confere o sujeito (UUID e JWS compacto de até 8.192). Fora disso, `unavailable` sem chamar a porta.
2. **Revalida os critérios** com o `UserCriteriaSchema` e passa ao adapter o valor **reparseado**, nunca o objeto da rota.
3. `withDeadline` com o `Clock` injetado e o mesmo `CRITERIA_GUARD_POLICY.timeoutMs` (1.000 ms). O sinal aborta a chamada perdedora.
4. Confere a forma da resposta com um schema estrito. Exceção, rejeição, demora ou forma errada viram `{ saved: false, unavailable: true }`. Nunca rejeita.

**`PostgrestUserClient.upsert` (commit 3)**, no cliente que já existe:
- `POST /rest/v1/user_criteria?on_conflict=user_id&columns=user_id,schema_version,criteria,salary_ciphertext,updated_at`, com `apikey` (publishable), `Authorization: Bearer <token do dono>`, `content-type: application/json` e `Prefer: resolution=merge-duplicates,return=minimal`.
- O tipo `PostgrestTable` continua fechado (`"user_criteria"`), e a lista de colunas é um parâmetro tipado, não texto livre.
- Mesmas regras da leitura: `redirect: "error"`, prazo próprio de 900 ms combinado com o sinal do guarda, token conferido antes de virar cabeçalho, e teto de 32 KiB no corpo enviado.
- **Sucesso:** só o status que o `test:db` fixar contra o PostgREST real (hipótese: **201**, o documentado para o *upsert* com `return=minimal`). O corpo é cancelado sem ler.
  - **Emenda (commit 6, §5.6):** a hipótese estava errada. O PostgREST 16.4 responde **201 na inserção e 200 na atualização** da linha em conflito. O cliente aceita os dois (`upsertSuccessStatuses`), e nenhum outro.
- **Qualquer outro status** (401, 403 da RLS, 409 de *constraint*, 413, 5xx) ou exceção → `{ ok: false }`. **O corpo de erro nunca é lido:** o erro de `check` do Postgres traz, no `details`, a linha recusada inteira (`Failing row contains (...)`), ou seja, os critérios do usuário.

**`SupabaseCriteriaRepository.save` (commit 3):**
1. `cipher.seal(userId, criteria.salary)`. A `SalarySealError` é capturada e vira `unavailable`.
2. Monta a coluna `criteria` = o `UserCriteria` **sem** `salary` e **sem** `schemaVersion`, as duas chaves que o banco e a leitura recusam.
3. `updated_at` = o `now()` injetado, em ISO 8601. No ramo de *update* do *upsert*, o `default now()` não roda, e o valor da API é quem renova a coluna (ela é informativa: nada decide por ela, ADR-018 §3.3).
4. `client.upsert(...)` → `{ saved: true }` ou `unavailable`.

### D6. A pretensão cifrada antes de sair da API e nunca devolvida de outro jeito
- **Na ida ao banco:** a pretensão sai do processo **só** dentro do envelope `s1` do `SalaryCipher`, com o AAD do dono. O corpo enviado ao PostgREST não tem a chave `salary` nem o valor em claro (prova por canário no corpo cru capturado pelo PostgREST simulado, D10).
- **Na volta ao cliente:** o **PUT não devolve nada** (204). A pretensão em claro só sai pelo **GET**, e o GET sempre a lê do banco e a decifra pelo mesmo `load` que a análise usa. A API nunca ecoa a pretensão que recebeu, nem em sucesso, nem em erro, nem em log.
- **Cifra sempre**, inclusive `salary: null` (ADR-018 D2): o tamanho do envelope não revela se há pretensão além do que o GCM já revela (o comprimento do texto claro, de 4 bytes para `null` até ~250 para o pior caso). Esse resíduo já era aceito no ADR-018.

### D7. Idempotência e concorrência
- **Idempotência:** o PUT é substituição completa, então repetir o mesmo corpo leva ao mesmo estado decifrado. O envelope muda a cada gravação (IV aleatório), mas nada depende do cifrado. **Sem `Idempotency-Key`:** um *retry* de rede depois de um 503 ou de uma conexão cortada é seguro por construção. Isso cobre o resultado ambíguo de um prazo estourado depois do *commit* no banco.
- **Atomicidade:** **um único** `INSERT ... ON CONFLICT (user_id) DO UPDATE` por gravação. A linha nunca fica com os critérios de uma gravação e o cifrado de outra, nem existe janela entre "lê se existe" e "insere". Duas inserções simultâneas da mesma conta não dão erro de chave duplicada.
- **Concorrência entre abas: última gravação vence (*last-write-wins*).** Sem coluna de versão nem `If-Match` na Fase 1:
  - o dono é a única pessoa que escreve na linha, e a Fase 1 é de uso pessoal (ADR-014 D6);
  - controle otimista exigiria uma migration (coluna `revision`), um HITL para aplicá-la, um código novo de erro no contrato (412 ou 428) e o fluxo de conflito no portal;
  - a perda possível é a de uma edição feita numa aba velha, recuperável editando de novo. Não há ganho de privilégio nem dado de outra pessoa.
  - **Gatilho para rever:** edição em mais de um dispositivo ou um portal com salvamento automático. Aí entra `revision bigint` com `If-Match`, num ADR próprio.
- **`schemaVersion`:** o PUT aceita só a versão 1 (literal do contrato). Uma versão 2 exige migration da coluna `schema_version` e da leitura, fora deste item.

### D8. Borda
**D8.1 Ordem (da rejeição mais barata à mais cara):**
1. hooks globais: CORS (com a regra do D8.3), tipo de mídia, JWT e rate limit da classe da rota. Sem token → 401 sem ler o corpo;
2. PUT: `bodyLimit` de 16 KiB (413 sem parse) e o `UserCriteriaSchema` (400);
3. handler: `CriteriaGuard.load` (GET) ou `CriteriaGuard.save` (PUT).

**D8.2 Classe de rate limit `criterios` (emenda ao ADR-014 D4):** 10 por minuto por usuário e 30 por IP, só no PUT. O portal grava ao clicar em "salvar", e 10 por minuto sobra para isso. Cada PUT é uma escrita no banco, e uma inundação com um token válido custaria escrita (e cifragem) por requisição. O GET fica na `padrao`, porque é uma leitura por chave primária. A classe mais estrita continua sendo a `analise` (5), e valor desconhecido continua caindo nela.

**D8.3 CORS por rota: a origem da extensão só alcança `POST /v1/analyze` (emenda ao ADR-007 D6).**
- O contrato diz que os critérios **nunca vão para a extensão**, mas hoje a lista de origens é única: a extensão, que já tem o token do usuário, conseguiria `GET /v1/criteria` e leria a pretensão em claro no Service Worker.
- **Regra:** uma origem `chrome-extension://` (o padrão `EXTENSION_ORIGIN` do `edge-env`) é aceita **só** nas rotas de uma lista positiva, `EXTENSION_ROUTES = [{ method: "POST", path: "/v1/analyze" }]`. Comparação exata do caminho cru antes do `?`, sem normalizar: `%61`, barra dupla, barra final ou `..` caem fora da lista e dão **403 `PROIBIDO`**. Isso vale no *preflight* (pelo `Access-Control-Request-Method`) e na requisição real (pelo método). As outras origens da lista (o portal) não mudam.
- **Por que não basta o navegador:** a recusa é do servidor, como o resto do ADR-007 D6. O Chrome sempre põe o `Origin` nas requisições do Service Worker da extensão, e a extensão não pode removê-lo nem trocá-lo (cabeçalho proibido; o `declarativeNetRequest` exigiria uma permissão que o manifesto não tem, SR-02).
- O F1-API-06 acrescenta a rota de feedback à lista, se o botão ficar no Side Panel.
- **Resíduo:** um cliente fora do navegador com o token (um `curl`) lê os critérios. É o próprio dono, com o próprio token. A regra existe para que uma extensão comprometida, ou um bug nela, não leia a pretensão.
- **Emenda do [ADR-004-extension-auth](ADR-004-extension-auth.md) D8 item 2 (F1-API-07 07g, 2026-11-07, `b516fd0`):** a lista positiva passou a ter as 3 rotas do BFF (`/v1/auth/exchange`, `/v1/auth/refresh` e `/v1/auth/logout`, todas POST). Essas 3 são só da extensão (`EXTENSION_ONLY_ROUTES`: 403 à origem de web). As rotas de critérios continuam fora do alcance da extensão.

### D9. Logs e telemetria (SR-12)
- **Nenhum evento novo de telemetria.** A gravação de critérios não tem métrica de produto que justifique um evento, e todo campo possível derivaria do perfil. O log de resposta do Fastify (rota da lista fechada, status e duração) basta para operar.
- **Catálogo do log (emenda ao ADR-010 D2):** `criterios_gravacao_indisponivel` (nível `warn`, sem campos), no PUT que vira 503. O GET reusa o `criterios_indisponiveis` que já existe.
- O 400 de validação não loga nada (o mapeador de erro do `buildApp` só loga o `ERRO_INTERNO`). Uma falha do `serializerCompiler` na saída do GET vira 500 `ERRO_INTERNO`, e o log leva só o tipo do erro pela lista fechada, nunca as *issues* do Zod, que podem conter valores do perfil.
- Nada de `sub`, token, critérios, notas, cidades, tecnologias, pretensão ou cifrado vai para log, mensagem de erro ou telemetria.

### D10. Testes (aceite de cada commit)
- **Commit 1:** o pior caso de 4 bytes do §1.1 é recusado com `criterios_grandes_demais`; o pior caso latino passa; as bordas 12.288 (passa) e 12.289 (recusa) com um perfil montado para o byte exato; o `refine` roda no portal (sem `Buffer`, só `TextEncoder`).
- **Commit 2:** o guarda com porta travada (`unavailable` em exatamente 1.000 ms no relógio falso, sinal abortado e nenhum timer vazando), porta que rejeita, que lança de forma síncrona e que devolve forma errada; critérios fora do schema ou com chave a mais não chegam à porta; o adapter recebe o objeto reparseado, não o da rota.
- **Commit 3**, contra o PostgREST simulado em socket real:
  - cabeçalhos exatos, `Prefer`, `on_conflict` e `columns` na URL, corpo com exatamente as 5 colunas;
  - **canários:** o valor da pretensão não aparece no corpo cru enviado; a coluna `criteria` não tem `salary` nem `schemaVersion`; o cifrado abre com o AAD do dono e não com o de outro;
  - falha fechado: 401, 403, 409 com corpo que ecoa um canário (o canário não aparece em lugar nenhum), 413, 500, redirecionamento (zero requisições ao 2º host), lento, travado, socket cortado e corpo acima de 32 KiB (não enviado);
  - ida e volta: `save` e depois `load` devolvem critérios iguais, inclusive com `salary: null`.
- **Commit 4:** a origem da extensão passa no `POST /v1/analyze` e recebe 403 em `GET` e `PUT /v1/criteria` (*preflight* e requisição real), em `/v1/analyze/`, `/v1/%61nalyze`, `//v1/analyze` e com outro método; a origem do portal passa em todas; a política fixa `criterios` em 10/30 contra este ADR.
- **Commit 5:** ordem de defesa (sem token 401 sem ler o corpo; 17 KiB → 413 sem parse; rate limit antes do corpo; `userId` no corpo → 400 e nada gravado); GET 200 com `no-store` e o corpo igual ao gravado; GET 409 e 503 (linha de outro dono, chave perdida); PUT 204 sem corpo e 503 sem eco; **SR-12** com canários nas notas, cidades, tecnologias, pretensão e token, com o log capturado nos caminhos 200, 204, 400, 413, 429 e 503; e o boot do `composeApp` montando as duas rotas com o mesmo guarda da análise.
- **Commit 6 (`test:db`, no job `db` do CI):**
  - **SR-15 da escrita:** A grava pelo adapter real; o cliente de A, chamado direto com `user_id` de B (furando a primeira barreira de propósito), é recusado pela RLS na inserção e na sobrescrita da linha de B, e a linha de B continua intacta;
  - o *upsert* real fixa o status de sucesso do D5;
  - o perfil válido mais pesado (12.288 bytes de JSON, caracteres de 4 bytes **não compressíveis**) passa no `check` de 16 KiB do banco real;
  - duas gravações concorrentes do mesmo dono terminam em um dos dois documentos inteiros, nunca numa mistura;
  - `anon` continua sem acesso (herdado).

## 3. Auditoria `[APPSEC]` (antes do código)
**Sem veto.** O desenho cumpre o SR-15, o T16 e as regras do AGENTS §1.3. Critérios de aceite, todos com teste nomeado no D10:

| # | Requisito | Critério de aceite |
|---|---|---|
| 1 | **T16 (BOPLA)** | `userId`, `user_id` ou qualquer chave a mais no corpo → 400 sem escrita; dono só do `principal`; colunas explícitas no literal e em `columns=` |
| 2 | **SR-15 (escrita)** | A primeira barreira (o `sub` no `user_id`) e a segunda (a RLS) provadas em separado: o `test:db` fura a primeira de propósito e a RLS recusa |
| 3 | **Pretensão fora da memória da API só cifrada** | Canário do valor ausente do corpo cru enviado ao PostgREST; coluna `criteria` sem `salary`; AAD do dono |
| 4 | **Pretensão em claro só pelo GET** | PUT 204 sem corpo; nenhum erro ecoa valor; GET com `no-store`, lido e decifrado pelo mesmo `load` da análise |
| 5 | **Critérios nunca na extensão** | Origem `chrome-extension://` → 403 em toda rota fora da lista positiva, no *preflight* e na requisição real, inclusive com caminho disfarçado |
| 6 | **Falha fechado** | Guarda com prazo e revalidação nos dois sentidos; PostgREST com qualquer desvio → 503; corpo de erro nunca lido (o `details` do Postgres ecoa a linha) |
| 7 | **SR-12** | Canários das notas, cidades, tecnologias, pretensão e token ausentes do log nos caminhos 200, 204, 400, 413, 429 e 503; nenhum evento de telemetria novo |
| 8 | **Ordem de defesa e *Denial of Wallet*** | Sem token, nada lê o corpo, o Redis ou o banco; 413 antes do parse; rate limit antes do corpo |
| 9 | **Tamanho coerente** | O contrato recusa o que o banco recusaria; prova no Postgres real com o pior caso não compressível |
| 10 | **Sem segredo novo e sem dependência nova** | Só a *publishable*; nenhuma variável nova no `.env.example`; nenhum pacote novo |

**Riscos residuais aceitos:**
- **Última gravação vence (D7):** uma aba velha pode desfazer uma edição recente do próprio dono. Sem ganho de privilégio; o gatilho para rever está no D7.
- **Resultado ambíguo:** um 503 por prazo pode chegar depois de o banco ter gravado. O PUT é idempotente, e o portal pode repetir ou reler.
- **O dono ainda pode gravar direto no PostgREST**, sem o Zod e sem o teto de 12 KiB (já aceito no ADR-018 §3). Só prejudica a si mesmo: a leitura revalida e responde 503, e o PUT seguinte pela API conserta a linha.
- **Comprimento do texto claro visível no envelope** (D6), herdado do ADR-018.
- **Cliente fora do navegador com o token lê os critérios** (D8.3): é o próprio dono.

## 4. Consequências
- **Contrato:** o `UserCriteriaSchema` ganha o teto de bytes (D3). Nenhum dado gravado é afetado: o caminho da API ainda não gravou nenhuma linha.
- **Emendas:** ADR-007 D6 (CORS por rota), ADR-010 D2 (`criterios_gravacao_indisponivel`), ADR-014 D4 (classe `criterios`) e ADR-018 D5 (sem `UpdateCriteria`; o guarda é a aplicação da escrita).
- **`buildApp`:** ganha a opção `criteria?: { repository: CriteriaRepository }`. Sem ela, as rotas não existem (404 `PROIBIDO`, como hoje). O `composeApp` passa o **mesmo** `CriteriaGuard` que já entrega à análise.
- **HITL:** nenhum para codar os commits 1 a 5. O commit 6 só fecha com push e o job `db` verde; o HITL de push abre nessa entrega.
- **Ponta a ponta de verdade** (o portal gravando no projeto real) espera o F1-PORTAL-01 (login) e o F1-PORTAL-02 (formulário).

## 5. Implementação

### 5.1 Commit 1: teto de bytes no contrato (2026-10-23)
Código:
- `packages/contracts/src/limits.ts`: `USER_CRITERIA_MAX_JSON_BYTES = 12_288` e `CRITERIA_BODY_MAX_BYTES = 16_384`;
- `packages/contracts/src/user-criteria.ts`: `userCriteriaJsonBytes(valor)` (`TextEncoder` sobre o `JSON.stringify`) e o `refine` do `UserCriteriaSchema`, com o erro `criterios_grandes_demais`.

Refinamentos do desenho, sem mudar decisão:
- **`userCriteriaJsonBytes` exportado:** o portal pode mostrar quanto falta para o teto, e os testes da API medem com a mesma função do contrato.
- **O `refine` não embrulha o schema** (zod 4): o `UserCriteriaSchema.shape` continua acessível, provado por teste.
- **Correção da tabela do §1.1:** o caso "latino" medido tinha as notas com caracteres de 4 bytes. Com notas em `Ã`, o corpo tem 6.328 bytes. Os dois números estão fixados nos testes, e nenhuma decisão muda.
- **O fixture `criteria()` dos testes da API passa pelo `parse`**, então ele próprio recusa um perfil acima do teto. O teste do espelho monta o valor por fora dele.

Verificação:
- **10 testes novos:**
  - 9 em `packages/contracts/test/user-criteria-size.test.ts`: as constantes; a contagem em bytes UTF-8; o pior caso de 4 bytes (16.828) recusado **só** pelo teto; o latino (7.228, e 6.328 com `Ã`) aceito; as bordas 12.288 e 12.289 no byte exato; os espaços que o `trim` remove não contam; o perfil no teto cabe nos 16 KiB mesmo formatado com recuo; entrada cíclica ou com `BigInt` recusada sem o teto lançar; e o `.shape` preservado;
  - 1 em `apps/api/test/infrastructure/postgrest-criteria-repository.test.ts`: a linha acima do teto, gravada direto no PostgREST simulado, dá `unavailable` (503), e o schema a recusa só pelo teto.
- Contratos com 91 testes e 100% (14/14 ramos). API com 2.370 testes e 100%. Turbo 16/16 de build, typecheck e lint e 7/7 de teste, em série. Depcruise sem violações (377 módulos).
- **Mutação:** 9 mutantes, 9 mortos. O script ficou no scratchpad, rodou um mutante por vez e conferiu o sha256 dos originais depois de cada um. Os mutantes:
  - o `refine` sempre verdadeiro;
  - `<` e `>=` no lugar de `<=`;
  - o teto em 12.289 e o `bodyLimit` em 16.383;
  - code units no lugar de bytes;
  - o tamanho medido com 1 byte a mais e com 1 byte a menos;
  - a mensagem do erro.

**Auditoria `[APPSEC]` do código: sem veto.** O critério 9 do §3 está cumprido no contrato: o pior caso que o banco recusaria é recusado antes, com um código de erro estável. O mesmo teto vale na leitura, que falha fechado. A metade "banco real" do critério 9 é do commit 6 (`test:db`). Nada novo entra em log, e o erro do Zod leva só o código `criterios_grandes_demais`, sem valor do perfil.

### 5.2 Commit 2: porta `save` e `CriteriaGuard.save` (2026-10-23)
Código:
- `application/ports/criteria-repository.ts`: `CriteriaSave`, `CriteriaReader` (`load`), `CriteriaWriter` (`save`) e `CriteriaRepository extends CriteriaReader, CriteriaWriter`;
- `application/criteria/criteria-guard.ts`: `CriteriaGuard<P extends CriteriaReader = CriteriaRepository>` e o `save`;
- `test/application/fakes/fake-criteria-repository.ts`: o `save`, que grava no mapa e registra `saves` e `tokens`.

**Decisão: a porta é partida em leitura e escrita.** Pôr o `save` direto na interface única obrigaria o `SupabaseCriteriaRepository` a implementá-lo já neste commit, e o adapter é do commit 3. Um stub no adapter seria código morto num caminho de escrita. Foram consideradas três formas:
- **(escolhida) `CriteriaReader` e `CriteriaWriter`, com `CriteriaRepository` como a união.** O adapter declara `CriteriaReader` até o commit 3, que o alarga para `CriteriaRepository`. É também privilégio mínimo: a rota de análise (`AnalysisRouteOptions.criteria` e o `preHandler`) passa a pedir só `CriteriaReader`, e quem só lê não recebe uma porta que grava.
- Um guarda de escrita separado (`CriteriaWriteGuard`): recusado. Duplicaria a conferência do sujeito e o prazo, e o D5 e o `composeApp` do commit 5 contam com **um** guarda para as duas rotas.
- Um `save` opcional na porta: recusado. Viraria um ramo "sem escrita" no guarda, testado só por existir.

**Como o guarda atravessa a transição:** o `CriteriaGuard` é genérico na porta embrulhada, com `CriteriaRepository` como padrão, e o `save` declara `this: CriteriaGuard<CriteriaRepository>`. Sobre uma porta só de leitura (o `composeApp` de hoje), chamar `save` **não compila**. Isso está provado com `@ts-expect-error`, e o mesmo teste mostra que, furado o tipo, a chamada falha fechado em `unavailable` (o `withDeadline` captura o `TypeError`). Quando o commit 3 alargar o tipo do adapter, o `composeApp` passa a ter o `save` sem mudar uma linha, e o `CriteriaGuard<CriteriaRepository>` é um `CriteriaWriter` estrutural.

Refinamentos do desenho, sem mudar decisão:
- **Resposta estrita só para o sucesso:** `z.strictObject({ saved: z.literal(true) })`. Qualquer outra resposta, inclusive a falha declarada (`{ saved: false, unavailable: true }`), vira o `unavailable` canônico. O resultado é o mesmo de um schema de união, com um ramo a menos para errar.
- **Ordem no `save`:** sujeito → critérios → porta. As duas conferências são síncronas e não chamam a porta nem armam o prazo.
- O `signal` de quem chama não entra (como no `load`): o prazo e o aborto são do guarda.

Verificação:
- **43 testes novos:**
  - 42 em `test/application/criteria-guard.test.ts` (eram 37, agora 79):
    - sucesso canônico com o sujeito copiado;
    - o adapter recebe o objeto **reparseado** (as notas e a cidade com espaços chegam aparadas, e o objeto e a `stack` não são os de quem chama);
    - a gravação 1 ms antes do prazo vale;
    - o tipo (`@ts-expect-error`) e a falha fechada do guarda só de leitura;
    - a porta que lança de forma síncrona, que rejeita e que rejeita depois do prazo;
    - a porta travada (`unavailable` em exatamente 1.000 ms, sinal abortado e nenhum timer pendente);
    - a gravação no prazo exato perde; o prazo injetado; o timer abortado quando a porta responde antes;
    - 12 formas erradas de resposta;
    - 11 critérios recusados sem chamar a porta: `schemaVersion` 2, `userId` e `user_id` no corpo, chave a mais aninhada, enum inválido, pretensão negativa, nota com URL, chave ausente, **acima do teto de bytes** (recusado só pelo teto), nulo e texto JSON;
    - 6 sujeitos inválidos; o token no teto exato passa;
  - 1 no `FakeCriteriaRepository`: gravação, leitura de volta e o banco fora do ar sem gravar.
- API com 2.413 testes e 100% (2.896 instruções, 1.881 ramos). Turbo 16/16 de build, typecheck e lint e 7/7 de teste, em série. Depcruise sem violações (377 módulos).
- **Mutação:** 14 mutantes, 14 mortos. O script ficou no scratchpad, rodou um mutante por vez e conferiu o sha256 do original depois de cada um. Os mutantes:
  - o adapter recebe o objeto de quem chama;
  - critérios sem revalidação, e critérios inválidos que dão `saved`;
  - sujeito inválido que dá `saved`, sujeito sem conferência e o sujeito original passado à porta;
  - o sinal não repassado;
  - resposta não conferida, schema não estrito, `saved` como `boolean` e sucesso recusado;
  - o fallback do prazo como `saved`, o prazo injetado ignorado e o `save` sem prazo.
- **Intermitência conhecida:** 1 rodada em 8 da suíte da API falhou logo depois da mutação, com a CPU disputada, e não se repetiu nas outras 7. O padrão é o dos testes de relógio do SR-09 já registrados no SESSION-LOG. Nenhum teste novo depende de tempo real: todos usam o `FakeClock`.

**Auditoria `[APPSEC]` do código: sem veto.** O critério 6 do §3 está cumprido na camada de aplicação: o guarda tem prazo e revalida nos dois sentidos. Na ida, os critérios são reparseados, e um `userId`, um `user_id` ou qualquer chave a mais nunca chega à porta (metade do critério 1, T16). Na volta, só o sucesso estrito conta. Também ganha privilégio mínimo: a rota de análise deixa de receber uma porta que grava. Nada entra em log, e o guarda não guarda o token nem os critérios. O SR-15 e a cifra ficam com os commits 3 e 6.

### 5.3 Commit 3: `PostgrestUserClient.upsert` e `SupabaseCriteriaRepository.save` (2026-10-24)
Código:
- `infrastructure/supabase/postgrest-user-client.ts`:
  - `upsert(table, { columns, onConflict, row }, token, signal)`;
  - `PostgrestWritableColumns` (as colunas graváveis por tabela) e `PostgrestWrite`;
  - na política, `maxRequestBytes` (32.768) e `upsertSuccessStatus` (201).
- `infrastructure/persistence/supabase-criteria-repository.ts`: `USER_CRITERIA_COLUMNS`, o `save` e a dependência `now`. O adapter passa de `CriteriaReader` para `CriteriaRepository` (§5.2).
- `composition/compose-app.ts`: o mesmo `now` dos limites vai ao adapter. O guarda da análise passa a ser um `CriteriaGuard<CriteriaRepository>` sem nenhuma outra mudança.
- `test/infrastructure/fakes/fake-postgrest.ts`:
  - o *upsert*: guarda só as colunas de `columns=`, aplica a RLS de escrita (403 para a linha de outro dono) e substitui a linha em conflito por `user_id`, respondendo 201 sem corpo;
  - o corpo cru, o `content-type` e o `Prefer` de cada requisição ficam registrados;
  - dois modos novos: `corta` (socket destruído) e `sem_fim` (cabeçalho e corpo que nunca termina).

Refinamentos do desenho, sem mudar decisão:
- **O corpo é montado a partir de `columns`, não do `row`.** O cliente serializa `Object.fromEntries(columns.map(...))`. Uma chave que chegasse ao `row` em tempo de execução (um `salary` ou um `role`) não vai ao fio, e a lista da URL e a do corpo são a mesma por construção. Isso é o D4 ("colunas explícitas") reforçado no cliente, além do literal no adapter.
- **O corpo da resposta nunca é lido, e há prova disso:** o modo `sem_fim` responde com um corpo que não termina. Com um prazo de 10 s, o cliente devolve em menos de 2 s, tanto no 409 quanto no 201. Quem lesse o corpo ficaria preso até o prazo.
- **O teto de 32 KiB conta bytes UTF-8.** Um corpo de emojis que cabe em *code units* e não em bytes não é enviado.
- **`now` obrigatório no adapter**, como nos limites, e não um `Date.now` implícito. O próximo passo dizia "o `composeApp` ganha o `save` sem mudar". A única mudança foi passar o `now`, que já existia, e subir a declaração dele para antes dos critérios.
- **O caso "corpo acima de 32 KiB" do D10 é provado no cliente.** Pelo adapter ele não é alcançável: o contrato limita os critérios a 12 KiB, e o envelope tem algumas centenas de bytes. O teste está no cliente, no byte exato (32.768 sai, 32.769 não).
- **A vírgula de `columns=` sai codificada (`%2C`)** pelo `URLSearchParams`, como o `select` da leitura, que já roda contra o PostgREST real. O commit 6 confirma a escrita do mesmo jeito.
- A `SalarySealError` e um relógio inválido (`toISOString` de `NaN`) são capturados juntos, antes de qualquer envio. A porta nunca rejeita.

Verificação:
- **59 testes novos:**
  - no cliente:
    - protocolo: URL, método, `on_conflict` e `columns`, cabeçalhos exatos e corpo só com as colunas, mesmo com canário e `role` no `row`;
    - nenhum token na URL, e um token por chamada;
    - token fora da forma (inclusive com CRLF) sem requisição;
    - teto no byte exato e em bytes UTF-8;
    - BigInt e valor cíclico sem envio;
    - 200, 204, 400, 409, 413, 500 e 503 → `{ ok: false }`, e o 409 que ecoa a linha não devolve nada dela;
    - corpo sem fim no erro e no sucesso;
    - publishable errada, sessão desconhecida e RLS de outro dono (a linha fica intacta);
    - lento, socket cortado, sinal do chamador, sinal que nunca aborta, redirecionamento (zero requisições ao 2º host) e servidor fora do ar;
  - no adapter:
    - cabeçalhos e URL do D5, e o corpo com exatamente as 5 colunas na ordem, com o `user_id` do sujeito e o `updated_at` do `now`;
    - **canários:** o valor `31415.92` e as chaves `salary` e `minimum` ausentes do corpo cru; o cifrado abre com o AAD do dono e não com o de outro;
    - `null` cifrado;
    - ida e volta `save` → `load`, com e sem pretensão;
    - a segunda gravação substitui a primeira (uma linha só);
    - a gravação recupera uma linha que não abria (o caminho do D2);
    - o sinal do chamador;
    - o mesmo `CriteriaGuard` grava e lê;
    - `SalarySealError` (dono e pretensão) e relógio inválido sem envio;
    - 401, **a primeira barreira furada de propósito** (o `user_id` de B com o token de A: a RLS do simulado recusa, e a linha de B continua igual e legível por B);
    - o 409 que ecoa o canário, outros status, lento, travado, socket cortado e redirecionamento.
- O cliente ficou com 97 testes e o adapter com 63. A API tem 2.472 testes e 100% (2.928 instruções e 1.891 ramos). Turbo: 16/16 de build, typecheck e lint, e 7/7 de teste em série. Depcruise sem violações.
- **Mutação:** 27 mutantes, 26 mortos e 1 equivalente. O script ficou no scratchpad, rodou um mutante por vez e conferiu o sha256 dos originais depois de cada um. Os mortos:
  - no cliente: o token sem conferência; o corpo com o `row` inteiro; o teto com `<`, em *code units* e sem teto; o valor não serializável que envia; `on_conflict` errado; `columns` fora da URL; `PUT`; `ignore-duplicates`; `return=representation`; sem `content-type`; `redirect: "follow"`; o sinal ignorado; qualquer 2xx como sucesso; e a leitura do corpo da resposta;
  - no adapter: a pretensão em claro; `salary` e `schemaVersion` na coluna; `updated_at` sem o `now`; o `try` removido; `on_conflict` em outra coluna; o sinal não repassado; sempre `saved`; `updated_at` fora das colunas; e a cifra com o AAD de outro dono.
  - **Equivalente:** não cancelar o corpo da resposta. A resposta não muda, e o socket só fica preso até o servidor fechar.
  - Na primeira rodada, o mutante do sinal foi montado errado e não removia o sinal. Ele foi refeito e morreu.
- **Intermitência:** em 2 de 3 rodadas do turbo, 1 teste falhou, cada vez num arquivo diferente (`limits-stack` e `upstash-cache-stack`). Nenhum desses arquivos foi tocado, e os dois usam o prazo de guarda em relógio real contra um servidor simulado. A suíte da API sozinha passou em 4 de 4 rodadas. O padrão é o do QA-01. Os testes novos com espera real usam margens de 2 s sobre prazos de 300 ms.

**Auditoria `[APPSEC]` do código: sem veto.**
- **Critério 1 (T16):** o dono vem só do sujeito. As colunas são explícitas no literal do adapter, na URL (`columns=`) e no corpo, que o cliente monta só com elas.
- **Critério 3:** o valor da pretensão não aparece no corpo cru, a coluna `criteria` não tem `salary` nem `schemaVersion`, e o AAD é do dono.
- **Critério 6 (infraestrutura):** qualquer desvio dá `unavailable`, e o corpo de erro nunca é lido, provado com uma resposta que não termina. Um redirecionamento não leva o token nem os critérios a outro host.
- **SR-12:** nada novo vai para log.
- **Fica para o commit 6:** a metade "banco real" do critério 2 (a RLS do Postgres com a primeira barreira furada) e o status 201 real.

### 5.4 Commit 4: CORS por rota e a classe `criterios` (2026-10-24)
Código:
- `presentation/edge/cors.ts`:
  - `EXTENSION_ROUTES`, congelada (a lista e cada item), só com `{ method: "POST", path: "/v1/analyze" }`;
  - a regra vale no *preflight* (pelo `Access-Control-Request-Method`) e na requisição real (pelo método), sobre o `request.url` cru antes do primeiro `?`.
- `application/ports/rate-limiter.ts`: `RateLimitClass` ganha `criterios`.
- `application/limits/limit-policy.ts`: `criterios: { user: 10, address: 30 }`.
- `application/limits/limit-guards.ts`: o guarda aceita a classe nova.
- `vitest.config.ts`: o `cors.ts` entra no `include` da cobertura. Antes ele ficava de fora, e só os testes de borda o exercitavam.

Refinamentos do desenho, sem mudar decisão:
- **A classificação é pela origem de web, e não pelo padrão da extensão.** Só a origem que **começa** com `https://` ou `http://` fica sem restrição por rota. Toda outra fica presa a `EXTENSION_ROUTES`:
  - a da extensão, pelo `EXTENSION_ORIGIN`;
  - uma forma que chegue ao `buildApp` sem passar pelo `edge-env`, como um `moz-extension://` ou um `chrome-extension://` com `https://` no meio.
  
  Para a lista validada pelo `main.ts`, o resultado é o mesmo. Fora dela, a regra falha fechado.
- **O caminho cru é o `request.url`.** No Fastify 5.12.7, ele é o `raw.url` (conferido no `lib/request.js`). O roteador decodifica `%61` e chegaria à rota de análise, e um teste prova isso com o portal. Por isso, só a comparação crua recusa a extensão.
- **Os caminhos que o `inject` normaliza vão por socket real.** O `light-my-request` resolve `..`, `/./` e `#` antes do hook. Esses casos e a forma absoluta (`POST http://127.0.0.1/v1/analyze`) são escritos à mão na linha de requisição. Um controle prova que o mesmo socket passa no caminho exato.
- **Os cabeçalhos do *preflight* aceito não mudaram** (`GET, POST, PUT`). A recusa é do servidor, por rota. Um `Allow-Methods` por origem seria mais um ramo, sem ganho de segurança.
- **Os testes antigos que usavam a origem da extensão em rotas de sonda** (`/probe/eco`, `/probe/eu`, `/health`) passaram para a rota dela ou para a origem do portal. O que eles provam não mudou.

Verificação:
- **59 testes novos:**
  - 51 em `test/cors-routes.test.ts`:
    - a lista fixada contra o ADR e congelada;
    - a extensão passa no *preflight* e no `POST /v1/analyze` real, inclusive com *query* (`?x=1`, `?` e `?x=?y`), e o 401 que vem depois do CORS ainda traz a origem;
    - 403 antes do JWT, do rate limit, do parser e do handler, com os quatro contadores em zero:
      - no *preflight*: `GET` e `PUT /v1/criteria`, `GET` e `PUT /v1/analyze`, `POST /v1/criteria` e `GET /health`;
      - na requisição real: os mesmos, mais `DELETE`, `PATCH`, `HEAD` e `OPTIONS` sem `Access-Control-Request-Method`;
    - 9 caminhos disfarçados pelo `inject`, no *preflight* e na requisição real: `/v1/analyze/`, `/v1/%61nalyze`, `//v1/analyze`, `/V1/analyze`, `;x`, `%2F`, `/v1/criteria?/v1/analyze`, o prefixo e a rota estendida;
    - 8 alvos em socket real, mais o controle: `/v1/criteria/../analyze`, `/v1/analyze/../analyze`, `/v1/./analyze`, `/./v1/analyze`, `#x`, `//`, `%61` e a forma absoluta;
    - o portal (e o portal em dev) com *preflight* 204 e requisição real até o handler nas três rotas; o `%61` do portal chega à rota de análise;
    - duas origens fora do padrão (falha fechado) e a origem fora da lista, que continua 403;
  - 8 da classe `criterios`:
    - a política 10/30 fixada contra o ADR;
    - a `analise` menor que todas as outras classes nas duas dimensões;
    - `resolveRateLimitClass` com `criterios` e com quatro grafias vizinhas, que caem na mais estrita;
    - o guarda com toda classe da política, e `CRITERIOS` recusado;
    - no Redis simulado: 10 por usuário, 30 por IP e contadores separados dos da `analise`;
    - no hook: a rota com `criterios` conta na classe dela, e o 429 vem antes do corpo.
- A API tem 2.531 testes e 100% de cobertura (2.965 instruções e 1.913 ramos, já com o `cors.ts`). Turbo com 16/16 de build, typecheck e lint e 7/7 de teste, em série. Depcruise sem violações (378 módulos).
- **Mutação:** 27 mutantes, 27 mortos. O script ficou no scratchpad, rodou um mutante por vez e conferiu o sha256 dos originais depois de cada um.
  - No CORS, 20 mutantes:
    - sem restrição;
    - restrição só pelo prefixo `chrome-extension://`;
    - `WEB_ORIGIN` sem âncora;
    - a *query* não removida, o `slice` sempre e o `lastIndexOf`;
    - o caminho decodificado, em minúsculas, sem a barra final e com as barras duplas colapsadas;
    - o método ignorado;
    - o *preflight* sem conferir a rota, e conferindo pelo método do `OPTIONS`;
    - a requisição real sem conferir a rota, e `||` no lugar de `&&`;
    - a rota pelo `routeOptions.url`, já normalizado;
    - a lista e o item não congelados;
    - `GET /v1/criteria` na lista;
    - o `Allow-Origin` posto antes da recusa.
  - No rate limit, 7 mutantes: `criterios` com 11 e com 31, `criterios` igual à `analise`, a mais estrita trocada, o guarda sem a classe, o guarda que troca a classe e o valor desconhecido caindo em `criterios`.
  - O `WEB_ORIGIN` sem âncora sobreviveu na 1ª rodada, porque nenhuma origem de teste tinha `https://` fora do início. Ele virou um teste (`chrome-extension://https://…`) e morreu.

**Auditoria `[APPSEC]` do código: sem veto.**
- **Critério 5 (critérios nunca na extensão):** a origem da extensão recebe 403 em toda rota fora da lista positiva, no *preflight* e na requisição real. Os caminhos disfarçados foram provados pelo `inject` e, onde ele normalizaria, por socket real. A classificação falha fechado para qualquer origem que não comece como de web.
- **Critério 8 (ordem de defesa e *Denial of Wallet*):** o 403 sai no primeiro `onRequest`. Não rodam o verificador de JWT, nenhum comando do Redis, o parser nem o handler, e os testes contam cada um. A classe `criterios` limita a escrita a 10 por minuto por usuário e 30 por IP, antes do corpo (provado com o 429 sem parse).
- **SR-12:** nada novo vai para log. O 403 usa o `sendApiError` que já existia.
- **Critério 10:** nenhuma dependência nova, nenhuma variável nova no `.env.example` e nenhum segredo.
- **Resíduo, sem mudança:** quem tem o token ainda fala com a API fora do navegador (um `curl` com o token copiado). É o próprio dono, e o D8.3 já aceitava esse risco. As rotas de critérios só passam a existir no commit 5, que herda esta regra sem mudar o CORS.

### 5.5 Commit 5: rotas `GET` e `PUT /v1/criteria` e a composição (2026-10-24)
Código:
- `presentation/routes/criteria.ts`: `CRITERIA_ROUTE`, `CriteriaRouteOptions` (`{ repository: CriteriaRepository }`), os dois handlers e o plugin `criteriaRoutes`:
  - GET na classe `padrao`, com `response: { 200: UserCriteriaSchema }` (saída validada pelo `serializerCompiler`);
  - PUT na classe `criterios`, com `bodyLimit: CRITERIA_BODY_MAX_BYTES` e `body: UserCriteriaSchema`;
  - um `onSend` da rota põe `Cache-Control: no-store` em toda resposta das duas.
- `presentation/build-app.ts`: a opção `criteria?`. Sem ela, as rotas não existem (404 `PROIBIDO`).
- `presentation/logging/log-policy.ts`: `criterios_gravacao_indisponivel` no catálogo (emenda ao ADR-010 D2).
- `composition/compose-app.ts`: `criteria: { repository: criteria }`, o **mesmo** `CriteriaGuard` da análise.
- `vitest.config.ts`: o `criteria.ts` entra no `include` da cobertura.

Refinamentos do desenho, sem mudar decisão:
- **`no-store` por `onSend` da rota, e não no handler.** O roteamento acontece antes dos hooks, então o `onSend` da rota roda também nas respostas dos hooks globais (401, 403 do CORS, 415, 429) e do mapeador de erro (400, 413, 500). O `/health` não ganha o cabeçalho, e um teste prova isso.
- **Os handlers repetem a conferência do dono** (principal e bearer na forma). Sem eles, é quebra de invariante e responde 401 sem tocar no banco, como o `preHandler` da análise. Os dois capturam rejeição e exceção da porta (503), mesmo ela sendo um guarda que nunca rejeita.
- **O GET devolve o objeto do guarda**, já reparseado. Uma porta sem guarda que devolva algo fora do contrato cai no `serializerCompiler`: 500 `ERRO_INTERNO`, sem eco no corpo nem no log (provado com canário e `userId` a mais).
- **A classe `padrao` do GET é declarada**, embora seja o padrão. O mutante que a remove é equivalente e fica como documentação da rota.
- **HEAD:** o Fastify expõe `HEAD /v1/criteria` a partir do GET, com as mesmas opções (classe, `onSend`). O corpo não sai, e a origem da extensão já recebe 403 em `HEAD` (commit 4).

Verificação:
- **65 testes novos:**
  - 60 em `test/criteria-route.test.ts`:
    - registro: sem a opção, 404 com token e 401 sem; as classes `padrao` e `criterios`; nenhuma cota diária; o rate limit com o dono do principal;
    - ordem de defesa, com o parser contado: sem token, 401 sem parse, Redis ou banco nas duas rotas; 17 KiB de JSON quebrado dão 413 sem parse; o `bodyLimit` no byte exato (16.384 grava e 16.385 dá 413); 429 antes do corpo (JSON quebrado não vira 400); Redis fora do ar; 415;
    - 9 corpos recusados com 400 e nada gravado, entre eles `userId`, `user_id`, chave aninhada, `schemaVersion` 2 e JSON quebrado, com o corpo exatamente o `ApiError` (sem *issues*); e o perfil acima de 12 KiB e abaixo de 16 KiB, recusado só pelo teto do contrato;
    - GET: 200 com `no-store` e o corpo igual ao gravado pelo PUT; a *query* (`userId`, `user_id`) ignorada; linha de outro dono dá 409; banco fora do ar dá 503 com só `criterios_indisponiveis`; porta que rejeita ou lança; log que lança; saída fora do contrato;
    - PUT: 204 sem corpo e sem `content-type`, com o dono do principal, o token verificado e o valor aparado; idempotência; 503 sem eco e só `criterios_gravacao_indisponivel`, sem campos; porta que rejeita, lança ou devolve forma errada; log que lança;
    - `no-store` em 401 (GET e PUT), 403, 413, 415, 429 (GET e PUT) e 400;
    - CORS: a extensão recebe 403 no GET e no PUT reais e no *preflight*, com JWT, Redis, parser e banco em zero; o portal chega aos dois handlers;
    - SR-12 com canários (notas, cidade, tecnologia, pretensão e token) nos caminhos 200, 204, 400, 413, 429, 503 do PUT e 503 do GET, com as chaves da lista fechada; a rota do log é `/v1/criteria`;
    - invariantes dos handlers: sem principal, sem `Authorization` ou com ele fora da forma, 401 sem tocar no banco.
  - 5 em `test/compose-app.test.ts`, com as peças reais (JWT num JWKS local, Upstash e PostgREST simulados, cifra):
    - o boot monta as duas rotas (401 com `no-store` sem tocar o banco nem o Redis);
    - **o mesmo guarda:** PUT, GET e `POST /v1/analyze` passam pela mesma instância de `CriteriaGuard` (espião no protótipo), com a pretensão ausente do corpo cru enviado ao PostgREST e o GET igual ao gravado;
    - linha só de outro dono: 409 (a RLS do simulado a esconde);
    - chave perdida: GET 503 e nunca 409, e o PUT seguinte recupera a linha;
    - PostgREST que recusa ecoando a linha: 503 sem eco no corpo nem no log.
- A API tem 2.598 testes e 100% (3.010 instruções e 1.929 ramos, já com o `criteria.ts`). Turbo com 16/16 de build, typecheck e lint e 7/7 de teste, em série, sem intermitência. Depcruise sem violações (381 módulos).
- **Correção de contagem:** o `HEAD` anterior (`cfb2859`) tem 2.533 testes, e não os 2.531 registrados no §5.4 (conferido com `git stash`). 2.533 + 65 = 2.598.
- **Mutação:** 35 mutantes, 34 mortos e 1 equivalente. O script ficou no scratchpad, rodou um mutante por vez e conferiu o sha256 dos originais depois de cada um.
  - Na rota: o dono fixo no lugar do principal; o sujeito sem conferir o principal ou o token; os dois 401 da invariante; o `try` do `load` e do `save`; o 503 do GET virando 409; o 200 sem corpo; os dois logs ausentes, sem `safely` ou com a mensagem trocada; o 503 que ecoa os critérios; o 204 com corpo; o PUT sempre 204; sem `no-store`, só numa rota ou com outro valor; sem o schema de saída ou de entrada; sem o `bodyLimit` da rota e com 1 byte a mais; as classes trocadas; a cota diária no PUT; outro caminho.
  - No `buildApp`: sem registrar e registrando sempre. No `composeApp`: sem as rotas e com outro guarda. No catálogo: sem a mensagem nova.
  - **Equivalente:** o GET sem a classe declarada (cai em `padrao`).
  - Na 1ª rodada, 3 mutantes não se aplicaram porque os arquivos têm CRLF. Foram refeitos sem a quebra de linha e morreram.

**Auditoria `[APPSEC]` do código: sem veto.**
- **Critério 1 (T16):** `userId`, `user_id` e chave a mais no corpo dão 400 e nada chega à porta. O dono vem só do principal, e a *query* é ignorada.
- **Critério 4:** o PUT responde 204 sem corpo, e nenhum erro ecoa valor (canários no corpo do 503, do 400 e do 500). O GET tem `no-store` e lê pelo mesmo `CriteriaGuard` da análise, provado por identidade da instância.
- **Critério 7 (SR-12):** nenhum canário no log em 200, 204, 400, 413, 429 e 503. A mensagem nova não tem campos, e nenhum evento de telemetria foi criado.
- **Critério 8:** sem token, nada lê o corpo, o Redis ou o banco; 413 sem parse; 429 antes do corpo. Contado pelo parser instrumentado.
- **Critério 10:** nenhuma dependência nova, nenhuma variável nova e nenhum segredo.
- **Fica para o commit 6:** o critério 2 (RLS real com a primeira barreira furada), o status 201 real do *upsert* e a metade "banco real" do critério 9.

### 5.6 Commit 6: `test:db` da escrita (2026-10-24)
Código:
- `apps/api/test/db/criteria-write.db.test.ts` (novo, 14 testes no job `db`), pelo adapter real da API, pelo cliente de usuário e por um *upsert* montado à mão (para ver o status e o erro que o cliente nunca lê);
- `test/db/support/heaviest-criteria.ts` (novo): o perfil válido mais pesado, com exatamente 12.288 bytes de JSON em ideogramas de 4 bytes sorteados da CJK Ext. B (42.720 letras), com semente fixa. O teste do gerador roda no `pnpm test` (`test/db-heaviest-criteria.test.ts`, 8 testes);
- `test/db/support/local-stack.ts`: `upsert(stack, path, user, body, prefer?)`, e o `send` aceita resposta sem corpo (`return=minimal`);
- `test/db/support/catalog-sql.ts`: `CRITERIA_SIZE_SQL` (`pg_column_size` guardado e sem compressão);
- `vitest.db.config.ts`: o gerador entra na cobertura do `test:db`.

**Achado: o status do *upsert* (emenda ao D5).** O PostgREST 16.4 (a versão que a CLI 2.120.0 do CI sobe) responde **201 quando insere e 200 quando atualiza**. Com a hipótese do D5 (só 201), **todo PUT depois do primeiro viraria 503**: o cliente gravava no banco e respondia `unavailable`. Os testes de unidade não pegaram porque o PostgREST simulado respondia 201 nos dois ramos, e o teste da "segunda gravação" do repositório não conferia o retorno. Correção:
- `POSTGREST_CLIENT_POLICY.upsertSuccessStatuses` = `[201, 200]`, congelado; o cliente confere por um `Set`. 202, 204, 3xx, 4xx e 5xx continuam falha, e o corpo continua nunca lido;
- o PostgREST simulado agora responde 201 na inserção e 200 na atualização, como o real;
- os testes do cliente e do repositório passam a conferir o retorno das duas gravações e a tratar 202 (e não 200) como status fora da lista.

**Prova local com Postgres e PostgREST reais (sem Docker), no scratchpad:**
- Postgres **17.11** (binários da EDB para Windows, sha256 `6eabdf00…cfea3`) e PostgREST **v16.4** (release oficial, sha256 `29a5b56e…9d78`, igual ao digest do GitHub), com um esboço do que a imagem do Supabase traz antes da migration (papéis `anon`, `authenticated`, `service_role` e `authenticator`, `auth.users`, `auth.uid()` e os grants padrão do `public`) e um gateway Node mínimo no lugar do Kong (a publishable) e do signup do GoTrue (JWT HS256 com `role: authenticated`);
- a migration aplicada como está; o `test:db` inteiro deu **61/61** (os 47 do `rls.db.test.ts` sem mudança e os 14 novos), com 100% de cobertura nos arquivos de apoio (71 instruções, 15 ramos);
- substitui a simulação por PGlite e emulador do F1-DB-01 parte 3, que se perdeu com o scratchpad daquela sessão. Esta é mais forte: o PostgREST e o Postgres são os reais. O que não é real: o Kong, o GoTrue e o esboço do Supabase. **A prova definitiva continua sendo o job `db` no GitHub.**

Medidas do banco real:
- **perfil mais pesado:** a coluna `criteria` tem **12.663 bytes** sem compressão, o valor que o `check` mede (ele roda na linha nova, antes do TOAST), e 12.659 guardados (o pglz desistiu). Folga de 3.721 até os 16.384;
- **concorrência:** 5 rodadas, cada uma com duas inserções simultâneas (sem linha) e depois duas atualizações simultâneas. As duas gravações respondem `saved: true` (o `ON CONFLICT` não deixa a segunda dar chave duplicada), e a leitura devolve um dos dois documentos inteiro, com a pretensão do cifrado batendo com o resto da coluna;
- **`%2C`:** o PostgREST lê o `columns=` codificado como lista. Uma chave fora da lista é ignorada com `%2C` e com a vírgula crua, e o controle sem `columns=` responde 400 `PGRST204`. Então foi a lista que a deixou de fora.

**SR-15 da escrita (critério 2):**
- A grava pelo adapter real e lê o mesmo documento;
- com a primeira barreira furada (dono de B, token de A), o adapter responde `unavailable`, o cliente direto responde `{ ok: false }` e o mesmo pedido cru dá **403 `42501`**, na inserção (B sem linha) e na sobrescrita (B com linha). A linha de B fica igual byte a byte (critérios, cifrado e `updated_at`), e a de A também;
- **achado da mutação:** no *upsert* e no insert com `RETURNING`, o Postgres também cobra a policy de SELECT da linha nova. Por isso, trocar o `with check` do insert por `true` só era pego pelo teste de catálogo. Entrou o teste do insert puro (sem `ON CONFLICT` nem `RETURNING`), em que só a policy de insert separa A da linha de B: 403 `42501`;
- `anon` sem token: 401 `42501`.

Verificação:
- `test:db` 61/61 na pilha real; API com **2.609 testes** (11 novos no `pnpm test`: 8 do gerador e 3 do cliente) e 100%; turbo com 16/16 de build, typecheck e lint e 7/7 de teste, em série. Na primeira rodada do turbo com a pilha local ligada, oscilaram o SR-09 do seletor (relógio de parede) e o `edge-socket` *chunked* (RST do Windows), os dois já conhecidos; com a pilha desligada, 7/7. Depcruise sem violações (384 módulos);
- **mutação no cliente:** 7 de 7 mortos (só 201, só 200, sem `freeze`, `has` sempre e nunca, qualquer 2xx, 204 a mais);
- **mutação da migration contra a pilha real**, com o banco refeito e o cache do PostgREST recarregado a cada mutante: 6 de 6 mortos. `with check` do insert `true` (pelo insert puro e pelo catálogo); `using` e `with check` do update `true` (só pelo catálogo: a policy de SELECT também barra o PATCH com filtro, defesa em profundidade); `check` de tamanho em 12.600 (pelo perfil mais pesado); sem `update` para `authenticated` (36 testes); `user_id` sem chave primária (o `on_conflict` quebra); `anon` com insert (pelo `rls.db.test.ts`). O arquivo da migration nunca foi tocado (o mutante ia para o scratchpad).

**Auditoria `[APPSEC]` do código: sem veto.**
- **Critério 2 (SR-15):** as duas barreiras provadas em separado no banco real, inclusive a policy de insert isolada da de SELECT.
- **Critério 9:** o pior caso válido passa no `check` real com 12.663 bytes medidos sem compressão.
- **Critério 6 (falha fechado):** a lista de sucesso ganhou o 200, e só ele. O 200 do *upsert* com `return=minimal` não traz corpo, e o corpo continua cancelado sem leitura.
- **Critério 10:** nenhuma dependência nova no repositório e nenhum segredo. A chave do anel é gerada no teste; a publishable da pilha local e o segredo HS256 do gateway só existem no scratchpad. Os binários baixados ficaram em pastas próprias do scratchpad, com o sha256 registrado.
- **Resíduo:** o Kong e o GoTrue foram substituídos por um gateway mínimo; o job `db` cobre essa diferença.

**Fechamento:** commit `f3491d8`, local, sem push. O F1-API-05 só fecha com push e o job `db` verde (**HITL-027**).

### 5.7 Fechamento: HITL-027 (2026-10-24)

- PR #11 mergeado no `master` (`086730e`), com o head `910b28b` (commits 5 e 6 e os `next-step`; os commits 3 e 4 já estavam no `master` pelo PR #10).
- Run `40119326854`: `secrets`, `quality`, `test` e `db` verdes. O `test:db` deu **61 passed (61)** contra a pilha inteira do Supabase local do runner (Kong, GoTrue e PostgREST da CLI 2.120.0), então a emenda ao D5 (201 na inserção e 200 na atualização) vale também fora da prova local.
- Conferido pela equipe só com leitura (`gh pr view`, `gh pr checks` e o log do job). **F1-API-05 concluído.**
