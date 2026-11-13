---
tipo: adr
id: ADR-018
titulo: "Schema Postgres com RLS, pretensão salarial cifrada no app e CriteriaRepository do Supabase"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]) dentro do ADR-001 §7, do threat-model (T10, T16, T34, T38; SR-15) e do ADR-017 §3.2. Ordem do humano em 2026-10-22 (next-step). Não muda contrato público. Aplicar migration no projeto Supabase real é ação humana (HITL-023, aberto só quando a parte 3 terminar). O teste de RLS dependia do HITL-022 (Supabase CLI e Docker locais), fechado em 2026-10-22 com a saída prevista no runbook, \"rodar o teste de RLS só no CI\": a parte 3 e o HITL-023 passam a esperar o F1-OPS-01 (emenda ao D1, §3.2)."
data: 2026-10-22
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "F1-DB-01 (supabase/migrations, apps/api/src/application/criteria, apps/api/src/application/ports/criteria-repository.ts, apps/api/src/infrastructure/{crypto,supabase,persistence})"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-010-log-allowlist-and-telemetry](ADR-010-log-allowlist-and-telemetry.md)", "[ADR-013-jwt-verification](ADR-013-jwt-verification.md)", "[ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md)", "[ADR-017-analyze-job-and-stream](ADR-017-analyze-job-and-stream.md)", "[threat-model](../threat-model.md)", "*supabase-setup*", "*supabase-local*", "*BACKLOG §F1-DB-01*"]
---

# ADR-018: schema Postgres com RLS, pretensão salarial cifrada no app e `CriteriaRepository` do Supabase

## 1. Contexto

A rota `POST /v1/analyze` existe (ADR-017), mas só com um `CriteriaRepository` falso. Falta a persistência dos três ativos do threat-model que moram no banco:
- **A1:** perfil e critérios, incluindo a pretensão salarial, que o contrato marca como "cifrada em repouso";
- **A9:** registro de análises e feedback.

Restrições herdadas:
- **T10 e SR-15:** o usuário A não lê nem altera B. RLS em todas as tabelas como **segunda** barreira (a primeira é o `sub` verificado). Dois clientes Supabase, e o *admin* nunca carrega token de usuário.
- **ADR-017 §3.2 (risco residual do `[APPSEC]`):** o adapter de critérios nunca rejeita, recusa resposta fora do `UserCriteriaSchema` e tem **prazo próprio**, no modelo dos guardas do ADR-014.
- **Precedente do ADR-014 D2:** SDK que falha aberto ou faz retry sozinho foi recusado em favor de um cliente REST próprio com tetos.

Estado da máquina (2026-10-22): **Supabase CLI ausente** e **daemon do Docker parado**, com 2,6 GB de memória livre. O teste de RLS não roda nesta janela (HITL-022).

## 2. Decisões

### D1. Partição (AGENTS §4.1)
| Parte | Entrega | Depende de |
|---|---|---|
| **1** | Porta com `CriteriaSubject`, `CriteriaGuard` (prazo e revalidação) e `SalaryCipher` (AES-256-GCM) | nada |
| **2** | Cliente REST de usuário (PostgREST), `SupabaseCriteriaRepository` e as variáveis de ambiente | parte 1 |
| **3** | Migrations versionadas e o teste de RLS do SR-15 no Supabase local | ~~HITL-022~~ **F1-OPS-01** (emenda de 2026-10-22: o teste de RLS roda só no CI) |
| — | Aplicar a migration no projeto real | **HITL-023** (aberto ao fim da parte 3, depois do CI) |

O F1-API-04b (ligação no `main.ts`) espera as partes 1 e 2. Ele pode subir antes da parte 3, porque a RLS é a segunda barreira e o `sub` verificado continua sendo a primeira. Mas **nenhuma linha real entra no banco do projeto** antes do HITL-023.

### D2. Schema (parte 3)
Tabelas em `public`, que é o schema que o PostgREST expõe. Cada coluna existe porque uma regra a usa.

