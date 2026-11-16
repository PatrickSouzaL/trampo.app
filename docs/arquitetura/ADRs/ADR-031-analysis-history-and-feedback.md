---
tipo: adr
id: ADR-031
titulo: "Gravar as análises e o feedback (F1-API-06): a linha mínima gravada depois do relatório, sem atrasar o stream e sem derrubar a análise; o banco força o relógio e um teto por usuário; retenção de 90 dias por função agendada no pg_cron; a rota de feedback com o dono pelo principal e a FK composta; e a exportação paginada por dentro da API"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC], sem veto, 15 condições). O consentimento do histórico é do humano (HITL-048): o código se constrói, e a ligação no composeApp espera a resposta. A migration no projeto real é HITL."
data: 2026-11-16
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "supabase/migrations, packages/contracts (limits, api, account), apps/api (rota de análise, gravador, cliente do PostgREST, persistência, rota de feedback, CORS, limites, telemetria, exportação), apps/web-portal (o teto da exportação)"
substitui: null
relacionados: ["[ADR-017-analyze-job-and-stream](ADR-017-analyze-job-and-stream.md)", "[ADR-018-postgres-schema-rls-and-criteria](ADR-018-postgres-schema-rls-and-criteria.md)", "[ADR-029-account-export-and-delete](ADR-029-account-export-and-delete.md)", "[ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md)", "[ADR-010-log-allowlist-and-telemetry](ADR-010-log-allowlist-and-telemetry.md)", "[ADR-007-api-edge](ADR-007-api-edge.md)", "[ADR-021-criteria-routes](ADR-021-criteria-routes.md)", "[ADR-025-side-panel-ui](ADR-025-side-panel-ui.md)", "[threat-model](../threat-model.md)", "*BACKLOG §F1-API-06*", "*HITL-QUEUE §HITL-048*"]
---

# ADR-031: Gravar as análises e o feedback (F1-API-06)

## 1. Contexto

As tabelas `analyses` e `analysis_feedback` existem desde a F1-DB-01 ([ADR-018-postgres-schema-rls-and-criteria](ADR-018-postgres-schema-rls-and-criteria.md) D2), com RLS forçada, a FK composta do feedback e os grants de `insert` para `authenticated`. Nenhum código as grava; a exportação da conta já as lê, com corte em 500 linhas ([ADR-029-account-export-and-delete](ADR-029-account-export-and-delete.md) D4). O ADR-018 D2 promete a retenção de 90 dias "na mesma entrega que começar a gravar".

### 1.1 Fatos conferidos antes do desenho
**Pelo código (agente de leitura, sessão 33):**
- **A1.** O `AnalyzeJob` não recebe o `userId` (minimização, ADR-017 D1); o `analysisId` é um UUID v4 do `IdGenerator` (`crypto.randomUUID`); o `requestId` é do cliente e serve só à idempotência da cota (o mesmo `requestId` repetido roda a análise de novo, gera outro `analysisId` e não gasta cota).
- **A2.** A rota escreve o `result` e fecha o stream no `finally`; o `SseStream.write` devolve `false` depois do fim ou com o cliente fora. O principal e o Bearer estão na rota, não no job.
- **A3.** O cliente do PostgREST tem `select`, `upsert` (sempre `merge-duplicates`, sem ler a resposta) e `rpc`; as listas de tabelas e colunas graváveis são fechadas, e só a `user_criteria` é gravável hoje.
- **A4.** O `EXTENSION_ROUTES` compara o caminho cru exato; uma rota com parâmetro não casa com ele.
- **A5.** O `ApiErrorCodeSchema` não tem "não encontrado"; rota inexistente já responde 404 com `PROIBIDO` (`build-app.ts`).
- **A6.** O painel da extensão já mostra o `analysisId` ("Código da análise").
- **A7.** Cota diária de 50 análises por usuário (dia de Brasília); classes de limite `padrao`, `analise`, `criterios` e `conta`.

**Medidos na pilha local (Docker, CLI 2.120.0, PostgREST e Postgres de verdade; `probe_f1api06.mjs` no scratchpad da sessão 33):**
- **M1.** O insert com o `id` de outra conta dá **409 `23505`** e não sobrescreve nada.
- **M2.** **O `created_at` mandado pelo cliente é aceito** (um `2099-01-01` passou com 201): hoje, quem tem o próprio JWT e a *publishable* escaparia da retenção.
- **M3.** O upsert do feedback por `on_conflict=analysis_id` dá 201 na inserção e 200 na atualização.
- **M4.** O upsert de B na análise de A **que já tem feedback** dá **403 `42501`** (o ramo `DO UPDATE` bate na RLS), e a linha de A fica intacta; na análise de A **sem feedback**, ou num id que não existe, dá **409 `23503`** (a FK composta). A diferença entre os dois é um oráculo de existência.
- **M5.** Um gatilho que levanta `PT429` vira **HTTP 429** no PostgREST; `P0001` vira 400 e `54000`, 500.
- **M6.** O papel `postgres` tem `BYPASSRLS` (e não é superusuário); o `service_role` também tem. O `pg_cron` 1.6.4 está em `shared_preload_libraries`.

