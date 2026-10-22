# Próximo passo: F1-DB-01 parte 2 (cliente REST do PostgREST e `SupabaseCriteriaRepository`)

> **Reciclagem de sessão** (AGENTS §4.4): esta janela escreveu o ADR-018, entregou a parte 1 com duas rodadas de mutação e fez a auditoria.
>
> Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (2026-10-22)

### ADR-018 aceito (`[APPSEC]` sem veto)
Arquivo: `../base/02-arquitetura/ADRs/ADR-018-postgres-schema-rls-and-criteria.md`. O ADR decide:
- **Schema:**
  - `user_criteria`, com a pretensão **sempre cifrada** e um `check` contra `salary` em claro;
  - `analyses` mínima, sem texto nem `textHash`;
  - `analysis_feedback`, com FK composta `(analysis_id, user_id)`.
- **RLS** `enable` e `force` em todas as tabelas, com `revoke` explícito de `anon` e `authenticated` e um teste de catálogo.
- **Cifra no app:** AES-256-GCM, AAD por dono, envelope `s1` e anel `CRITERIA_SALARY_KEYS` / `CRITERIA_SALARY_ACTIVE_KEY`, só no `.env`.
- **Clientes:**
  - o de usuário é um cliente REST próprio, com a *publishable* e o JWT do usuário, sem `supabase-js`;
  - o *admin* fica só no F1-PORTAL-03, sem aceitar token.
- **Partição em 3 partes** (D1). A parte 3 depende do **HITL-022**.

### F1-DB-01 parte 1 (commit `2687c7a`, **local, sem push**)
- **Código:**
  - `CriteriaRepository.load(subject, signal?)`, com o `CriteriaSubject` (`userId` e o token já verificado). O `preHandler` relê o `Authorization`, e um principal sem token dá 401 sem ler o banco;
  - `apps/api/src/application/criteria/criteria-guard.ts`: prazo de 1.000 ms, revalidação pelo `UserCriteriaSchema` e forma canônica. Nunca rejeita;
  - `apps/api/src/infrastructure/crypto/salary-cipher.ts`: `parseSalaryKeyring`, `createSalaryCipher` (`seal` e `open`), rotação por `kid`, e o `open` nunca lança.
- **Testes:** 100 novos. A API está com **1.978 testes e 100%** de cobertura (1.731/1.731 ramos). `tsc`, `eslint`, build e depcruise verdes (333 módulos).
- **Mutação:** 46 mutantes, 41 mortos e 5 equivalentes, justificados no ADR §3.1. Na 1ª rodada, 2 sobreviventes viraram testes e 5 checagens equivalentes saíram do código.
- **Aceite herdado do ADR-017 §3.2 cumprido:** o adapter travado responde `unavailable` em exatamente 1.000 ms.

### Pendências
- **HITL-022 (aberto):** instalar o Supabase CLI, subir o Docker Desktop e liberar memória (eram 2,6 GB livres). Runbook: `../base/03-infra-runbook/supabase-local.md`. Bloqueia **só a parte 3**.
- **Push e PR:** os commits `c928716`, `ddd148b`, `83d5fe4`, `0c235fd`, `78f7a07`, `5bc3f3d`, `5755033`, `f0bcd52`, `a791ad7`, `2687c7a` e o deste `next-step` continuam locais. Vale a opção B, e a decisão é do humano.
- **QA-01:** fica para o CI (F1-OPS-01). **DOC-01:** no backlog.

## Herdado para a parte 2 (ADR-018 D5 e §3.1)
- **Cliente REST de usuário** em `apps/api/src/infrastructure/supabase/`, no modelo do `upstash-rest-client`:
  - `apikey` com a *publishable* e `Authorization: Bearer <JWT do usuário>`, um token por chamada;
  - o construtor recusa chave `sb_secret_` e legada (`eyJ`);
  - `AbortSignal`, `redirect: "error"`, só os status esperados, `content-type` JSON, no máximo 32 KiB, e UTF-8 e JSON válidos.
- **`SupabaseCriteriaRepository`:**
  - `GET /rest/v1/user_criteria?select=schema_version,criteria,salary_ciphertext&user_id=eq.<uuid>`, que devolve 0 ou 1 linha;
  - decifra com o `SalaryCipher` e monta o `UserCriteria`;
  - **falha de decifragem é `unavailable` (503, nunca 409)**, o critério 3 do `[APPSEC]`;
  - `criteria` com chave `salary` em claro é `unavailable`.
- **`.env.example`:** `CRITERIA_SALARY_KEYS` e `CRITERIA_SALARY_ACTIVE_KEY` (só nomes), com o comando de geração `crypto.randomBytes(32)`.
- **Testes:** PostgREST simulado em socket real. Nenhum `sb_secret_` e nenhum token no log.
- **Depois da parte 2:** o F1-API-04b pode subir, porque a RLS é a segunda barreira. Mas nenhuma linha real entra no banco do projeto antes do HITL-023.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (F1-DB-01 e o F1-API-04b), HITL-QUEUE.md (HITL-022), o ADR-018 (D4, D5, D6 e §3.1) e o ADR-014 D2 (modelo do cliente REST). Confirme pnpm 11.4.0, Node >= 24, o branch feat/api-borda (commits locais, sem push: opção B) e a memória livre antes de rodar suítes pesadas. Se o humano tiver respondido o HITL-022, registre o fechamento, mas a parte 3 continua fora desta janela.
2. [ARCHITECT] + [APPSEC]: confirmem o desenho da parte 2 contra o ADR-018 (cliente REST de usuário e SupabaseCriteriaRepository). Registrem como refinamento qualquer ajuste, sem mudar decisão. Mudança de decisão exige emenda ao ADR antes do código.
3. [DEV] + [QA_EVALS]: implementem só a parte 2 (AGENTS §4.1):
   - cliente REST de usuário, com tetos e falha fechada, contra um PostgREST simulado em socket real;
   - SupabaseCriteriaRepository, com a decifragem pelo SalaryCipher, em que falha é unavailable (503, nunca 409);
   - .env.example só com os nomes.
   Exijam 100% de cobertura nos arquivos novos e mutação (um mutante por vez, em primeiro plano, script fora de coverage/ e do repositório, conferindo o original depois de cada lote; patch de arquivo com acento pela ferramenta de edição ou por arquivo UTF-8, nunca por script no stdin).
4. [APPSEC]: auditem o código contra o ADR-018 §3 (critérios 3 e 4) antes de dar a parte como concluída.
5. [SCRIBE]: atualizem STATE.md, BACKLOG.md e SESSION-LOG.md, façam só o commit local (sem push) e gerem o novo ./next-step.md (próxima: a parte 3 se o HITL-022 fechou; senão, o F1-API-04b).
```