**`user_criteria`** (A1), uma linha por usuário:
- `user_id uuid primary key references auth.users(id) on delete cascade`. O *cascade* atende o T34;
- `schema_version smallint not null check (schema_version = 1)`;
- `criteria jsonb not null`, com estes `check`s:
  - `jsonb_typeof(criteria) = 'object'`;
  - `not (criteria ? 'salary')`: a pretensão nunca fica em claro, nem por engano;
  - `pg_column_size(criteria) <= 16384`;
- `salary_ciphertext text not null`, com `check` do formato do envelope (D4) e teto de 1.024 caracteres. Cifra-se **sempre**, inclusive o `null`, para que a coluna não revele quem informou pretensão;
- `updated_at timestamptz not null default now()`.

**`analyses`** (A9), o registro mínimo para o feedback (T38):
- `id uuid primary key` (o `analysisId` do relatório);
- `user_id uuid not null references auth.users(id) on delete cascade`;
- `created_at timestamptz not null default now()`;
- `decision_path`, `verdict` e `score smallint` (0–100), com `check` pela lista fechada dos enums do contrato;
- `unique (id, user_id)`, alvo da FK composta do feedback.

O que **não** entra: texto, título, empresa e `textHash` da vaga. O histórico de vagas que alguém olha é dado comportamental, e o feedback não precisa dele.

**`analysis_feedback`** (A9), um feedback por análise, atualizável (T38 item 2):
- `analysis_id uuid primary key`;
- `user_id uuid not null`;
- `agreement` e `reason` com `check` pela lista fechada do `AnalysisFeedbackRequestSchema`;
- `updated_at`;
- `foreign key (analysis_id, user_id) references analyses(id, user_id) on delete cascade`.

  A FK composta impõe no próprio banco que o feedback e a análise têm o **mesmo dono**. Ninguém precisa de subconsulta na policy.

**Retenção de `analyses`:** 90 dias. A remoção entra **na mesma entrega** que começar a gravar análises (F1-API-06). Até lá, a tabela fica vazia.

### D3. RLS e privilégios (parte 3)
Em **todas** as tabelas:
- `enable row level security` e `force row level security`.
- `revoke all ... from public, anon, authenticated`. O Supabase concede tudo a `anon` e `authenticated` por padrão em tabela nova do `public`, então o `revoke` explícito é obrigatório.
- `grant` só do necessário a `authenticated`:

  | Tabela | Privilégios |
  |---|---|
  | `user_criteria` | `select`, `insert`, `update` |
  | `analyses` | `select`, `insert` |
  | `analysis_feedback` | `select`, `insert`, `update` |

  `delete` só via *cascade* na exclusão de conta. `anon` não recebe nada.
- Uma policy por comando, `to authenticated`, com `using ((select auth.uid()) = user_id)` e o mesmo `with check` no `insert` e no `update`. O `(select ...)` avalia uma vez por consulta (recomendação de performance do Supabase).
- **Teste de catálogo:** toda tabela do `public` tem `relrowsecurity` e `relforcerowsecurity`. Assim, uma tabela nova sem RLS derruba o teste, em vez de depender de alguém lembrar.

As migrations ficam em `trampo.app/supabase/migrations/`, no padrão do CLI, com o nome `<timestamp>_<assunto>.sql`. São só *forward*: corrigir uma migration aplicada é escrever outra.

### D4. Cifra da pretensão salarial no app (parte 1)
- **Algoritmo:** AES-256-GCM do `node:crypto`, com IV de 96 bits aleatório por cifragem e tag de 128 bits. Sem dependência nova.
- **Texto claro:** `JSON.stringify(criteria.salary)`, que é um `SalaryCriterion` ou `null`. Teto de 256 bytes antes de cifrar.
- **AAD:** `trampo:user_criteria.salary:s1:<userId>`. Isso liga o cifrado ao dono e ao campo. Copiar o cifrado de B para a linha de A falha na tag.
- **Envelope:** `s1.<kid>.<iv>.<cifrado>.<tag>`, cada parte em base64url, e `kid` em `[a-z0-9]{1,16}`. O `check` da coluna usa o mesmo padrão.
- **Chaves:** `CRITERIA_SALARY_KEYS=<kid>:<base64url de exatamente 32 bytes>,...` (de 1 a 4 chaves) e `CRITERIA_SALARY_ACTIVE_KEY=<kid>`.
  - Ficam **só no `.env`** da API e no gerenciador de senhas. Nunca no cofre, no banco ou no Supabase Vault: com a chave no banco, um vazamento do banco revelaria a pretensão, e é exatamente isso que a cifra no app evita.
  - O boot falha fechado com chave fora do formato, `kid` repetido ou `kid` ativo ausente. Nenhuma mensagem contém material de chave.
