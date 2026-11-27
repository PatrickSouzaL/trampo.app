# Próximo passo: o PR do 14º ciclo, a F1-API-06 fatia 6 (o consentimento), a S-5a e a S-5b para o Cloud Run, e a F1-EXT-10

> **Última entrega, sessão 34 (2026-11-27):** o 13º ciclo fechou (PR #31). Os HITL-046 (blocos 0 a D), 047, 048 (opção A) e 049 estão registrados: oito portões do S-3 fechados, o Cloud Run em `us-east4` no ADR-030 §8 e a fatia 6 desenhada no ADR-031 §7.2.
>
> No código entraram a F1-API-06 fatias 3 a 5 (a gravação desligada, o feedback e a exportação paginada, com `test:db` 200 de 201 na estação) e a F1-EXT-09 (o `ApiError` da API real aceito pela extensão; E2E no Edge 3 × 146/146).
>
> Detalhes no `SESSION-LOG`; trilhas e cuidados em `../base/00-orquestracao/TRILHAS.md` (cuidado 40 novo).

## Pendências do humano

- **HITL-037, 14º ciclo:** abrir o PR do `spike/s1-extraction` para o `master`, conferir os 4 checks e mergear com merge commit. O job `db` roda pela 1ª vez o `export.db.test.ts` (as 2.500 linhas pelo PostgREST do runner; esperado: 201 passed). Runbook `../base/03-infra-runbook/publicar-branch-pr.md` (§4 a §6).
- **HITL-049, §5 (quando puder):** a consulta do `cron.job_run_details` no projeto real (os `status` e as contagens). Runbook `../base/03-infra-runbook/analises-retencao.md` §5.
- **HITL-046, bloco E (depois do deploy real):** a extensão de verdade contra a API hospedada. Runbook `../base/03-infra-runbook/spike-s3.md`.
- **HITL-047, parte 3 (depois da S-5b):** a sonda no Cloud Run. Runbook `../base/03-infra-runbook/hospedagem-s5.md` §6.

Responda só com sim/não, conforme/diverge, avisos, números e as escolhas pedidas.

## Próximo prompt

```text
HITL-037 (14º ciclo): <o número do PR, se abriu; os 4 checks; o merge commit; ou "ainda não abri">.
HITL-049 §5: <os status e as contagens do cron.job_run_details, ou "ainda não">.

Push do spike/s1-extraction: <autorizado no fim de cada etapa / não autorizado>.

Equipe, sigam em ciclo estrito de DevSecOps (AGENTS.md), em batelada de etapas com checkpoint no STATE.md entre elas e um commit atômico por etapa (ou por fatia). Trilhas, nesta ordem:
(0) o PR do 14º ciclo, se existir, e o §5 do HITL-049, se vier neste prompt;
(0b) a F1-SEC-03: a triagem dos avisos do Next.js 16.4.2 (7 moderados, corrigidos no 16.4.5), do fast-uri e do minimatch, e a subida das versões exatas;
(1) a F1-API-06 fatia 6a: o banco do consentimento (ADR-031 §7.2, D6.1 a D6.3);
(2) a fatia 6b: o contrato, as rotas da conta, o gravador com a leitura da opção e a ligação no composeApp (D6.4 e D6.5);
(3) a fatia 6c: a opção na /conta/dados do portal (D6.5), com o E2E;
(4) a S-5a para o Cloud Run (ADR-030 §8.2 D2 e §8.4);
(5) se a janela permitir, a S-5b (o Dockerfile, a varredura da imagem, a imagem da sonda e o resumo de telemetria no fim do pedido);
(6) se ainda sobrar janela, o desenho da F1-EXT-10 (o botão "concordo/discordo" no Side Panel) e o do histórico no portal (/conta/analises).

Restrições da sessão:
- Nada gasta cota de LLM nem chama o Supabase real. A API é provada contra o PostgREST e o Redis simulados, em socket real; o portal, contra o GoTrue e a API simulados; a extensão, no Edge com o IdP e o BFF falsos (que imitam a API real: o id do servidor em todo ApiError, cuidado 40); o banco, contra a pilha local (Docker com a CLI 2.120.0 conferida pelo checksums.txt e o psql 17.11 do scratchpad da sessão 34; se ele não existir mais, perguntem antes de baixar). A prova que vale é o job db do PR. Tudo que tocar o projeto real ou o Google Cloud é HITL.
- Push só se este prompt ou o humano no chat autorizar; quando autorizado, no fim de cada etapa, depois do git fetch e do portão (prepush.sh: gitleaks 8.30.1 conferido e a varredura pública), lendo os achados da varredura ANTES do push.
- O repositório é PÚBLICO: nenhum caminho local, e-mail, host real (inclusive o host chromiumapp da extensão) ou ID de scratchpad em arquivo rastreado nem em mensagem de commit (cuidado 35). Fixture com cara de token nasce em tempo de execução desde o 1º commit (cuidados 14 e 38). Não commitem o next-step.md editado pelo humano antes de reescrevê-lo.
- **Mutação (cuidado 40):** o mutlib.py restaurou em silêncio sem efeito na sessão 34 (o repositório fica na Área de Trabalho). Antes de toda rodada, `tree_check.py <repo> save`; depois, `tree_check.py <repo> check`, que restaura e acusa mutante preso. Nenhuma rodada em paralelo com outra; resultado de rodada com mutante preso não vale e se refaz.
- Se a janela de contexto apertar, parem no fim de uma etapa, gravem o STATE e gerem o next-step com o que falta (AGENTS §4.4).

FASE 1 [ORCHESTRATOR]
- Leiam o STATE.md (bloco da sessão 34), o HITL-QUEUE.md (037 no 14º ciclo, 046 a 049) e o TRILHAS.md (tabela e os cuidados 7, 14, 26, 33, 35, 37, 38, 39 e 40). Rodem git fetch, gh pr list --state all --limit 3 e gh pr view <n> --json state,mergeCommit,headRefOid,statusCheckRollup do PR do 14º ciclo. Registrem a divergência se o prompt e o GitHub discordarem: nunca fechem um ciclo pela declaração.
- Copiem as ferramentas do scratchpad da sessão 34 e confiram o zip do gitleaks e o da CLI pelo checksums.txt: mutlib.py, tree_check.py, apply_blocks.py, prepush.sh, scan_public.py, publish_docs.py, regen_contratos.py, check_map.py, dbenv.sh, mut_api06.py (R-, F-, P- e X-), mut_analyses_db.py, mut_account_api.py, mut_account_db.py, mut_portal03.py, mut_portal03_edge.py, o gitleaks, o supacli e o dl-pg (o psql). Os scripts de mutação recebem a raiz por --root=.
- Leiam os ADRs: o ADR-031 inteiro (D1 a D8, §3, §7.1 a §7.3, em especial o §7.2, que é o desenho da fatia 6 e as condições 16 a 23); o ADR-029 (D2, D3, D5 e §6, o molde da delete_own_account); o ADR-018 (D2 e D3, a RLS forçada e os revokes); o ADR-030 §8 inteiro; o ADR-007 (D4, D5 e a emenda da sessão 34 no D6); o ADR-014 (D4, D10 e a emenda da sessão 34); o ADR-010 (D1, D5, D6 e as emendas); o ADR-027 (D3, D8 e §9, o molde das rotas do portal); o ADR-028 (D1, D2 e D9); o ADR-017 e o ADR-025 (as emendas da sessão 34, F1-EXT-09).
- Do threat-model, leiam T38, T53, T54, T55, SR-12, SR-16, SR-28 e a §9.
- Leiam o código antes de propor: supabase/migrations (as de 20261115150000 e 20261116150000), apps/api/test/db (analyses.db.test.ts, account.db.test.ts, export.db.test.ts e os apoios), apps/api/src (analysis-recorder.ts, analysis-log.ts, supabase-analysis-log.ts, postgrest-user-client.ts, account-service.ts, supabase-account-store.ts, routes/account.ts, routes/analyze.ts, compose-app.ts, edge/client-address.ts, edge/behind-proxy-env.ts, edge/edge-env.ts, main.ts, telemetry e log-policy), apps/web-portal/src (server/account.ts, server/api-client.ts, app/conta/dados) e os testes vizinhos.

ETAPA 0: PR do 14º ciclo [QA_EVALS] + [DEV] (só se o PR existir)
- gh pr checks <n> --watch. Verde: registrem no STATE e no HITL-037. Vermelho no db: gh run view --log-failed e corrijam só o teste (nunca afrouxando a asserção). Ponto frágil: o export.db.test.ts planta 2.500 linhas em 26 lotes envelhecidos (o teto de 100 em 24 h vale para o postgres) e compara a ordem do banco; um runner mais lento pode pedir mais que os 120 s do beforeAll.

ETAPA 0b: F1-SEC-03, as dependências com aviso de segurança [APPSEC] + [DEV] + [QA_EVALS] (BACKLOG F1-SEC-03)
- Rodem o pnpm audit (só leitura) e escrevam, por aviso, se o código do projeto alcança o caminho vulnerável (o portal sem cacheComponents, sem runtime Edge nas rotas e sem otimização de imagem; o repasse do arquivo da exportação; o Fastify só com o parser JSON). A triagem vai para o threat model (§9) e para um ADR curto ou emenda do ADR-001 (a política de versões).
- Subam as versões exatas no catálogo do pnpm (o next para o 16.4.5 ou o mais novo com mais de 2 semanas de publicado; o fast-uri por overrides se a cadeia do Fastify não subir; o minimatch se estiver no caminho do runtime), com o pnpm install --frozen-lockfile depois, a política do @trampo/ci-policy, o portão inteiro e os E2E do portal e da extensão em 3 rodadas. Nada de next upgrade automático.

ETAPA 1: F1-API-06 fatia 6a, o banco do consentimento [ARCHITECT] + [APPSEC] + [DEV] + [QA_EVALS] (ADR-031 §7.2 D6.1 a D6.3)
- Fato antes do código, na pilha local: um gatilho que levanta `PT412` vira HTTP 412 no PostgREST da CLI 2.120.0? Meçam com uma sonda (molde do probe_f1api06.mjs) e registrem no ADR-031 §7.4. Se não virar 412, o [ARCHITECT] escolhe outro código PTxyz livre e emenda o D6.3 antes do código.
- Migration nova, idempotente: a tabela public.user_settings (user_id PK com FK on delete cascade para auth.users, analysis_history boolean not null default false, updated_at), RLS habilitada e forçada, uma policy de select só do dono, só select para authenticated, revoke explícito de anon e service_role, e o gatilho que força o updated_at.
- As funções enable_analysis_history() e disable_analysis_history(): security definer, search_path vazio, dona postgres, execute só para authenticated (revoke de public, anon e service_role), o dono pelo auth.uid() (sem JWT, erro). A enable faz o upsert com true e devolve 'ligado'; a disable grava false e apaga as análises do dono na mesma transação (o feedback vai junto) e devolve 'desligado'. As duas idempotentes.
- O gatilho analyses_before_insert ganha, ANTES do relógio, do teto e do advisory lock, a conferência da opção do dono (sem linha ou com false: o SQLSTATE medido). Cuidado: o export.db.test.ts e o analyses.db.test.ts plantam como postgres; eles passam a ligar a opção antes (pela própria função com o JWT do usuário ou por SQL como postgres).
- test:db (antes da migration, falhando pelo motivo certo): as condições 16 a 19 e 22 (sem linha nada grava; o insert direto pelo PostgREST sem a opção dá o código medido e não toma o lock; insert, update e delete em user_settings com o JWT do dono dão 42501; desligar apaga análises e feedback e só responde depois; enable e disable repetidos são seguros; o cascade da exclusão da conta leva a user_settings, no account.db.test.ts); o catálogo (funções, gatilhos e ACL); o analyses.db.test.ts e o export.db.test.ts continuam verdes.
- Mutação: o mut_analyses_db.py ganha o grupo D6- (o default true, o grant de update, a disable sem o delete, o gatilho sem a conferência, a conferência depois do lock, o execute para anon), contra a pilha local, com o tree_check.

ETAPA 2: F1-API-06 fatia 6b, o contrato, as rotas e a ligação [DEV] + [APPSEC] + [QA_EVALS] (D6.4 e D6.5)
- Contrato em @trampo/contracts/account: AccountSettingsSchema ({ analysisHistory: boolean }, estrito), AnalysisHistoryRequestSchema ({ enabled: boolean }, estrito), as rotas novas no ACCOUNT_ROUTES e o bodyLimit; a §4 do contratos-zod regerada e a linha da §9.
- API: POSTGREST_FUNCTIONS ganha as duas funções (resposta de até 64 bytes); o AccountStore ganha settings(subject) (o select da user_settings; sem linha = false) e setAnalysisHistory(subject, enabled) (o RPC certo, só as palavras 'ligado' e 'desligado'); o AccountService com prazo e revalidação; GET /v1/account/settings e PUT /v1/account/analysis-history na classe conta, no-store, 503 sem eco, fora do alcance da extensão (provem pelo CORS).
- O gravador: antes do insert, a leitura da opção (um select com o mesmo JWT); desligada, ou a leitura que falha ou trava, não grava (falha fechada); o insert que volta com o código do gatilho também é sem_consentimento. O outcome sem_consentimento entra no ANALYSIS_LOG_OUTCOMES, na métrica e no evento (emenda ao ADR-010), sem linha de log (é o caso normal).
- A ligação no composeApp: o AnalysisRecorder com o SupabaseAnalysisLog num cliente de usuário próprio. O teste que prendia o "sem gravador" passa a prender o "com gravador e sem consentimento, nada vai a analyses".
- Testes antes do código; 100% nas 4 métricas; o socket real com as peças reais (o consentimento desligado não grava; ligado grava; desligar apaga). Mutação: mut_api06.py grupo C6- (a leitura que falha grava; o 412 vira recusada com log; a ligação sem o cliente próprio; a rota de settings alcançável pela extensão; o disable sem conferir a palavra).

ETAPA 3: F1-API-06 fatia 6c, o portal [DEV] + [APPSEC] + [QA_EVALS] (D6.5; ADR-027 e ADR-028 como molde)
- A /conta/dados mostra o estado e um formulário só (Server Component, sem JS próprio); o Route Handler POST fora do segmento da página (cuidado 37), com Origin exato e Sec-Fetch-Site; o texto do desligar avisa ANTES do clique que o histórico será apagado; "histórico apagado" só com o 204; o 503 diz "não confirmado" (cuidado 38). Textos novos no catálogo fechado, sem link.
- Unidade (o núcleo em src/server, 100%), integração (o next start com a API simulada) e o E2E no Edge em 3 rodadas, depois do build, com o botão real (cuidado 36). Mutação: mut_portal06.py (U- pela unidade, I- e Q- com rebuild, em lotes de 3, com o tree_check).
- Um HITL novo com runbook: a migration do consentimento no projeto real, a §5 do HITL-049 junto, e a 1ª opção ligada e desligada numa conta de teste (só depois do job db verde).

ETAPA 4: S-5a para o Cloud Run [ARCHITECT] + [APPSEC] + [DEV] + [QA_EVALS] (ADR-030 §8.2 D2, §8.3 e §8.4)
- API_CLIENT_IP_SOURCE (socket | ultimo-xff): no modo ultimo-xff, o request.ip da API vem da última entrada do X-Forwarded-For (net.isIP; fora da forma ou sem o cabeçalho, o balde único do ADR-014 D4), nunca de outra posição; o TRUST_PROXY fica false; o boot recusa ultimo-xff sem API_BEHIND_PROXY=true, ultimo-xff com TRUST_PROXY, e qualquer EDGE_AUTH_KEYS presente, sem ecoar valor. Onde o IP entra (o limitador pré-JWT, o rate limit por IP): todos pelo mesmo ponto.
- O boot recusa a SUPABASE_SECRET_KEY presente, e ela sai do .env.example.
- O main.ts encerra em menos de 10 s no SIGTERM (os streams abertos fecham; teste com o relógio).
- Um proxy reverso local em Node em test/support que acrescenta o X-Forwarded-For como o GFE, para os testes de socket real (o cliente forja um valor à esquerda; a API vê só o último).
- Emendas ao ADR-007 D5 e ao ADR-014 D10; o threat model (T53 verificado no código); mutação dirigida (a primeira entrada em vez da última; sem net.isIP; o boot aceitando a combinação incoerente; a SECRET_KEY aceita).

ETAPA 5 (só se sobrar janela): S-5b [DEV] + [APPSEC] (ADR-030 §8.4)
- Dockerfile da API (node na versão do CI, pnpm deploy --prod, usuário sem privilégio, PORT e 0.0.0.0), .dockerignore sem .env*, a varredura do sistema de arquivos da imagem no CI (a política no @trampo/ci-policy), a imagem da sonda (/health, o eco da última entrada do X-Forwarded-For e do número de entradas, sem o IP inteiro em log, e um SSE sintético de 45 s, sem nenhuma variável do projeto) e o resumo de telemetria no fim do pedido a cada 15 min (F1-OBS-03; nenhum timer novo no processo). Os comandos exatos da sonda (gcloud e PowerShell) entram no runbook hospedagem-s5 §6.

ETAPA 6 (só se ainda sobrar janela): desenhos, sem código
- F1-EXT-10: o botão "concordo/discordo" e o motivo no Side Panel, ao lado do "Código da análise": a mensagem nova na porta trampo/sidepanel/v1, a rota de feedback na lista ROUTES do api-client da extensão, os textos de 204, 404 PROIBIDO, 429 e 503, a emenda ao ADR-025 e o plano do E2E.
- O histórico no portal (/conta/analises): a rota nova de listagem paginada por cursor na API (o mesmo cursor cru do §7.3), a página sem JS próprio (a data, a nota, o veredito e o caminho; nunca o texto da vaga), o feedback pelo portal servidor a servidor. Emenda do ADR-031 ou ADR novo.

PORTÃO E FASE 4 [SCRIBE]
- O portão: o turbo build typecheck lint test em série, sem cache; o depcruise; o test:db inteiro na estação (o build do @trampo/contracts antes; cuidado 39); o E2E do portal em 3 rodadas depois do build, se o portal mudar; o E2E da extensão no Edge em 3 rodadas, se a extensão mudar.
- Antes de cada push, o prepush.sh, lendo os achados. Push sem force. Achado do gitleaks em commit ainda local se corrige refazendo o commit.
- STATE a cada etapa. No fim: SESSION-LOG (só acréscimo); BACKLOG (F1-API-06 fechada quando a fatia 6 entrar; S-5a; F1-EXT-10 e o histórico no portal desenhados); TRILHAS.md (tabela e o cuidado novo); as emendas dos ADRs 031, 030, 029, 010, 007 e 014; o threat-model (T55 com o consentimento, T53 no código e as linhas da §9); o contratos-zod regerado pelo regen_contratos.py com a linha da §9; o mapa do guia (check_map.py) e o 01 do guia (a análise que passa a gravar com o consentimento); o docs/ pelo publish_docs.py, com o gitleaks dir docs; o HITL-037 com o ciclo e o HITL novo da migration do consentimento, com runbook; o next-step (status, pendências e o prompt).
- O cofre ../base não é versionado. Backup no scratchpad antes de editar. O ADR-004 é CRLF e o resto é LF, conferidos por bytes. Editem o cofre pelo apply_blocks.py, com --check antes. Scripts e patches com barra invertida vão pela ferramenta Write ou Edit, nunca por heredoc (cuidados 33 e 40).

AO FINAL: o próximo prompt gerado deve ser tão completo quanto este, com as funcionalidades complexas que vierem a seguir, porque será rodado num modelo mais poderoso. Exemplos:
- a F1-EXT-10 no código (o botão no Side Panel, com o E2E e o M-15);
- o histórico no portal no código;
- a S-5b e o deploy real no Cloud Run e no Vercel por HITL, e o bloco E do spike S-3;
- a F1-AUTH-01 (o AuthCodeSchema como UUID);
- a F1-EVL-01 (golden dataset com gate de CI por provedor e modelo);
- o build de produção da extensão (PRE-LOJA-01).
```
