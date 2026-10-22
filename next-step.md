# Próximo passo: decisão do humano sobre o push (destrava o F1-OPS-01) ou uma tarefa sem HITL

> **[PARADA OBRIGATÓRIA]** (AGENTS §2, Fase 5):
> - o F1-OPS-01, que agora carrega a parte 3 do F1-DB-01, exige **push**, e o push é decisão do humano;
> - o **HITL-024** está aberto;
> - esta janela entregou duas tarefas, cada uma com a própria mutação (AGENTS §4.4).
>
> Sessão extensa detectada. Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (2026-10-22, commit local, sem push)

### HITL-022 fechado: "só no CI"
- A estação tem 16 GB de RAM no Windows, e o Supabase local não será provisionado.
- **Emenda ao ADR-018 D1:** a **parte 3** do F1-DB-01 (migrations, `test:db` e o teste de RLS do SR-15) foi para o **F1-OPS-01**. O **HITL-023** (aplicar no projeto real) espera o CI verde.

### F1-DB-01 parte 2 (ADR-018 §3.2)
- **`createPostgrestUserClient`** (`apps/api/src/infrastructure/supabase/`):
  - só a chave publishable no `apikey`. A *secret* (`sb_secret_`) e a legada (`eyJ`) são recusadas;
  - o JWT do usuário por chamada, no `Authorization`;
  - prazo de 900 ms, abaixo dos 1.000 ms do guarda;
  - resposta com no máximo 32 KiB, `content-type` JSON, UTF-8 estrito e *reviver* sem `__proto__`, sem seguir redirecionamento.
- **`createSupabaseCriteriaRepository`** (`apps/api/src/infrastructure/persistence/`):
  - decifra a pretensão com o `SalaryCipher`;
  - falha de decifragem, `salary` em claro ou linha fora da forma dão **503, nunca 409** (provado pela rota).
- **`.env.example`:** `CRITERIA_SALARY_KEYS` e `CRITERIA_SALARY_ACTIVE_KEY`, só os nomes, com o comando de geração.
- **Testes:** 100 novos, contra um PostgREST simulado em socket real. Nenhuma chamada externa e nenhum Docker.
- **Mutação:** 49 mutantes, 44 mortos e 5 equivalentes.
- **`[APPSEC]`:** sem veto, com os critérios 3 e 4 cumpridos.

### F1-API-04b (ADR-017 §3.3): o F1-API-04 está completo
- **`apps/api/src/composition/compose-app.ts`:** raiz de composição. O `main.ts` só a chama e sobe a porta.
  - Os critérios do Supabase entram sempre dentro do `CriteriaGuard`.
  - O boot falha fechado sem publishable, com chave *secret* ou legada, sem o anel da pretensão, sem as credenciais do Upstash, sem o pepper ou com JWKS de outro projeto.
- **Extração por LLM opcional até o F1-LLM-02:**
  - sem adapters, a análise é só determinística;
  - com adapters, entram o router (`createRedisQuotaLedger`, `systemClock` e `cryptoRandom`) e o cache (`CACHE_CLIENT_LIMITS`).
- **Aceite cumprido:** o boot monta `POST /v1/analyze` e responde 401 sem token. O fluxo completo também foi provado (JWT real num JWKS local, Upstash e PostgREST simulados): 200 em SSE.
- **Testes:** 30 novos.
- **Mutação:** 18 mutantes, 16 mortos e 2 equivalentes.
- **`[APPSEC]`:** sem veto.

### Gate
- API com **2.108 testes e 100%** (1.781/1.781 ramos).
- Turbo 18/18 em série e depcruise sem violações (354 módulos).
- A varredura de segredo achou só as *fixtures* falsas.

### Pendências do humano
- **HITL-024:** pôr a `SUPABASE_PUBLISHABLE_KEY` e o anel da pretensão no `apps/api/.env`. Bloqueia só subir a API fora dos testes. Mesmo com as chaves, toda análise com token dá 503 até a migration existir no projeto real (falha fechado).
- **Push e PR:** os commits `c928716`, `ddd148b`, `83d5fe4`, `0c235fd`, `78f7a07`, `5bc3f3d`, `5755033`, `f0bcd52`, `a791ad7`, `2687c7a`, `ce1b088` e o deste lote continuam locais. Vale a opção B: um PR de processamento e domínio depois do merge do PR #3. **O F1-OPS-01 só anda com push.**

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md e HITL-QUEUE.md (HITL-023 e HITL-024). Confirme pnpm 11.4.0, Node >= 24 e o branch feat/api-borda (commits locais, sem push). Se o humano tiver decidido o push e o PR, registre a decisão.
2. Escolha UMA tarefa (AGENTS §4.1):
   - Com push autorizado: o F1-OPS-01 (GitHub Actions). Ele inclui o job da parte 3 do F1-DB-01: supabase init, as migrations do ADR-018 D2 e D3 e o test:db do SR-15, com o Supabase local só no runner. Nunca use o projeto real nem segredo real no CI. Antes do código, o desenho fica em ADR, com a auditoria do [APPSEC].
   - Sem push: o F1-LLM-02. O contrato do model com o prefixo estrito @cf/ vem primeiro, num commit próprio, com os testes negativos do BACKLOG. Depois vem o adapter da Workers AI, ligado pelo composeApp com options.llm.
3. [DEV] + [QA_EVALS]: exijam 100% de cobertura nos arquivos novos e mutação (um mutante por vez, script em arquivo fora do repositório, original conferido depois de cada mutante; patch com acento só pela ferramenta de edição).
4. [APPSEC]: auditem antes de dar a tarefa como concluída.
5. [SCRIBE]: atualizem STATE.md, BACKLOG.md e SESSION-LOG.md, façam só o commit local (sem push) e gerem o novo ./next-step.md.
```