- **Rotação:**
  1. Acrescentar a chave nova ao anel e torná-la a ativa.
  2. A leitura aceita qualquer `kid` do anel. A escrita usa sempre a ativa, então toda gravação recifra.
  3. Antes de retirar uma chave, uma varredura recifra as linhas com o `kid` antigo. A varredura é um item futuro, porque com um usuário não há linhas paradas.
- **Falha:** `kid` desconhecido, formato inválido, tag que não confere ou texto claro fora do `SalaryCriterionSchema.nullable()` retornam `{ ok: false }`, sem exceção. O repositório traduz isso em `unavailable`, ou seja, 503 e não 409. Quem perdeu a chave não pode ver "configure seus critérios" e sobrescrever o que tinha.
- **Emenda do [ADR-004-extension-auth](ADR-004-extension-auth.md) D5 e §6.1 (F1-API-07, commit 07b, 2026-11-07): AEAD por finalidade.** A cifra virou `infrastructure/crypto/aead-envelope.ts`, usada pela pretensão (`s1`) e pelo refresh selado da autenticação (`r1`, `aead-refresh-sealer.ts`):
  - cada finalidade tem prefixo, anel e prefixo de AAD próprios. O prefixo de AAD precisa terminar em `:<versão>:` (conferido na criação), então o prefixo do envelope fica amarrado pela tag: trocar `s1.` por `r1.` à mão não abre. A amarra foi achada pelo teste do 07b; antes, só a escolha dos textos de AAD separava as finalidades;
  - o `kid` segue em `[a-z0-9]{1,16}`, agora preso por teste à regex do `SealedRefreshSchema` (o boot aceita exatamente os kids que o contrato aceita);
  - **formato `s1` sem mudança:** AAD `trampo:user_criteria.salary:s1:<userId>`, mesma ordem de partes e mesma base64url canônica. Dois vetores gravados com o código anterior à generalização (pretensão e `null`) abrem com o mesmo valor depois dela, então as linhas já gravadas continuam legíveis;
  - os anéis são separados por variável (`CRITERIA_SALARY_*` e `AUTH_REFRESH_SEAL_*`). A recusa de material de chave repetido entre os dois anéis entra com a composição do boot (07g).

### D5. Os dois clientes Supabase
| Cliente | Credenciais | Quem usa | Regra |
|---|---|---|---|
| **Usuário** (parte 2) | chave *publishable* no `apikey` e o JWT do usuário no `Authorization: Bearer` | `CriteriaRepository`; depois `UpdateCriteria` (F1-API-05) e `RecordFeedback` (F1-API-06) | Um token **por chamada**, nunca guardado. O construtor recusa chave `sb_secret_` ou legada (`eyJ`). A RLS vale. |
| **Admin** (F1-PORTAL-03) | chave *secret* | só o `DeleteAccount` (`DELETE /auth/v1/admin/users/:id`, com *cascade* nas tabelas) | A interface **não aceita token**, só o `userId` verificado. Uma regra de depcruise restringe o import ao caso de uso de exclusão. A prova da metade "admin sem token" do SR-15 fica nessa entrega. |
| **GoTrue do BFF** (F1-API-07 07c; emenda do [ADR-004-extension-auth](ADR-004-extension-auth.md) D4 e §6.1, 2026-11-07) | chave *publishable* no `apikey`; o Bearer do usuário só no logout | `ExchangeSession`, `RefreshSession` e `EndSession` (07f) | `infrastructure/supabase/gotrue-token-client.ts`, sem SDK. URL fixa de `SUPABASE_URL`, `redirect: "error"`, 5 s, 32 KiB, sem retry. Lista fechada de cabeçalhos de saída (nunca `X-Forwarded-For`, `X-Real-IP`, `Forwarded` nem cabeçalho do cliente). O construtor recusa `sb_secret_` e `eyJ`. Do 200, só 4 campos; o 404 só é recusa com o corpo JSON do GoTrue, e o `error_code` nunca sai do adapter. |