**Pela documentação do Supabase (MCP `search_docs`, 2026-11-16):** a plataforma hospedada suporta o `pg_cron` ("Supabase Cron"), instalado pelo painel (Integrations → Cron) ou por `create extension pg_cron with schema pg_catalog`; os jobs ficam em `cron.job` e as execuções em `cron.job_run_details`; a recomendação é até 8 jobs simultâneos e até 10 minutos por job.

## 2. Decisões

### D1. Gravar a análise: na rota, depois do `result`, por um gravador da camada de aplicação
- **Onde:** um caso de uso novo, `AnalysisRecorder` (`application/analysis/analysis-recorder.ts`), chamado pela rota `POST /v1/analyze` **depois** de o `result` ter sido entregue ao stream (`sse.write` devolveu `true`). O `AnalyzeJob` não muda e continua sem o `userId` (D1 do ADR-017): quem conhece o dono é a rota.
- **Sem atrasar o stream:** a rota chama `void recorder.record(subject, report)`; o gravador tem prazo próprio (2.000 ms), **nunca rejeita** e nunca toca no relatório. O `finally` fecha o stream na mesma hora.
- **Só o que saiu:** se o `write` do `result` devolveu `false` (o cliente saiu), nada é gravado: o usuário não viu o `analysisId` e não daria feedback.
- **O id:** o **`analysisId` do servidor**, nunca o `requestId` do cliente. O insert é simples (sem upsert); a tabela não tem grant de `update`; um id repetido dá 409 `23505` (M1) e não sobrescreve nada. O cliente não escolhe id nenhum.
- **A linha:** `id`, `user_id` (do principal), `decision_path`, `verdict` e `score`. **Nunca:** texto, título, empresa, `textHash`, `requestId`, plataforma, versões ou provedor (T38; ADR-018 D2). O `created_at` é do banco (D2).
- **Falha:** a gravação que falha (prazo, 4xx, 429 do teto, 5xx, rede) vira um evento de telemetria e uma linha de log sem campo (`analise_gravacao_falhou`). A análise já saiu e não muda.
- **O `requestId` repetido** (a extensão reenvia depois de um 401) gera outra análise e outra linha. É raro, cabe no teto (D2) e reflete o que o usuário viu.

### D2. O banco força o relógio e um teto por usuário (migration nova)
O usuário tem o próprio JWT e a *publishable* é pública: tudo o que a API grava com o JWT dele, ele também pode gravar direto no PostgREST (o ADR-018 §3 já registrava "o dono pode inserir `analyses` falsas para si"). Por isso as regras moram no banco, não na API:
- **Gatilho `before insert` em `analyses`:** força `created_at := now()` (fecha o M2: ninguém escapa da retenção com uma data futura) e aplica o **teto de 100 linhas por usuário em 24 horas corridas**, com um `pg_advisory_xact_lock` por usuário (o teto é exato também sob concorrência). Acima do teto: `PT429` (M5), mensagem fixa `analises_limite_diario`.
- **Por que 100:** o dobro da cota diária de 50 (o dia de Brasília permite 50 às 23:59 e mais 50 às 00:00). O uso legítimo pela API nunca passa; o abuso direto fica limitado a 100 por dia, ou cerca de 9.100 linhas na janela de retenção.
- **Gatilho `before insert or update` em `analysis_feedback`:** força `updated_at := now()`.
- **Índices:** `analyses (user_id, created_at)` (o teto e a exportação) e `analyses (created_at)` (a retenção).
- **As constantes vivem em dois lugares:** a migration e o contrato (`ANALYSES_DAILY_ROW_CAP = 100`, `ANALYSES_RETENTION_DAYS = 90`). O `test:db` prende as duas contra o contrato, e um teste da API prende o teto em pelo menos o dobro da cota diária.

