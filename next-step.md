# Próximo passo: o PR do 13º ciclo, a F1-API-06 (gravação, feedback e exportação paginada), a F1-EXT-09 e a borda do S-5

> **Última entrega, sessão 33 (2026-11-16):** o 12º ciclo e o HITL-044 e o HITL-045 estão fechados. A F1-PORTAL-03 e a F1-PORTAL-04 estão fechadas também no projeto real. Entraram no papel:
> - o roteiro do spike S-3 (runbook `spike-s3`);
> - a hospedagem (ADR-030, `proposto`);
> - o histórico de análises (ADR-031).
>
> A F1-API-06 começou no código: `31f7a9b` (contrato, C- 7/7) e `d26c949` (o banco: relógio, teto por usuário, retenção de 90 dias no `pg_cron`; `test:db` 198/198 na estação; D- 24/24). Achado: a extensão recusa todo `ApiError` da API real (F1-EXT-09).
>
> Detalhes no `SESSION-LOG`; trilhas e cuidados em `../base/00-orquestracao/TRILHAS.md` (cuidado 39 novo).

## Pendências do humano

- **HITL-037, 13º ciclo:** abrir o PR do `spike/s1-extraction` para o `master`, conferir os 4 checks e mergear com merge commit. O job `db` desse PR roda pela 1ª vez a migration nova e o `analyses.db.test.ts` (esperado: 198 passed). Runbook `../base/03-infra-runbook/publicar-branch-pr.md` (§4 a §6).
- **HITL-048 (decisão):** consentimento do histórico de análises: (A) uma opção por usuário em "Seus dados", desligada por padrão (recomendada), ou (B) ligada para todos na Fase 1. Responda "HITL-048: A" ou "HITL-048: B".
- **HITL-049 (depois do job `db` verde):** aplicar a migration das análises no projeto real e, no dia seguinte, conferir as execuções do job. Runbook `../base/03-infra-runbook/analises-retencao.md`.
- **HITL-046 (quando puder):** os blocos 0 a D do spike S-3. O bloco 0 primeiro: ele lê o estado dos novos cadastros (divergência do HITL-045). Runbook `../base/03-infra-runbook/spike-s3.md`.
- **HITL-047 (quando puder):** as partes 1 e 2 da hospedagem (decisões, contas com 2FA, domínio e zona da Cloudflare, sem deploy). Runbook `../base/03-infra-runbook/hospedagem-s5.md`.

Responda só com sim/não, conforme/diverge, avisos, números e as escolhas pedidas.

## Próximo prompt