**Cliente REST próprio, sem `@supabase/supabase-js`:** a API só precisa de 3 ou 4 chamadas PostgREST. O SDK traz *auth*, *realtime* e *storage*, e não impõe teto de resposta nem prazo por chamada. O cliente segue o modelo do `upstash-rest-client` (ADR-014 D2) e falha fechado em qualquer desvio:
- `AbortSignal` do guarda;
- `redirect: "error"`;
- só os status esperados;
- `content-type` JSON;
- resposta com no máximo 32 KiB;
- UTF-8 e JSON válidos, com *reviver* que recusa `__proto__` e `constructor`.

A leitura é `GET /rest/v1/user_criteria?select=schema_version,criteria,salary_ciphertext&user_id=eq.<uuid>`, que devolve um array com 0 ou 1 item. O filtro por `user_id` é redundante com a RLS de propósito: é a primeira barreira, e a RLS é a segunda.

### D6. Porta e guarda (parte 1)
- **Mudança na porta:** `CriteriaRepository.load(subject: CriteriaSubject)`, com `CriteriaSubject = { userId, accessToken }`. O `preHandler` dos critérios relê o `Authorization` com o `bearerToken` da borda. O hook de autenticação já o verificou nessa mesma requisição, e o `Principal` continua sem token (o verificador não muda). O `AnalyzeJob` continua sem ver nem o `userId` nem o token.
- **`CriteriaGuard implements CriteriaRepository`**, em `application/criteria/criteria-guard.ts`. É um decorador: o `main.ts` (F1-API-04b) embrulha o adapter com ele, e a rota não muda.
  1. Confere a entrada: `userId` UUID e `accessToken` JWS compacto de até 8.192 caracteres. Fora disso, `unavailable`, sem chamar a porta.
  2. Usa o `withDeadline` com o `Clock` injetado e `CRITERIA_GUARD_POLICY.timeoutMs = 1.000`, uma hipótese da Fase 1 a calibrar no S-5. O sinal aborta a chamada perdedora.
  3. Revalida a resposta com um schema estrito: `{ found: true, criteria: UserCriteriaSchema } | { found: false } | { found: false, unavailable: true }`. Qualquer outra forma, exceção, rejeição ou demora vira `{ found: false, unavailable: true }`.
  4. Devolve os critérios **reparseados**, nunca o objeto do adapter.
  5. Nunca rejeita.

### D7. Testes
- **Parte 1:** guarda com porta travada (resolve `unavailable` exatamente no prazo, no relógio falso), que rejeita, que lança de forma síncrona, que devolve forma errada, critérios fora do schema ou chave a mais; e sinal abortado no perdedor. Cifra com ida e volta, IV único, AAD de outro usuário, tag, IV e cifrado adulterados, `kid` desconhecido, envelope malformado, texto claro fora do schema, anel inválido no boot e mensagens sem material de chave. 100% de cobertura nos arquivos novos e mutação.
- **Parte 2:** cliente contra um PostgREST simulado em socket real (como o Upstash do ADR-014): cabeçalhos exatos, nenhum `sb_secret_`, redirecionamento, status, tamanho, JSON, `__proto__` e aborto.
- **Parte 3 (SR-15), com o Supabase local:**
  - A grava critérios; B não os lê (`[]`), não os altera (0 linhas) e não insere com o `user_id` de A (RLS);
  - `anon` não acessa nenhuma tabela;
  - A não cria feedback para a análise de B (FK composta e RLS);
  - catálogo: RLS ligada e forçada em toda tabela do `public`;
  - `check`s: `salary` em claro e envelope inválido são recusados;
  - exclusão do usuário no Auth leva as linhas junto (*cascade*; a prova completa do SR-16 é do F1-PORTAL-03).

  Fica num projeto Vitest separado (`test:db`), fora do `pnpm test`: o portão padrão não pode exigir Docker. O CI decide no F1-OPS-01.