### D3. Retenção de 90 dias: uma função agendada no `pg_cron`, sem chave de alto privilégio
- **A função:** `public.purge_expired_analyses(p_limit integer default 5000) returns integer`, `security invoker`, `search_path` vazio, dona `postgres`. Apaga as análises com `created_at < now() - interval '90 days'` (estritamente mais velhas que 90 dias), das mais velhas para as mais novas, no máximo `p_limit` por execução (1 a 50.000; fora disso, erro), e devolve quantas apagou. O feedback vai junto pela FK composta (`on delete cascade`).
- **Quem roda:** o `pg_cron`, como `postgres` (que tem `BYPASSRLS`, M6). **Ninguém mais executa:** `revoke all` de `public`, `anon`, `authenticated` e `service_role`. Nenhuma chave *secret* e nenhum `service_role` (a emenda do ADR-018 §3.3 que previa o grant ao `service_role` cai).
- **O agendamento na própria migration:** `create extension if not exists pg_cron with schema pg_catalog` e `cron.schedule('trampo-retencao-analises', '17 * * * *', 'select public.purge_expired_analyses(5000)')`, de hora em hora (até 120 mil linhas por dia). O `cron.schedule` com nome substitui o job de mesmo nome, então reaplicar não duplica.
- **Prova no job `db`:** a borda exata (90 dias mais 1 segundo apaga; 90 dias menos 1 segundo fica), o limite por execução, o *cascade* do feedback, a ACL da função e o job no `cron.job` com o horário e o comando exatos.
- **No projeto real:** a migration é aplicada por HITL (o SQL Editor), como as anteriores; o runbook confere o `cron.job` e, um dia depois, o `cron.job_run_details`.

### D4. A rota de feedback: `POST /v1/analyses/:analysisId/feedback`
- **Contrato:** a constante da rota e o `analysisFeedbackPath(id)`, o `AnalysisFeedbackParamsSchema` (`analysisId` UUID) e o `ANALYSIS_FEEDBACK_BODY_MAX_BYTES = 256`; o corpo é o `AnalysisFeedbackRequestSchema` que já existe.
- **Dono:** só do principal (`sub` do token); o corpo não tem `user_id`. O upsert por `on_conflict=analysis_id`, com as colunas `analysis_id`, `user_id`, `agreement` e `reason` (o `updated_at` é do banco, D2).
- **Duas barreiras no banco:** a FK composta (`analysis_id`, `user_id`) só aceita análise do mesmo dono; a RLS recusa tocar na linha de outro.
- **Respostas:** 204 na gravação (201 ou 200 do PostgREST); **404 `PROIBIDO`** para a análise inexistente **e** para a de outro dono (o 409 `23503` e o 403 `42501` viram a mesma resposta, sem o oráculo do M4; o mesmo par código e status da rota inexistente, A5, e nenhum código novo no contrato); 400 para corpo ou parâmetro fora do schema; 413 acima de 256 bytes; 503 para o resto (o upsert é idempotente: repetir é seguro).
- **Classe de limite nova `feedback`:** 10 por minuto por usuário e 30 por IP (uma escrita curta; emenda ao [ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md) D4).
- **Quem alcança:** a extensão, porque o botão fica no Side Panel ao lado do "Código da análise" (A6). O `EXTENSION_ROUTES` passa a aceitar a rota pelo **padrão roteado** (`POST /v1/analyses/:analysisId/feedback`) **e** o caminho cru tem de casar com `^/v1/analyses/[0-9a-f-]{36}/feedback$` (A4; um caminho com `..`, `%2F` ou barra dupla fica de fora). O portal alcança servidor a servidor (sem `Origin`). O botão em si é uma trilha da extensão (*BACKLOG §F1-EXT-10*), com emenda ao [ADR-025-side-panel-ui](ADR-025-side-panel-ui.md).
- **Log e telemetria:** nenhum log no sucesso; `feedback_gravacao_indisponivel` no 503; o evento `analysis_feedback` com o `agreement` (D7).

### D5. Exportação paginada por dentro da API (F1-PORTAL-05 item 2)
- **Um arquivo só, montado no servidor da API:** o `AccountService` lê as duas listas em páginas de 1.000 linhas (o `max_rows` do PostgREST), por **cursor de chave** (`created_at`, `id`) do mais novo para o mais velho (`analyses`), e (`updated_at`, `analysis_id`) no feedback, até 10 páginas por lista.
- **O teto sobe de 500 para 10.000 linhas por lista** (`ACCOUNT_EXPORT_MAX_ROWS`), acima do máximo possível com a retenção e o teto do D2 (cerca de 9.100); a marca `…Truncated` continua no arquivo para o caso impossível.
- **O documento não muda de forma**, então o `schemaVersion` continua 1: só o teto muda, e todos os leitores estão no monorepo.
- **Prazos e tetos novos:** 256 KiB por página no cliente do PostgREST da conta; 10 s no `AccountService`; no portal, 4 MiB e 15 s para a exportação. A rota continua na classe `conta` (uma chamada só do portal).

