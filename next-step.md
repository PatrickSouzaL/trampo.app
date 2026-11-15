# Próximo passo: o PR do 12º ciclo (o job `db` fecha a F1-PORTAL-03), o roteiro do spike S-3, o desenho do S-5 e a F1-API-06

> **Última entrega, sessão 32 (2026-11-15):** a F1-PORTAL-04 está fechada no código e a F1-PORTAL-03 tem o código entregue.
> - F1-PORTAL-04 ("sair de todos os dispositivos"): `fa45a63` e `2844291`.
> - F1-PORTAL-03 (exportar e excluir a conta, ADR-029): `26958d9` (contrato), `60d49a8` (função do banco e `test:db`), `045ba83` (API), `87ede4b` e `bfda751` (portal). E2E do portal 30/30 em 3 rodadas.
> - Fechados: o 11º ciclo do HITL-037 (PR #29) e o HITL-043 (Size 1312, access de no máximo 809 caracteres).
>
> Detalhes no `SESSION-LOG`; trilhas e cuidados em `../base/00-orquestracao/TRILHAS.md` (cuidado 38 novo).

## Pendências do humano

- **HITL-037, 12º ciclo:** abrir o PR do `spike/s1-extraction` para o `master`, conferir os 4 checks e mergear com merge commit. O job `db` desse PR roda pela 1ª vez no CI o `account.db.test.ts` (a função de exclusão da conta): verde, ele fecha a F1-PORTAL-03. Runbook `../base/03-infra-runbook/publicar-branch-pr.md` (§4 a §6).
- **HITL-044 (depois do merge):** o 1º "Sair de todos os dispositivos" real, com dois perfis do navegador na mesma conta. Runbook `../base/03-infra-runbook/auth-portal.md` (§9).
- **HITL-045 (depois do job `db` verde):** aplicar a migration da função de exclusão no projeto real e fazer a 1ª exportação e a 1ª exclusão reais, **numa conta de teste**. Runbook `../base/03-infra-runbook/conta-exportar-excluir.md`.

Os dois últimos usam a Redirect URL de loopback só durante o roteiro. Responda só com sim/não, conforme/diverge, avisos e números.

## Próximo prompt

```text
Equipe, sigam em ciclo estrito de DevSecOps (AGENTS.md), em batelada de etapas com checkpoint no STATE.md entre elas e um commit atômico por etapa. Trilhas: (0) o PR do 12º ciclo, se existir, e as respostas do HITL-044 e do HITL-045, se vierem neste prompt; (1) o roteiro do spike S-3 revisado, só no papel; (2) o desenho do S-5 (hospedagem do portal e da API) num ADR novo, sem código de infraestrutura; (3) a F1-API-06 (gravar as análises e o feedback, a retenção de 90 dias e a paginação da exportação), primeiro o desenho num ADR novo e depois o código em fatias; e, se a janela permitir, (4) o histórico de análises no portal, só no desenho. Nada gasta cota de LLM nem chama o Supabase real: a API é provada contra o PostgREST e o Redis simulados, em socket real, o portal contra o GoTrue e a API simulados, e o banco contra a pilha local (Docker com a CLI 2.120.0 conferida pelo checksums.txt; a prova que vale é o job db do PR); tudo que tocar o projeto real é HITL. Push do spike/s1-extraction só se este prompt ou o humano no chat autorizar; quando autorizado, no fim de cada etapa, depois do git fetch e do portão (gitleaks 8.30.1 conferido pelo checksums.txt e a varredura pública). O repositório é PÚBLICO: nenhum caminho local, e-mail, host real ou ID de scratchpad em arquivo rastreado nem em mensagem de commit (cuidado 35), e fixture com cara de token nasce em tempo de execução desde o 1º commit (cuidados 14 e 38). Se a janela de contexto apertar, parem no fim de uma etapa, gravem o STATE e gerem o next-step com o que falta (AGENTS §4.4).

FASE 1 [ORCHESTRATOR]
- Leiam o STATE.md (bloco da sessão 32), o HITL-QUEUE.md (HITL-037 no 12º ciclo, HITL-044 e HITL-045) e o TRILHAS.md (tabela e cuidados 7, 14, 24, 26, 32, 33, 35, 36, 37 e 38). Rodem git fetch, gh pr list --state all --limit 3 e gh pr view <n> --json state,mergeCommit,headRefOid,statusCheckRollup do PR do 12º ciclo. Registrem a divergência se o prompt e o GitHub discordarem: nunca fechem um ciclo do HITL-037 pela declaração.
- Copiem as ferramentas do scratchpad da sessão 32 (mutlib.py, edit_lib.py, apply_blocks.py, prepush.sh, scan_public.py, publish_docs.py, regen_contratos.py, check_map.py, os mut_account_*.py, os mut_portal03*.py, os mut_portal04*.py e o gitleaks) e confiram o zip do gitleaks pelo checksums.txt. Os scripts de mutação recebem a raiz por --root=.
- Se este prompt trouxer a resposta do HITL-044: registrem no ADR-027 (emenda datada) em quantos minutos a 2ª sessão caiu; acima de 16 minutos, ou "não caiu", a decisão volta ao [ARCHITECT] antes de qualquer outra trilha do portal (o tempo de vida do access do projeto real). Resposta sem "loopback removida e conferida" mantém o HITL aberto.
- Se este prompt trouxer a resposta do HITL-045: registrem no ADR-029 §6 (emenda datada) e fechem a condição 16 e a F1-PORTAL-03 no projeto real. Qualquer "diverge" do §2 ou do §4 do runbook (uma coluna do auth que falta, postgres sem DELETE, grants diferentes) volta ao [ARCHITECT] e ao [APPSEC] antes de qualquer outra trilha: a função falha fechada, mas o botão do portal não funciona. "exclusao_pede_login logo depois de entrar" pede a conferência do relógio da sessão contra o do banco.
- Leiam o ADR-029 inteiro (D1 a D11, a §3 e a §6.1), o ADR-027 (§9 a §11), o ADR-028 (D9 e a §7), o ADR-021 (as rotas de usuário e a emenda da sessão 32), o ADR-018 (o schema, a RLS, o D5 e a emenda), o ADR-017 (o AnalyzeJob e o stream), o ADR-014 (as classes de limite, com a conta), o ADR-010 (log e telemetria), o ADR-007 (a borda) e o ADR-004 (§1.4, a tabela P1 a P21 do spike, e o D15). Do threat-model, leiam T7, T30, T33, T38, T44, T48, T49, T51, T52, SR-12, SR-15, SR-16, SR-25 a SR-28 e a §9.
- Leiam o código antes de propor. Na API: src/presentation/routes (analyze.ts, criteria.ts e account.ts são os moldes), src/application (analysis, account, criteria, limits), src/infrastructure/supabase/postgrest-user-client.ts e persistence, a borda (cors.ts, rate-limit.ts) e o compose-app.ts. No banco: as três migrations e apps/api/test/db. No portal: src/server (account.ts, api-client.ts, session.ts, edge.ts, notices.ts) e src/app/conta. Na extensão: o painel (o que ele mostra do relatório e onde entraria o botão de feedback), sem mudar nada antes do desenho.

ETAPA 0: PR do 12º ciclo [QA_EVALS] + [DEV] (só se o PR existir)
- gh pr checks <n> --watch. Verde: registrem no STATE e no HITL-037, e fechem a F1-PORTAL-03 no BACKLOG (o job db rodou os 34 casos do account.db.test.ts contra o Supabase do runner). Vermelho no db: leiam com gh run view --log-failed e corrijam só o teste ou a migration, nunca afrouxando a asserção. Pontos frágeis conhecidos: as colunas do auth que a função lê (cuidado 38), o formato do timestamptz que o adapter converte, e a trilha de auditoria (o teste exige pelo menos uma linha do usuário antes de apagar; se o GoTrue do runner não gravar auditoria no banco, o teste planta a linha por SQL em vez de afrouxar a contagem). Vermelho no test: o portal sobe o next start com os simulados; confiram o caso que caiu. O E2E não roda no CI.

ETAPA 1: roteiro do spike S-3 (P1 a P21 e os novos), só no papel [ARCHITECT] + [APPSEC] + [SCRIBE]
- Revisem a tabela do ADR-004 §1.4 contra o estado atual: o que já fechou (P4 a P8 pelo pré-spike; P18 pelo HITL-040; P3, P13 e P20 no E2E local), o que continua aberto e o que entrou depois: P19 (o balde do /token e do /logout no projeto real), P21 (o 401 do gateway real com a publishable inválida), o logout global pelo portal (HITL-044), a função de exclusão no projeto real (HITL-045) e o tamanho do access (809, medido no HITL-043).
- Para cada P: o que se mede, com que conta de teste, o que se anota (só números, sim/não e códigos), o que nunca se cola, o critério de aceite e o que fazer se divergir. Marquem os que gastam cota de LLM (nenhum deveria) e os que mexem em configuração do painel (com o rollback).
- Saída: um runbook novo em ../base/03-infra-runbook (o roteiro executável pelo humano, em blocos de no máximo 45 minutos), a seção S-3 do spike-metrics preparada para receber os números, e um HITL novo. Nenhum código.

ETAPA 2: S-5, desenho da hospedagem [ARCHITECT] + [APPSEC], sem código de infraestrutura (ADR-030 novo, com a auditoria e as condições numeradas)
- Fatos antes do desenho, pela documentação oficial de cada serviço e pelo código: onde o Next.js 16.4.2 do portal roda (runtime Node para o proxy.ts, variáveis só em tempo de execução, cookies __Host- atrás de proxy, o cabeçalho que traz o IP do cliente); onde a API Fastify roda (processo longo com SSE de até 45 s, sem buffering no proxy, o TRUST_PROXY com faixas exatas e o API_BEHIND_PROXY); os limites do free tier de cada opção. Nada de memória.
- Decisões em aberto:
  - o provedor de cada peça e o que ele vê (o corpo da vaga, o Bearer, o IP): tabela de fronteiras nova no threat-model;
  - domínio e origens: PORTAL_ORIGIN, API_ORIGIN, a Redirect URL definitiva e o Site URL (ADR-004 D15: mudam juntos, com os casos A, E, F e G do runbook auth-extensao refeitos), HSTS com preload só depois do domínio estável, e o CORS_ALLOWED_ORIGINS com o ID de produção da extensão (o par RSA novo em cold storage, PRE-LOJA-01);
  - o balde por IP do portal na API (ADR-028 D9): o IP do portal no TRUST_PROXY com o X-Forwarded-For dele, ou uma classe por usuário para servidor a servidor. O [APPSEC] avalia o que um portal comprometido passaria a poder forjar;
  - segredos: onde cada anel mora (PORTAL_SEAL_KEYS, AUTH_REFRESH_SEAL_KEYS, CRITERIA_SALARY_KEYS, o pepper, as chaves dos provedores), a rotação e quem tem acesso; nenhum valor no cofre nem no git;
  - observabilidade: o exportador de métricas (ADR-010 D6), o evento account (F1-PORTAL-05 item 3), a retenção dos logs da plataforma (a linha da §9 do threat-model da sessão 32) e os health checks (F1-OBS-02);
  - implantação: quem publica, a partir de qual ref, com quais checks, e o rollback. Nada de token de implantação no CI sem a política do @trampo/ci-policy.
- Plano de testes: o que dá para provar antes da hospedagem (o portal e a API atrás de um proxy local com X-Forwarded-For e TLS, os cabeçalhos uma vez cada, o SSE sem buffering) e o que só o roteiro real prova (HITL com runbook).

ETAPA 3: F1-API-06, desenho [ARCHITECT] + [APPSEC], sem código (ADR-031 novo)
- Hoje nenhum código grava analyses nem analysis_feedback (as tabelas existem desde a F1-DB-01; a exportação já as lê). Decisões em aberto:
  - gravar a análise: em que ponto do AnalyzeJob (depois do relatório montado, sem atrasar o stream), com que id (o requestId do cliente serve de chave idempotente? o que impede um cliente de regravar a linha de outro pedido), o que fazer se a gravação falhar (o relatório já saiu: nunca derrubar a análise; contar na telemetria) e o que NÃO entra na linha (texto, título, empresa, textHash: T38);
  - a rota POST /v1/analyses/:analysisId/feedback (o AnalysisFeedbackRequestSchema já existe no contrato): dono pelo principal, a FK composta do banco como segunda barreira, upsert, classe de limite própria, e se a origem da extensão a alcança (o botão ficaria no Side Panel: EXTENSION_ROUTES muda, com o M-15 do mut07g.py de novo);
  - retenção de 90 dias: quem apaga (uma função agendada no banco com pg_cron, se o plano tiver; ou uma função chamada pela API num horário; nunca service_role na API), com o teste no job db e o limite por execução;
  - paginação da exportação acima de 500 linhas (F1-PORTAL-05 item 2): cursor por (created_at, id), o contrato novo ou versão 2 do AccountExportSchema, e o que o portal baixa (um arquivo só, montado no servidor, com teto de bytes e de páginas);
  - o cache por "discordo" recorrente (F1-OBS-02) fica fora; só o registro.
- Threat-model: T38 revisto, ficha nova se a gravação abrir um caminho de enumeração de ids, e as linhas da §9.
- Plano de testes: unidade 100%; job db (RLS, FK composta, o dono, a retenção na borda exata de 90 dias, o cascade da exclusão da conta com as linhas novas); rota pelo buildApp; boot com as peças reais; E2E da extensão só se o painel mudar; mutação por camada.

ETAPA 4: F1-API-06, código parte 1 [DEV] + [QA_EVALS] (TDD estrito, depois do ADR aprovado)
- Contrato primeiro (se mudar), depois a migration (se houver), o test:db novo, a gravação da análise no AnalyzeJob com os testes antes do código, 100% nas 4 métricas e a mutação do núcleo. A rota de feedback e a retenção em fatias próprias, uma por commit.

ETAPA 5 (só se sobrar janela): histórico de análises no portal, só no desenho
- Página /conta/analises (Server Component, sem JS próprio) lendo pela API uma rota nova de listagem paginada; o que mostrar (data, nota, veredito, caminho; nunca o texto da vaga, que não é guardado) e o feedback pelo portal. ADR próprio ou emenda do ADR-031.

PORTÃO E FASE 4 [SCRIBE]
- Turbo build typecheck lint test em série, sem cache; depcruise; E2E da extensão inteiro no Edge (se a extensão mudar, 3 rodadas e a mutação dela) e o E2E do portal em 3 rodadas depois do build. O portão antes de cada push (prepush.sh: git fetch, gitleaks 8.30.1 conferido, varredura pública do diff e das mensagens, com controle positivo) e push sem force. Achado do gitleaks em commit ainda local se corrige refazendo o commit, nunca publicando.
- STATE a cada etapa. No fim:
  - SESSION-LOG (só acréscimo, no fim do arquivo);
  - BACKLOG (F1-PORTAL-03 fechada só com o job db verde no PR; F1-API-06 pelas fatias; F1-PORTAL-05 com o que a F1-API-06 absorver);
  - TRILHAS.md (tira a trilha concluída, põe a seguinte e grava o cuidado novo);
  - os ADRs novos (030 e 031) e as emendas do ADR-029, do ADR-027, do ADR-017, do ADR-018, do ADR-014 e do ADR-004;
  - threat-model;
  - contratos-zod (regerado pelo regen_contratos.py, com a linha da §9);
  - o guia (o mapa do 03 a cada arquivo novo em src e supabase, conferido pelo check_map.py; o 01 quando o funil passar a gravar a análise; o 02 com a hospedagem);
  - o docs/ regenerado pelo publish_docs.py, com o gitleaks dir docs;
  - o HITL-037 com o ciclo, o HITL novo do S-3 e os que o S-5 abrir, cada um com runbook;
  - o next-step (só status, pendências apontando para HITL e runbook, e o prompt).
- O cofre ../base não é versionado: backup no scratchpad antes de editar. O ADR-004 é CRLF e o resto é LF, conferidos por bytes (em Python: o grep do Git Bash não vê o CR). Editem o cofre pelo apply_blocks.py (com --check antes) e escrevam scripts com barra invertida pela ferramenta Write ou Edit, nunca por heredoc no Git Bash.

AO FINAL: o próximo prompt gerado deve ser tão completo quanto este, com as funcionalidades complexas que vierem a seguir, porque será rodado num modelo mais poderoso. Exemplos: o spike S-3 executado por HITL com os números de volta; a implantação do S-5 em fatias, com a política de CI; a F1-EVL-01 (golden dataset com gate de CI por provedor e modelo); o histórico de análises e o feedback pelo portal; o F1-EXT-05 fechado pelos CAs do ADR-004 §4.10; ou o build de produção da extensão (PRE-LOJA-01, a chave em cold storage).
```