## 3. Auditoria `[APPSEC]`
**Sem veto.** Critérios de aceite:

1. **Pretensão nunca em claro fora da memória da API:** `check` no banco, AAD por dono, e nenhuma pretensão no log ou na telemetria. O SR-12 continua: nenhuma mensagem nova leva campo.
2. **Chave nunca no cofre, no git ou no banco.** O `.env.example` só com nomes, e a geração com `crypto.randomBytes(32)` documentada nele.
3. **Falha de decifragem é 503, nunca 409** (D4). Isso evita a sobrescrita silenciosa.
4. **Token do usuário só em trânsito:** sem cache, sem campo em objeto de longa vida e nunca em mensagem de erro. O cliente de usuário recusa chave *secret*.
5. **`revoke` explícito de `anon` e `authenticated`** antes dos `grant`s, provado no teste. É o erro mais comum de RLS no Supabase.
6. **`force row level security`** e o teste de catálogo para tabelas futuras.
7. **Prazo e revalidação no guarda**, com o teste do adapter travado (o aceite herdado do ADR-017).
8. **Nenhuma migration no projeto real sem o HITL-023.**

**Riscos residuais aceitos:**
- **`.env` e banco vazados juntos revelam a pretensão.** A cifra protege o vazamento só do banco (backup, painel ou SQL), que é o cenário provável.
- **O dono pode gravar `criteria` arbitrário pelo PostgREST** com o próprio token e a *publishable*, sem passar pelo Zod. Só prejudica a si mesmo: a leitura revalida e responde 503.
- **O dono pode inserir `analyses` falsas para si.** Isso polui só o próprio feedback. Se o feedback virar sinal de calibração agregado, o `insert` passa ao servidor (decisão do F1-API-06).

### 3.1 Parte 1 entregue (2026-10-22, commit `2687c7a`)
Código:
- `application/ports/criteria-repository.ts`: `CriteriaSubject` e o `signal` opcional;
- `application/criteria/criteria-guard.ts`: `CriteriaGuard` e `CRITERIA_GUARD_POLICY`;
- `infrastructure/crypto/salary-cipher.ts`: `parseSalaryKeyring`, `createSalaryCipher`, `SalaryKeyringConfigError` e `SalarySealError`;
- o `preHandler` dos critérios relê o token com `bearerToken`. Principal sem token dá 401 e não lê o banco.

Refinamentos do desenho, sem mudar decisão:
- **Schema da resposta com dois ramos** (`found: true` e `found: false` com `unavailable` booleano opcional), ambos estritos. Chave a mais em `found: false` vira `unavailable`, e a saída é normalizada para a forma canônica.
- **`parseSalaryKeyring(keys: string, activeKid: string)`:** a variável ausente chega como `""` (`?? ""` em quem lê o .env) e cai no mesmo caminho de recusa. A checagem de `undefined` era um mutante equivalente e saiu do código.
- **Saíram do `open`, por serem equivalentes:**
  - o teto de 1.024: o padrão do envelope já limita a ~400 caracteres;
  - o UUID do dono: o AAD da cifragem, que exige UUID, não confere;
  - o *reviver* de `__proto__`: o `JSON.parse` deixa a chave como própria, e o schema estrito a recusa.

  O teto de 256 bytes do texto claro não é checado em código, porque o `SalaryCriterionSchema` o garante. Um teste do pior caso (número de 23 caracteres, `ponderado` com peso 5) prova esse teto.
- **O AAD usa o `userId` exatamente como veio do `sub`.** Se a caixa do UUID mudasse entre a escrita e a leitura, a leitura falharia fechado (503), nunca abriria a pretensão de outro.