### D6. Consentimento do histórico: decisão do humano (*HITL-QUEUE §HITL-048*)
O requisito diz que o resultado da análise é "**Opcional, com consentimento**", para histórico e feedback (*ideia_projeto* §5), e a pergunta aberta 12 lembra que o histórico entra no escopo da LGPD. **Duas opções:**
- **(A) Consentimento por usuário (recomendada):** uma tabela `user_settings` (`user_id`, `analysis_history`, padrão desligado) com RLS; a página `/conta/dados` ganha a opção "Guardar o meu histórico por 90 dias"; o gravador só grava com a opção ligada (uma leitura a mais, depois do `result`, sem atrasar nada). Desligar a opção apaga o histórico (função `SECURITY DEFINER` do próprio usuário, no molde da `delete_own_account`).
- **(B) Ligado para todos na Fase 1:** o projeto é pessoal; a gravação começa ligada e o consentimento por usuário entra antes do beta (portão da Fase 2).
- **Até a resposta:** o gravador, o cliente, a persistência e a rota de feedback se constroem e se testam; **o `composeApp` não liga o gravador** (a opção `recorder` do `buildApp` fica nula), no molde da cadeia de LLM, que esperou o S-1 para ser ligada. Nenhuma linha é gravada em produção antes do HITL-048.

### D7. Telemetria e log (emenda ao [ADR-010-log-allowlist-and-telemetry](ADR-010-log-allowlist-and-telemetry.md) D2, D5 e D6)
- **Eventos novos:** `analysis_record` com `outcome` (`gravada`, `recusada`, `limite`, `indisponivel`) → métrica `analysis_record_total{outcome}`; `analysis_feedback` com `agreement` → `analysis_feedback_total{agreement}`. Nenhum identificador, nota ou veredito.
- **Log:** `analise_gravacao_falhou` (warn, sem campo) e `feedback_gravacao_indisponivel` (warn, sem campo).

### D8. O que NÃO entra
- A invalidação do cache por "discordo" recorrente (*BACKLOG §F1-OBS-02*).
- **O sinal "discordo" por plataforma e por versão do prompt** (*ideia_projeto* §7): a linha mínima não tem plataforma nem versão. Guardar as duas (dados não pessoais, mas comportamentais) é um ADR próprio (*BACKLOG §F1-OBS-04*).
- O botão na extensão (*BACKLOG §F1-EXT-10*) e o histórico no portal (desenho próprio).
- O e-mail e o provedor na exportação (F1-PORTAL-05 item 1).

## 3. Auditoria do `[APPSEC]` (sem veto, 15 condições)

**Fronteiras:** TB4 (extensão → API: a rota de feedback), TB5 (portal → API), TB8 (API → PostgREST com o JWT do usuário) e o próprio banco (gatilhos, função agendada).
**Ameaças:** **T38** (IDOR e inundação no feedback), **T55** (nova: o dono abusando da gravação direta no PostgREST), T7 (abuso de recurso), T30 (falha que vira promessa), T52 (o *cascade* da exclusão) e T34 (retenção).

**Condições (cada uma com teste):**
1. **A linha mínima:** o insert só leva as 5 colunas da lista fechada do cliente (nenhuma chave do relatório além delas; teste com canário no texto, no título e no `requestId`).
2. **O id é do servidor:** o gravador usa o `report.analysisId`; um `id` repetido dá 409 e não sobrescreve (job `db`).
3. **Nunca derruba a análise:** o gravador que lança, rejeita, trava ou devolve lixo não muda o stream nem o relatório; nada é gravado se o `result` não saiu.
4. **O relógio é do banco:** um `created_at` futuro mandado direto vira `now()` (job `db`); o `updated_at` do feedback também.
5. **O teto exato:** a 100ª linha em 24 h passa e a 101ª dá 429 `PT429`; outro usuário não é afetado; a linha de 24 h e 1 s não conta (job `db`).
6. **A retenção na borda exata** (90 dias e 1 s apaga, 90 dias menos 1 s fica), o limite por execução e o *cascade* do feedback (job `db`).
7. **Ninguém além do `postgres` executa a função de retenção** (`anon`, `authenticated` e `service_role` com 42501; ACL no catálogo).
8. **O job agendado** existe com o nome, o horário e o comando exatos (job `db`, pelo `cron.job`).
9. **O feedback só na própria análise:** B na análise de A (com e sem feedback) e num id inexistente recebe a **mesma** resposta (404 `PROIBIDO`), e a linha de A não muda (rota contra o PostgREST simulado e job `db` contra o real).
10. **O dono só do principal:** um `user_id` no corpo é recusado (o schema é estrito); o parâmetro fora de UUID é 400 sem tocar no banco.
11. **CORS:** a extensão alcança só o caminho cru que casa com a regex; `..`, `%2F` e barra dupla dão 403; as rotas da conta continuam fora do alcance da extensão (o M-15 do `mut07g.py` de novo).
12. **Classe `feedback`** com os números presos por teste; o 413 acima de 256 bytes sem parse.
13. **A exportação inteira:** com 2.500 linhas plantadas, o arquivo traz as 2.500, na ordem, sem repetição nem buraco entre as páginas (job `db` contra o PostgREST real, que tem o `max_rows`); falha de qualquer página dá 503, sem documento parcial.
14. **SR-12:** nenhum `sub`, `analysisId`, nota ou veredito em log ou métrica.
15. **Mutação dirigida** por camada antes do push (banco D-, API R-, rota F-) e **nada gravado em produção antes do HITL-048**.