```text
Equipe, sigam em ciclo estrito de DevSecOps (AGENTS.md), em batelada de etapas com checkpoint no STATE.md entre elas e um commit atômico por etapa (ou por fatia, quando a etapa tiver fatias). Trilhas, nesta ordem:
(0) o PR do 13º ciclo, se existir, e as respostas dos HITL-046, 047, 048 e 049, se vierem neste prompt;
(1) a F1-API-06 fatia 3 (a gravação da análise na API, desligada no composeApp);
(2) a fatia 4 (a rota de feedback);
(3) a fatia 5 (a exportação paginada);
(4) a F1-EXT-09 (o requestId do ApiError entre a API e a extensão), do desenho ao E2E;
(5) se a janela permitir, a S-5a (a borda nova da API do ADR-030);
(6) se ainda sobrar janela, o desenho do histórico no portal (e do consentimento, se o HITL-048 vier com a opção A).

Restrições da sessão:
- Nada gasta cota de LLM nem chama o Supabase real. A API é provada contra o PostgREST e o Redis simulados, em socket real; o portal, contra o GoTrue e a API simulados; a extensão, no Edge com o IdP e o BFF falsos; o banco, contra a pilha local (Docker com a CLI 2.120.0 conferida pelo checksums.txt). A prova que vale é o job db do PR. Tudo que tocar o projeto real é HITL.
- Push do spike/s1-extraction só se este prompt ou o humano no chat autorizar. Quando autorizado, no fim de cada etapa, depois do git fetch e do portão (gitleaks 8.30.1 conferido pelo checksums.txt e a varredura pública).
- O repositório é PÚBLICO: nenhum caminho local, e-mail, host real ou ID de scratchpad em arquivo rastreado nem em mensagem de commit (cuidado 35). Fixture com cara de token nasce em tempo de execução desde o 1º commit (cuidados 14 e 38).
- Se a janela de contexto apertar, parem no fim de uma etapa, gravem o STATE e gerem o next-step com o que falta (AGENTS §4.4).

FASE 1 [ORCHESTRATOR]
- Leiam o STATE.md (bloco da sessão 33), o HITL-QUEUE.md (HITL-037 no 13º ciclo, e 046 a 049) e o TRILHAS.md (tabela e cuidados 7, 14, 24, 26, 33, 35, 36, 37, 38 e 39). Rodem git fetch, gh pr list --state all --limit 3 e gh pr view <n> --json state,mergeCommit,headRefOid,statusCheckRollup do PR do 13º ciclo. Registrem a divergência se o prompt e o GitHub discordarem: nunca fechem um ciclo pela declaração.
- Copiem as ferramentas do scratchpad da sessão 33 e confiram os zips do gitleaks e da CLI pelo checksums.txt. Os scripts de mutação recebem a raiz por --root=. As ferramentas:
  - mutlib.py, edit_lib.py, apply_blocks.py, prepush.sh, scan_public.py, publish_docs.py, regen_contratos.py e check_map.py;
  - dbenv.sh, o ambiente do test:db, com o psql nativo que as sessões 32 e 33 usaram;
  - os mut_*.py da sessão 32 e os novos mut_api06_contract.py e mut_analyses_db.py;
  - probe_f1api06.mjs, o gitleaks e o supacli.
- Respostas que podem vir neste prompt:
  - HITL-048: registrem no ADR-031 §7. Com a opção (A), a fatia 6 ganha uma tabela user_settings com RLS, a opção na /conta/dados e uma função do próprio usuário que apaga o histórico ao desligar; desenhem isso numa emenda antes do código. Com a (B), a fatia 6 é só a ligação, depois do HITL-049.
  - HITL-049: registrem no ADR-031 §7. Fechem a condição do projeto real e anotem as execuções do job. Qualquer "diverge" volta ao [ARCHITECT] e ao [APPSEC] antes da ligação.
  - HITL-046, por bloco: registrem os números no spike-metrics §4.2, com o veredito de cada P e as consequências do runbook. Os casos que voltam a desenho:
    - P21 com error_code presente: o ADR-004 D7 volta;
    - P19 com o 1º 429 antes de 15: o D8 e o limitador do portal voltam;
    - P18 com 200: o ADR-026 volta ao [APPSEC];
    - cadastros ligados sem motivo: o humano desliga, e a §9 do threat-model registra;
    - latência: compare L1 a L5 e alimente a decisão de região do ADR-030.
  - HITL-047: registrem as decisões no ADR-030 e reavaliem o D1 se o provedor mudar.
- Leiam os ADRs:
  - o ADR-031 inteiro (D1 a D8, §3, §5 e §7.1);
  - o ADR-030 (D2, D6, §3 e §5);
  - o ADR-017 (D1, D6, §3.2 e a emenda da sessão 33);
  - o ADR-025 (D10);
  - o ADR-014 (D4 e as emendas);
  - o ADR-010 (D2, D5 e D6, e as emendas da sessão 33);
  - o ADR-007 (D5, D6 e as emendas);
  - o ADR-021 (o molde das rotas de usuário);
  - o ADR-029 (D4 e §6.1).
- Do threat-model, leiam T38, T53, T55, SR-12, SR-15, SR-28 e a §9.
- Leiam o código antes de propor:
  - na API: presentation/routes (analyze.ts, account.ts e criteria.ts), presentation/streaming/sse-stream.ts, build-app.ts, presentation/edge/cors.ts, presentation/logging/log-policy.ts, application/ports/telemetry.ts, application/telemetry/extraction-telemetry.ts (o METRIC_CATALOG e o telemetryMetricSamples), application/shared/with-deadline.ts, infrastructure/supabase/postgrest-user-client.ts, infrastructure/persistence (os dois adapters), application/account/account-service.ts, composition/compose-app.ts e test/infrastructure/fakes/fake-postgrest.ts;
  - na extensão: src/api/analysis-service.ts (o serverError), src/api/api-client.ts (a lista ROUTES) e test/e2e/support/fake-auth.ts (o BFF falso).

ETAPA 0: PR do 13º ciclo [QA_EVALS] + [DEV] (só se o PR existir)
- Rodem gh pr checks <n> --watch.
- Verde: registrem no STATE e no HITL-037; o HITL-049 fica liberado.
- Vermelho no db: leiam com gh run view --log-failed e corrijam só o teste ou a migration, nunca afrouxando a asserção.
- Pontos frágeis conhecidos:
  - o create extension pg_cron with schema pg_catalog e o cron.schedule na pilha do runner (o mesmo papel postgres da estação?);
  - o 429 do PT429;
  - o teste de concorrência (20 inserts simultâneos com 90 na janela gravam exatamente 10);
  - o username do cron.job.
- Se o runner não tiver o pg_cron pré-carregado, o [ARCHITECT] decide entre tirar o agendamento da migration (HITL no real) ou exigir a extensão. Nunca pulem o teste.

ETAPA 1: F1-API-06 fatia 3, a gravação [DEV] + [QA_EVALS] (TDD estrito; ADR-031 D1 e D7)
- Cliente do PostgREST: um insert(table, { columns, row }, token, signal) com a lista fechada PostgrestInsertColumns:
  - só analyses: id, user_id, decision_path, verdict e score;
  - Prefer return=minimal, sem on_conflict;
  - corpo com só as colunas declaradas e o teto de 32 KiB;
  - redirect error e o corpo da resposta nunca lido.
- A classificação só pelo status:
  - 201 → gravada;
  - 429 → limite;
  - 400, 403 e 409 → recusada;
  - o resto (5xx, prazo, rede, redirecionamento) → indisponivel.
- Persistência e caso de uso:
  - a porta AnalysisLog em application/ports e o adapter SupabaseAnalysisLog em infrastructure/persistence;
  - o AnalysisRecorder em application/analysis: prazo de 2.000 ms pelo withDeadline, nunca rejeita, e registra o evento analysis_record com o outcome.
- Telemetria (a união é fechada; a emenda do ADR-010 já está no desenho):
  - o evento entra no TelemetryEventSchema;
  - a métrica analysis_record_total{outcome} entra no METRIC_CATALOG e no telemetryMetricSamples;
  - a mensagem analise_gravacao_falhou (warn, sem campo) entra no LOG_MESSAGES.
- Rota:
  - a opção recorder dentro de analysis no buildApp, nula por padrão;
  - grava só quando o sse.write do result devolveu true, com void e sem atrasar o finally;
  - o subject é o mesmo do preHandler dos critérios.
- O composeApp NÃO liga o gravador; um teste prende isso até o HITL-048 e o HITL-049.
- PostgREST simulado: o POST em /rest/v1/analyses com os códigos medidos no ADR-031 (201, 409 23505, 429 PT429, 403 42501).
- Testes:
  - antes do código, falhando pelo motivo certo;
  - a condição 1 (canários no texto, no título e no requestId que nunca chegam ao corpo do insert);
  - a condição 3 (o gravador que lança, rejeita, trava ou devolve lixo não muda o stream; nada gravado se o cliente saiu antes do result);
  - a 14 (SR-12);
  - socket real contra o PostgREST simulado;
  - o boot com as peças reais;
  - 100% nas 4 métricas.
- Um teste da API prende ANALYSES_DAILY_ROW_CAP >= 2 × DAILY_QUOTA_POLICY.analysesPerDay.
- Mutação mut_api06.py, grupo R-. Mutantes mínimos:
  - gravar antes do result;
  - gravar com o write false;
  - await no record antes do end;
  - o requestId como id;
  - uma coluna a mais;
  - ler o corpo da resposta;
  - o 200 como gravada;
  - sem o prazo;
  - o outcome errado na telemetria;
  - o composeApp ligando o gravador.

ETAPA 2: F1-API-06 fatia 4, a rota de feedback [DEV] + [APPSEC] + [QA_EVALS] (ADR-031 D4)
- POST /v1/analyses/:analysisId/feedback:
  - o params e o body pelos schemas do contrato;
  - bodyLimit de ANALYSIS_FEEDBACK_BODY_MAX_BYTES;
  - o dono só do principal;
  - o upsert em analysis_feedback, com as colunas analysis_id, user_id, agreement e reason (o updated_at é do banco).
- Respostas:
  - 204 no 201 ou no 200;
  - 404 PROIBIDO para o 409 23503 e para o 403 42501, as duas iguais, sem oráculo;
  - 400 para corpo ou parâmetro inválido;
  - 413 acima do teto;
  - 503 para o resto, com o log feedback_gravacao_indisponivel;
  - no-store sempre.
- O upsert de hoje não distingue as falhas. Decidam se ganha um resultado classificado só pelo status, sem tocar no caminho dos critérios (prendam com teste que o criteria-write continua igual).
- A classe nova feedback (10/30): ADR-014 e o teste que prende a política.
- CORS: o EXTENSION_ROUTES passa a aceitar a rota pelo padrão roteado E o caminho cru pela regex ^/v1/analyses/[0-9a-f-]{36}/feedback$. Provem por socket real que .., %2F, a barra dupla e o caminho em maiúsculas dão 403, e que as rotas da conta continuam fora do alcance da extensão. Rodem de novo o M-15 do mut07g.py.
- O evento analysis_feedback (agreement) e a métrica analysis_feedback_total.
- PostgREST simulado com o upsert do feedback e os códigos medidos.
- Mutação: o grupo F- do mut_api06.py, com o oráculo reaberto, o dono do corpo, a regex frouxa, a classe errada e o 503 como 204.

ETAPA 3: F1-API-06 fatia 5, a exportação paginada [DEV] + [QA_EVALS] (ADR-031 D5)
- Contrato: o ACCOUNT_EXPORT_MAX_ROWS passa de 500 para 10.000 (o contratos-zod é regerado, com a linha da §9). O schemaVersion fica 1, como decide o ADR-031 D5.
- AccountService:
  - páginas de 1.000 por cursor de chave: (created_at, id) desc nas análises e (updated_at, analysis_id) desc no feedback, com o filtro or/and do PostgREST na borda exata da chave composta;
  - até 10 páginas por lista e o truncated no caso impossível;
  - 10 s no total e 256 KiB por página;
  - falha de qualquer página dá 503, sem documento parcial.
- Portal: 4 MiB e 15 s no exportAccount.
- test:db:
  - 2.500 linhas plantadas por SQL. O teto de 100 em 24 h vale também para o postgres: plante em lotes de 100 e envelheça cada lote (horas ou dias, sempre menos de 90) antes do seguinte;
  - o arquivo traz as 2.500, na ordem, sem repetição nem buraco entre as páginas, contra o PostgREST real com o max_rows de 1000;
  - um caso com duas linhas no mesmo created_at na fronteira de uma página (o desempate pelo id).
- Rodem de novo o mut_account_api.py e o mut_portal03.py, e o E2E do portal em 3 rodadas (o download).

ETAPA 4: F1-EXT-09, o requestId do ApiError [ARCHITECT] + [APPSEC], depois [DEV] + [QA_EVALS]
- Desenho primeiro, como emenda ao ADR-017 §3.2 e ao ADR-025 D10, com o [APPSEC]. As opções:
  - (a) a API devolve o requestId do pedido quando o corpo já foi lido e null antes disso; o id do servidor fica só no log, ou num cabeçalho;
  - (b) a extensão aceita qualquer UUID, porque a geração já descarta a resposta velha;
  - (c) o contrato ganha os dois campos.
- Para cada opção, avaliem o que um proxy ou BFF hostil ganharia (T30, e a §9 do JSON alheio).
- O BFF falso do E2E da extensão passa a imitar a API real.
- Um teste de contrato entre os dois lados, sem import cruzado proibido pelo depcruise. Por exemplo, uma tabela de ApiError no @trampo/contracts que o teste da API gera pelo apiError e o da extensão lê pelo serverError.
- Provem que o 401 da API real (simulada fiel) dispara a renovação e o reenvio com o mesmo requestId, e que o 409 de critérios e o 429 mostram o texto certo.
- E2E da extensão inteiro no Edge, 3 rodadas, e a mutação dirigida (o serverError e o apiError).

ETAPA 5 (só se sobrar janela): S-5a, a borda nova da API [DEV] + [APPSEC] (ADR-030 D2, condições 1 a 3 e 5)
- API_CLIENT_IP_SOURCE (socket | cloudflare) e o anel EDGE_AUTH_KEYS, com o boot recusando as combinações incoerentes sem ecoar valor.
- O X-Trampo-Borda conferido em tempo constante antes do CORS, do JWT, do corpo e do rate limit, com o GET /health como única exceção.
- O IP só do CF-Connecting-IP com a borda provada (net.isIP; fora da forma, o balde único).
- O boot recusa a SUPABASE_SECRET_KEY presente, e ela sai do .env.example.
- Um proxy reverso local em Node em test/support, para os testes de socket real.
- Emendas ao ADR-007 D5 e ao ADR-014 D10, e a mutação dirigida.

ETAPA 6 (só se ainda sobrar janela): o histórico no portal, só no desenho
- A página /conta/analises (Server Component, sem JS próprio), lendo pela API uma rota nova de listagem paginada por cursor.
- O que mostrar: a data, a nota, o veredito e o caminho; nunca o texto da vaga, que não é guardado.
- O feedback pelo portal, pela rota da fatia 4, servidor a servidor.
- Com o HITL-048 em (A), a opção do consentimento e o "apagar o meu histórico".
- Emenda do ADR-031 ou ADR novo.

PORTÃO E FASE 4 [SCRIBE]
- O portão:
  - o turbo build typecheck lint test em série, sem cache;
  - o depcruise;
  - o test:db inteiro na estação (rodem o build do @trampo/contracts antes; cuidado 39);
  - o E2E da extensão no Edge em 3 rodadas, se a extensão mudar, e a mutação dela;
  - o E2E do portal em 3 rodadas depois do build, se o portal mudar.
- Antes de cada push, o prepush.sh (git fetch, gitleaks 8.30.1 conferido, a varredura pública do diff e das mensagens, com controle positivo). Push sem force. Achado do gitleaks em commit ainda local se corrige refazendo o commit, nunca publicando.
- STATE a cada etapa. No fim:
  - SESSION-LOG (só acréscimo, no fim do arquivo);
  - BACKLOG (F1-API-06 pelas fatias, F1-EXT-09 e o que a S-5a fechar);
  - TRILHAS.md (tira a trilha concluída, põe a seguinte e grava o cuidado novo);
  - as emendas dos ADRs 031, 017, 025, 014, 010, 007 e 030;
  - o threat-model (T38 e T55 verificados, T53 se a S-5a entrar, e as linhas da §9);
  - o contratos-zod regerado pelo regen_contratos.py, com a linha da §9;
  - o guia: o mapa do 03 a cada arquivo novo em src e supabase, conferido pelo check_map.py; o 01 quando a rota passar a gravar;
  - o docs/ regenerado pelo publish_docs.py, com o gitleaks dir docs;
  - o HITL-037 com o ciclo, e os HITL que vierem com runbook;
  - o next-step (só o status, as pendências apontando para HITL e runbook, e o prompt).
- O cofre ../base não é versionado. Backup no scratchpad antes de editar. O ADR-004 é CRLF e o resto é LF, conferidos por bytes em Python. Editem o cofre pelo apply_blocks.py, com --check antes. Scripts com barra invertida vão pela ferramenta Write ou Edit, nunca por heredoc no Git Bash (o heredoc voltou a colapsar uma barra na sessão 33).

AO FINAL: o próximo prompt gerado deve ser tão completo quanto este, com as funcionalidades complexas que vierem a seguir, porque será rodado num modelo mais poderoso. Exemplos:
- a fatia 6 da F1-API-06 (o consentimento e a ligação);
- o botão de feedback no Side Panel (F1-EXT-10);
- a S-5b (o Dockerfile, a varredura da imagem e a sonda) e o deploy real por HITL;
- o spike S-3 com os números de volta e o bloco E;
- a F1-EVL-01 (golden dataset com gate de CI por provedor e modelo);
- o build de produção da extensão (PRE-LOJA-01).
```