Verificação:
- **100 testes novos:** 37 do guarda, 61 da cifra e 2 da rota. A API ficou com 1.978 testes e 100% (1.731/1.731 ramos). `tsc`, `eslint`, build e depcruise verdes (333 módulos).
- **Mutação em duas rodadas:**
  - 1ª rodada, 47 mutantes: os sobreviventes G2 e G4 (âncora e espaço no padrão do token) viraram 2 testes; G14 e G20 sumiram com a fusão dos ramos e viraram 1 teste; C23 saiu do código.
  - 2ª rodada, 46 mutantes: 41 mortos e 5 equivalentes:
    - C3 (`typeof`): o `exec` converte para string, e nada casa;
    - C5 e C6 (cifrado ou tag nulos): o decifrador lança dentro do `try`;
    - C21 e C22 (comprimento da tag e do IV no padrão): o GCM recusa a tag de outro tamanho, e o IV de outro tamanho não confere.

    As cinco guardas ficam por clareza: espelham o `check` da coluna e não dependem de `TypeError` do `node:crypto`.
- **Auditoria `[APPSEC]` do código: sem veto.**

  | Critério | Situação |
  |---|---|
  | 1 (pretensão em claro) | cumprido: cifra com AAD por dono e mensagens fixas, sem valor |
  | 2 (chave fora do cofre, do git e do banco) | cumprido: os testes geram chaves aleatórias, e nada foi escrito no `.env.example` ainda |
  | 4 (token só em trânsito) | cumprido: o guarda recria o sujeito, não guarda nada, e o teste da rota prova que o token não aparece no log |
  | 7 (prazo e revalidação) | cumprido: o adapter travado responde `unavailable` em exatamente 1.000 ms no relógio falso, com o sinal abortado e nenhum timer vazando |
  | 3 (decifragem → 503) | herdado pela parte 2, no adapter |
  | 5, 6 e 8 | herdados pela parte 3 |

### 3.2 Parte 2 entregue (2026-10-22) e emenda ao D1
**Emenda ao D1 (ordem do humano, 2026-10-22):** o HITL-022 fechou com a saída prevista no *supabase-local*, "rodar o teste de RLS só no CI". A estação tem 16 GB de RAM no Windows, o que não comporta a pilha completa do Supabase local no Docker. Por isso:
- a **parte 3** (migrations, `test:db` e o teste de RLS do SR-15) passa a depender do **F1-OPS-01** (GitHub Actions), não mais do Supabase local;
- o **HITL-023** (aplicar no projeto real) também espera o CI verde;
- o F1-API-04b sobe antes, como o D1 já previa. Enquanto a migration não existir no projeto real, o PostgREST responde 404 para `user_criteria`, e toda análise sai **503 (falha fechado)**, nunca 409 nem análise sem critérios.

Código:
- `infrastructure/supabase/postgrest-user-client.ts`: `createPostgrestUserClient`, `POSTGREST_CLIENT_POLICY` (900 ms, 32 KiB, token de até 8.192) e `PostgrestClientConfigError`;
- `infrastructure/persistence/supabase-criteria-repository.ts`: `createSupabaseCriteriaRepository` e `USER_CRITERIA_SELECT`;
- `.env.example`: `CRITERIA_SALARY_KEYS` e `CRITERIA_SALARY_ACTIVE_KEY`, só os nomes, com o comando de geração.

Refinamentos do desenho, sem mudar decisão:
- **Lista positiva da chave:** o construtor aceita só `^sb_publishable_[\w-]{1,256}$`. A *secret* (`sb_secret_`) e a legada (`eyJ`) caem no mesmo caminho de recusa, com mensagem fixa.
- **Prazo do cliente (900 ms) abaixo do guarda (1.000 ms):** o cliente é o cinto por baixo do guarda. O `signal` do chamador e o prazo próprio são combinados com `AbortSignal.any`.
- **O cliente confere a forma do token** (JWS compacto de até 8.192) antes de montar o cabeçalho. Token fora da forma não sai do processo.
- **`content-type`:** só `application/json`, com ou sem parâmetros. O `application/vnd.pgrst.object+json` é recusado: a leitura é sempre um array.
- **O *reviver* é o `parseJsonWithoutPrototypeKeys`** do ADR-008, o mesmo da leitura do cache.
- **A coluna `criteria` guarda o `UserCriteria` sem `salary` e sem `schemaVersion`.** As duas chaves na coluna dão `unavailable`: a pretensão mora só no cifrado, e a versão só em `schema_version`. Nada é sobrescrito em silêncio.
- **0 ou 1 linha:** duas linhas, coluna a mais, cifrado ausente ou nulo, `schema_version ≠ 1` e `criteria` que não é objeto dão `unavailable`.
- **Token que o PostgREST recusa (401) é `unavailable`**, não "não configurado".