**Residuais (§9 do [threat-model](../threat-model.md)):** o dono ainda grava análises falsas **para si** (até 100 por dia; o feedback agregado trata a linha como declarada pelo usuário); o teto é por janela de 24 h corridas, não pelo dia de Brasília; até o HITL da migration, a retenção não roda no projeto real (e nada é gravado lá até o HITL-048).

## 4. Plano de testes (`[QA_EVALS]`)
- **Contrato:** as constantes novas, o schema dos parâmetros, o caminho do feedback e o teto da exportação, 100% nas 4 métricas.
- **Banco (`analyses.db.test.ts`, job `db`):** as condições 2, 4 a 8, 9 (pelo PostgREST real) e 13; as constantes contra o contrato; o catálogo dos gatilhos e da função; o *cascade* da exclusão da conta com as linhas novas (o `account.db.test.ts` continua verde).
- **API:** unidade do gravador, do cliente (o `insert` e a classificação do upsert), da persistência e da rota (pelo `buildApp`), 100% nas 4 métricas; socket real contra o PostgREST simulado (que ganha o `POST` em `analyses` e `analysis_feedback`, com os códigos medidos no M1 a M5); o boot com as peças reais (o `composeApp` sem o gravador ligado).
- **E2E da extensão:** só quando o painel mudar (*BACKLOG §F1-EXT-10*).
- **Mutação:** `mut_analyses_db.py` (D-) contra a pilha local; `mut_api06.py` (R- e F-) pela unidade.

## 5. Partição em commits (fatias, uma por commit)
1. **Contrato** (as constantes, o schema do parâmetro e o caminho).
2. **Banco:** a migration (gatilhos, índices, função de retenção e o job), o `analyses.db.test.ts` e o catálogo.
3. **API, gravação:** o `insert` do cliente, a persistência `SupabaseAnalysisLog`, o `AnalysisRecorder`, o evento `analysis_record` e a opção `recorder` da rota (desligada no `composeApp`).
4. **API, feedback:** a classificação do upsert, a classe `feedback`, a rota, o CORS por padrão e o evento `analysis_feedback`.
5. **Exportação paginada:** o cursor no `AccountService`, o teto novo e o portal.
6. **Depois do HITL-048:** o consentimento (se a opção A) e a ligação no `composeApp`.

## 6. Alternativas consideradas
- **Gravar dentro do `AnalyzeJob`:** recusada; o job ganharia o `userId` e o Bearer (minimização do ADR-017 D1).
- **O `requestId` como chave:** recusada; o cliente escolheria o id da linha.
- **Gravar pelo servidor com chave de alto privilégio** (para o dono não gravar direto): recusada; o projeto não tem chave *secret* em uso (ADR-029 D1), e o teto no banco limita o abuso sem ela.
- **Retenção pela API num horário:** recusada; a API só tem o JWT de cada usuário, e um usuário que não volta nunca teria as linhas apagadas.
- **Paginação exposta ao portal** (um cursor na URL): recusada; cada página gastaria uma vaga da classe `conta` (3 por minuto), e o arquivo seria montado no portal.
- **Um código `NAO_ENCONTRADO` novo:** recusada; obrigaria a extensão a ganhar texto (cuidado 38). O 404 `PROIBIDO` já é o par da rota inexistente.

## 7. Emendas da implementação
_(a implementação registra aqui)_