Verificação:
- **100 testes novos** (64 do cliente e 36 do repositório), contra um PostgREST simulado em socket real que imita a RLS (o token define o dono). Nenhuma chamada externa e nenhum Docker. Cobertura de 100% nos dois arquivos.
- **De ponta a ponta pela rota:** cifrado de outro dono na linha dá **503 `SERVICO_INDISPONIVEL`**, com a cota intacta. Sem linha dá 409, e linha válida dá 200 em SSE.
- **Mutação**, um mutante por vez, com o script em arquivo no scratchpad e o original conferido por sha256 depois de cada um: **49 mutantes, 44 mortos e 5 equivalentes**. O sobrevivente C18 (o prazo próprio ignorado quando há `signal`) virou 1 teste. Os equivalentes:
  - C30 (`body.cancel()` removido): só libera o socket, sem efeito observável;
  - C31 (`body === null`): o `fetch` só dá corpo nulo em 204, 205 e 304, que o status já recusa. Fica como *type guard*;
  - R6 (`schema_version` qualquer número): o `UserCriteriaSchema` exige o literal 1 depois;
  - R11 (sem o `if (!salary.ok)`): `salary` indefinido reprova no `UserCriteriaSchema`. A checagem fica explícita, porque é o critério 3;
  - R17 (devolver o objeto montado, não o reparseado): o valor é igual, e o guarda reparseia de novo.

**Auditoria `[APPSEC]` do código: sem veto.**

| Critério | Situação |
|---|---|
| 3 (decifragem → 503, nunca 409) | **cumprido:** chave perdida, chave trocada com o mesmo `kid`, cifrado de outro dono, tag adulterada, envelope inválido e `salary` em claro dão `unavailable`. O teste da rota prova 503 sem gastar cota |
| 4 (token só em trânsito) | **cumprido:** o cliente guarda só a publishable. O token entra por chamada, só no `Authorization`, nunca na URL, e não aparece em mensagem nem em log (testes do cliente, do repositório pela rota e do boot). A *secret* e a legada são recusadas no construtor e no boot |
| 2 (chave fora do cofre, do git e do banco) | **cumprido:** o `.env.example` só tem nomes. Os testes geram chaves aleatórias. A varredura de segredo achou só as *fixtures* falsas (`sb_secret_AbC123-teste_xyz` e `sb_secret_vazada-123`) |
| 5, 6 e 8 | herdados pela parte 3, agora no F1-OPS-01 |

Risco residual novo, aceito: **sem a parte 3, a RLS ainda não existe no projeto real.** O D1 já aceitava subir o F1-API-04b antes. A primeira barreira (filtro pelo `sub` verificado) vale, e o AAD por dono impede abrir a pretensão de outra linha. Como nenhuma linha real entra antes do HITL-023, não há dado para vazar.

### 3.3 Parte 3 entregue (2026-10-22, local; o job `db` no GitHub é o HITL-026)
Entregue dentro do F1-OPS-01 parte 2 ([ADR-019-ci-github-actions](ADR-019-ci-github-actions.md) §3.2, onde estão o job, o guarda do `test:db`, a simulação e a mutação).

Código:
- `supabase/migrations/20261022230000_criterios_analises_feedback.sql`: D2 e D3 numa migration só, ou seja, numa transação. Nenhuma tabela existe, nem por um instante, sem RLS ou com o grant padrão do Supabase;
- `apps/api/test/db/rls.db.test.ts`: o SR-15 do D7 inteiro, pelo Auth e pelo PostgREST locais e pelo adapter real da API.

Refinamentos do desenho, sem mudar decisão:
- **Regex do envelope:** o Postgres limita a repetição a 255 (`invalid repetition count(s)`, conferido no PGlite), então o cifrado de 1 a 342 caracteres virou `{1,255}` seguido de `{0,87}`. As bordas (1 e 342 passam; 0 e 343 não) têm teste.
- **`check` também para `schemaVersion` na coluna `criteria`**, espelhando o adapter (§3.2), que já a recusava na leitura.
- **`revoke` também de `service_role` (endurecimento do `[APPSEC]`).** Ele tem `BYPASSRLS`. A chave *secret* só serve ao `DeleteAccount` pela API de admin do Auth (D5), que apaga por *cascade* sem privilégio nestas tabelas. Uma *secret* vazada não lê critério nem cifrado pelo PostgREST. Quem precisar dela numa tabela (a retenção do F1-API-06, por exemplo) recebe um grant explícito, com ADR.
- **Índice em `analyses(user_id)`**, que a policy e a FK usam.
- **Constraints com nome** (`user_criteria_sem_salary`, `analysis_feedback_mesmo_dono` e as demais): o teste confere a recusa pelo nome, não só pelo código.
- **O teste confere o catálogo inteiro, não só a RLS:** a matriz de privilégios de `anon`, `authenticated` e `service_role` em toda tabela do `public`, inclusive grant de coluna (`has_any_column_privilege`), e o texto exato de cada policy.
- **Todo valor dos enums do contrato passa no banco** (veredito, caminho, concordância e motivo, lidos do `@trampo/contracts` no teste). Uma lista do `check` que ficar para trás em relação ao contrato derruba o teste.

**Auditoria `[APPSEC]` das policies: sem veto.**

| Critério | Situação |
|---|---|
| 5 (`revoke` explícito antes dos grants, provado no teste) | **cumprido:** `revoke all ... from public, anon, authenticated, service_role`, antes dos grants. Matriz exata no teste. Sem o `revoke`, a mutação abre leitura a `anon` e `delete` a `authenticated` |
| 6 (`force` e catálogo para tabela futura) | **cumprido:** toda relação do `public` precisa de `relrowsecurity` e `relforcerowsecurity`. Na simulação, o dono da tabela não vê linha sem o `sub` |
| 8 (nada no projeto real sem o HITL-023) | **cumprido:** a política do CI proíbe `link`, `db push`, token e `*.supabase.co`, e a equipe não rodou nada contra o projeto. O HITL-023 só abre com o job `db` verde |
| T10 (A e B isolados) | **cumprido na simulação e pela suíte no emulador:** leitura, alteração, inserção, troca de dono e feedback cruzado (a FK composta recusa com o próprio `user_id`, e a RLS com o do outro) |
| T34 (*cascade*) | **cumprido na simulação:** critérios, análise e feedback somem com o usuário do Auth |

**Riscos residuais novos, aceitos:**
- **`updated_at` é gravável pelo dono.** Afeta só a própria linha, e nada decide por ele. Um *trigger* entra se algum dia ele virar critério.
- **Supabase de verdade só no runner:** a simulação usa um esboço do Supabase. A prova definitiva é o job `db` (HITL-026).

**Fechamento (2026-10-23, HITL-026):** o job `db` ficou verde no GitHub ([ADR-019-ci-github-actions](ADR-019-ci-github-actions.md) §3.3), com o SR-15 inteiro (47/47) contra o Supabase local de verdade. Isso desfaz o risco residual "Supabase de verdade só no runner". A parte 3 e o F1-DB-01 estão concluídos. **HITL-023 aberto** (runbook *supabase-migration-real*): o humano aplica a migration no projeto real e confere o catálogo com consultas só de leitura. **HITL-023 fechado (2026-10-23, declarado pelo humano):** aplicada pelo SQL Editor (caminho A), com o hash conferido e as consultas §4.1 a §4.4 conforme. O critério 8 do `[APPSEC]` foi cumprido: a equipe não tocou no projeto real.

## 4. Consequências
- O `FakeCriteriaRepository` e o `preHandler` passam a usar o `CriteriaSubject` (parte 1).
- `.env.example` ganha `CRITERIA_SALARY_KEYS` e `CRITERIA_SALARY_ACTIVE_KEY` (parte 2). Gerar as chaves reais é o HITL-024, aberto no F1-API-04b.
- O HITL-022 fechou com "só no CI" (2026-10-22). A parte 3 e o HITL-023 esperam o F1-OPS-01.
- O `supabase/` na raiz do `trampo.app` nasce na parte 3, com `supabase init`.
