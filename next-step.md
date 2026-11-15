# Próximo passo: F1-PORTAL-04 no código, F1-PORTAL-03 (exportar e excluir a conta: desenho e código) e o PR do 11º ciclo

> **Última entrega, sessão 31 (2026-11-15):** a F1-PORTAL-02 está fechada no código.
> - `45670b9`: a página `/conta/criterios`, a rota `POST /conta/criterios/salvar` e o E2E no Edge (14/14 em 3 rodadas; mutação I- 8/8 e Q- 7/7).
> - Antes, na sessão 30: `77c6f97` (F1-API-09, o teto da sessão em 86.400) e `53b4f69` (o núcleo dos critérios no portal).
> - Fora do código: a F1-PORTAL-04 desenhada (ADR-027 §9), o runbook do 1º salvamento real e o HITL-043.
>
> Detalhes no `SESSION-LOG`; trilhas e cuidados em `../base/00-orquestracao/TRILHAS.md` (cuidado 37 novo).

## Pendências do humano

- **HITL-037, 11º ciclo:** abrir o PR do `spike/s1-extraction` para o `master`, conferir os 4 checks e mergear com merge commit. O PR leva o `77c6f97`, o `53b4f69`, o `45670b9` e o commit de docs. O job `db` verde fecha a F1-API-09. Runbook `../base/03-infra-runbook/publicar-branch-pr.md` (§4 a §6).
- **HITL-043 (depois do merge):** o 1º salvamento real de critérios pelo portal, com a API local, anotando o número da coluna Size do cookie. A Redirect URL de loopback entra na allow-list só durante o roteiro. Responda só com sim/não, avisos e números. Runbook `../base/03-infra-runbook/auth-portal.md` (§8).

## Próximo prompt

```text
Equipe, sigam em ciclo estrito de DevSecOps (AGENTS.md), em batelada de etapas com checkpoint no STATE.md entre elas e um commit atômico por etapa. Trilhas: (0) o PR do 11º ciclo, se existir; (1) a F1-PORTAL-04 no código; (2) a F1-PORTAL-03, primeiro o desenho num ADR novo e depois o código em fatias; e, se a janela permitir, (3) o desenho do roteiro do spike S-3. Nada gasta cota de LLM nem chama o Supabase real: o portal é provado contra o GoTrue simulado e a API simulada, em socket real, e o banco contra a pilha local; tudo que tocar o projeto real é HITL. Push do spike/s1-extraction só se este prompt ou o humano no chat autorizar; quando autorizado, no fim de cada etapa, depois do git fetch e do gitleaks 8.30.1 conferido pelo checksums.txt. O repositório é PÚBLICO: nenhum caminho local, e-mail, host real ou ID de scratchpad em arquivo rastreado nem em mensagem de commit (cuidado 35). Se a janela de contexto apertar, parem no fim de uma etapa, gravem o STATE e gerem o next-step com o que falta (AGENTS §4.4).

FASE 1 [ORCHESTRATOR]
- Leiam o STATE.md (blocos das sessões 30 e 31), o HITL-QUEUE.md (HITL-037 no 11º ciclo e HITL-043) e o TRILHAS.md (tabela e cuidados 7, 14, 24, 26, 32, 33, 35, 36 e 37). Rodem git fetch, gh pr list --state all --limit 3 e gh pr view <n> --json state,mergeCommit,headRefOid,statusCheckRollup do PR do 11º ciclo. Registrem a divergência se o prompt e o GitHub discordarem: nunca fechem um ciclo do HITL-037 pela declaração.
- Copiem as ferramentas do scratchpad da sessão 31 (mutlib.py, mut_portal02.py, mut_portal02_edge.py, mut_portal02_edge2.py, scan_public.py, publish_docs.py, apply_blocks.py e o gitleaks) e confiram o zip do gitleaks pelo checksums.txt.
- Se este prompt trouxer a resposta do HITL-043, façam a conta do access: access = ⌊3·(Size − 66)/4⌋ − 125 (o kid p1 e o refresh de 12 caracteres; com refresh mais longo, é um teto). Registrem o número no ADR-027 §8 (emenda datada) e na §9 do threat-model, e fechem a condição 14 do ADR-028. Se passar de 2.000 caracteres, a decisão de dividir a sessão em dois cookies selados volta ao [ARCHITECT] antes de qualquer outra trilha do portal. Resposta sem "loopback removida e conferida" mantém o HITL-043 aberto.
- Leiam o ADR-027 inteiro (D1 a D12 e as §6 a §9; a §9 é o desenho da F1-PORTAL-04), o ADR-028 (D1 a D12 e a §6), o ADR-018 (o schema, a RLS e o D5), o ADR-021 (as rotas de critérios, o CriteriaGuard), o ADR-026 (o hook) e o ADR-004 D11.5 (o logout da extensão). Do threat-model, leiam TB5, TB12, TB13, T30, T33, T41, T44, T48, T49, T51, SR-16, SR-25 a SR-27 e a §9.
- Leiam o código antes de propor. No portal: src/server (session.ts, gotrue.ts, criteria.ts, api-client.ts, edge.ts, notices.ts), src/app (conta, auth/sair), test/support (fake-gotrue.ts e fake-api.ts), test/integration e test/e2e. Na API: src/presentation/routes (criteria.ts é o molde de rota de usuário), a borda (CORS, limite de taxa) e o cliente de usuário do PostgREST. No banco: supabase/migrations (as três tabelas com on delete cascade para auth.users) e apps/api/test/db.

ETAPA 0: PR do 11º ciclo [QA_EVALS] + [DEV] (só se o PR existir)
- gh pr checks <n> --watch. Verde: registrem no STATE e no HITL-037, e fechem a F1-API-09 no BACKLOG (o job db rodou o caso novo do auth-hook.db.test.ts contra o GoTrue de verdade). Vermelho no db: leiam com gh run view --log-failed e corrijam só o teste ou a migration, nunca afrouxando a asserção. Vermelho no test do portal: a integração nova dos critérios sobe o next start com a API simulada; confiram o caso que caiu. O E2E não roda no CI.

ETAPA 1: F1-PORTAL-04 no código, parte 1 [DEV] + [QA_EVALS] (TDD estrito, desenho aprovado no ADR-027 §9)
- Primeiro o fato F1, na pilha local (CLI 2.120.0 com Docker, ou a pilha simulada da sessão 24 se o Docker não subir): duas sessões do mesmo usuário; POST /auth/v1/logout?scope=global com o Bearer de uma sessão já encerrada. Registrem a resposta no §9.1 do ADR-027. O desenho já falha fechado: só o 2xx confirma.
- Testes vermelhos primeiro:
  - gotrue.test.ts: logout(accessToken, "local") e logout(accessToken, "global") chamam o endereço exato de cada escopo; nenhum outro valor compila;
  - session.test.ts: logoutEverywhere pela tabela do §9.2 (Origin e Sec-Fetch-Site, o cookie apagado sempre, sem sessão, a renovação antes, só o 2xx como saiu_de_tudo, o 403 session_not_found como saiu_sem_confirmar, uma tentativa); o logout comum e o da sessão órfã continuam local;
  - small-modules.test.ts: os avisos saiu_de_tudo e saiu_sem_confirmar no catálogo fechado.
- Depois o código: gotrue.ts (dois endereços fixos montados no boot), session.ts (logoutEverywhere), notices.ts.
- fake-gotrue.ts: sessões por usuário, o escopo de cada logout registrado, o global revogando todas e o local só a do Bearer; a renovação de sessão revogada recusada.
- Mutação mut_portal04.py, grupo U- pela unidade: o escopo trocado nos dois sentidos, o 403 session_not_found contado como sucesso no global, o Origin não conferido, o cookie mantido na falha, a nova tentativa.

ETAPA 2: F1-PORTAL-04 no código, parte 2 [DEV] + [QA_EVALS]
- A página /conta/sair-de-tudo (Server Component, a DAL em leitura, no-store, texto fixo do catálogo dizendo que a extensão e os outros navegadores saem em até 15 minutos), a rota POST /auth/sair-de-tudo (só a tradução; GET 405) e o link na /conta.
- Integração contra o next start: as condições 1 a 8 do §9.3 (o escopo só muda nesse botão; ?scope= hostil não muda o endereço; a tabela de CSRF; o GET da página não encerra nada; só o 2xx confirma; duas sessões, com a 2ª caindo depois do global e viva depois do local; um POST por clique; cabeçalhos uma vez cada e a tabela de open redirect).
- E2E no Edge com dois contextos (o 2º faz o papel da extensão), pelo botão real: sair de tudo no 1º, e o 2º cai em "Sua sessão expirou" na navegação seguinte; com o "Sair" comum, o 2º continua. 3 rodadas.
- Mutação I- e Q- com rebuild, em primeiro plano e em lotes de 3: a página de confirmação postando em /auth/sair, o link da /conta direto para a rota, o escopo trocado, o GET executando. Reconstruam o portal no fim.
- Cofre: ADR-027 §9 (emenda da implementação), threat-model (T44 e T49 com o remédio do usuário; residual do access de 900 s), BACKLOG, o mapa do guia e o roteiro do 1º uso real (no HITL-043, se ainda aberto, ou um HITL novo).

ETAPA 3: F1-PORTAL-03, desenho [ARCHITECT] + [APPSEC], sem código (ADR-029 novo, com a auditoria do [APPSEC] e as condições numeradas)
- Fatos antes do desenho, pela documentação do Supabase (MCP search_docs) e pelo código: como um usuário apaga a própria conta sem service_role; o que o on delete cascade das três tabelas cobre; o que o GoTrue guarda além de auth.users (identidades, sessões, refresh tokens, MFA, logs de auditoria); o que o Redis guarda por usuário (limite de taxa, cota, cache de análise por hash do texto, que não é por usuário). Nada de memória.
- Decisões em aberto:
  - Excluir:
    - (A) recomendação a provar: uma função SECURITY DEFINER no Postgres (search_path fixo, só authenticated, apaga auth.users where id = auth.uid()), chamada pela API por RPC do PostgREST com o JWT do usuário. A regra "rotas de usuário nunca usam service_role" fica intacta, e o cascade faz o resto;
    - (B) a Admin API do GoTrue com a secret key na API. O [APPSEC] avalia o veto (chave nova de alto privilégio no processo da API);
    - a ordem (dados antes ou junto), a idempotência, o que acontece com o access ainda válido por até 900 s (a API não confere revogação: o usuário apagado pode regravar critérios? a FK para auth.users deve recusar; provem no job db) e o que fica no Redis (chaves por sub com TTL: listar e apagar, ou deixar expirar com justificativa).
  - Exportar: rota GET /v1/account/export na API (JSON com os critérios com a pretensão decifrada, as análises e o feedback, validado na saída, com teto e paginação ou corte declarado), entregue pelo portal como download (Content-Disposition attachment, no-store, nosniff), sem passar por URL nem cache. Contrato novo em packages/contracts com z.strictObject, e o contratos-zod regerado (DOC-01).
  - Portal: página /conta/dados com os dois botões. A exclusão em dois passos sem JS (página de confirmação com o próprio formulário, como a F1-PORTAL-04), Origin exato e Sec-Fetch-Site, e uma frase digitada de confirmação conferida no servidor. Depois de excluir: cookie apagado, aviso do catálogo, e a extensão cai na renovação seguinte.
  - Reautenticação recente antes de excluir (o access emitido há pouco, ou um login novo): decidam com o [APPSEC], pesando o T49 (cookie roubado apagando a conta).
  - Classe de limite de taxa própria para excluir e exportar; o 401, o 503 e o prazo no mapa de erros (o "pode ter excluído" precisa de texto próprio e nunca promete o que não confirmou).
  - LGPD: o que a exportação inclui e o que não inclui (nada de log, nada de chave), o prazo, e o registro mínimo da exclusão sem dado pessoal.
  - Threat-model: ficha nova (exclusão forjada ou por sessão roubada), SR-16 detalhado, e a §9 com o residual do access de 900 s.
- Plano de testes: unidade 100%; job db (a função com RLS forçada: só apaga a própria conta, anon e outro usuário recusados, cascade provado nas três tabelas, e a gravação com o token de usuário apagado recusada); integração do portal com a API simulada; E2E pelo botão real; mutação por camada.

ETAPA 4: F1-PORTAL-03, código parte 1 [DEV] + [QA_EVALS] (API e banco)
- Contrato primeiro (packages/contracts), depois a migration da função, o test:db novo (só se prova no PR: gh pr checks --watch), as rotas da API com os testes antes do código, 100% nas 4 métricas e a mutação do núcleo.

ETAPA 5 (se a janela permitir): F1-PORTAL-03, código parte 2 (portal)
- O cliente (api-client.ts ganha exportar e excluir, no mesmo molde), a DAL, as páginas, as rotas, a API simulada com as rotas novas, a integração, o E2E e a mutação I- e Q-.

ETAPA 6 (só se sobrar janela): roteiro do spike S-3 (P1 a P21) revisado contra o estado atual, só no papel
- Atualizem o roteiro com o que já fechou (P4 a P8, P18 destravado pelo HITL-040) e o que o portal acrescentou (P19, o balde do /token e do /logout no projeto real; o logout global). O spike roda por HITL.

PORTÃO E FASE 4 [SCRIBE]
- Turbo build typecheck lint test em série, sem cache; depcruise; E2E da extensão inteiro no Edge (nada dela deve mudar) e o E2E do portal em 3 rodadas depois do build. Gitleaks 8.30.1 conferido pelo checksums.txt antes de cada push, a varredura pública (caminho, e-mail, host e ID de scratchpad, com controle positivo) nos commits e no docs/, git fetch antes do push e push sem force.
- STATE a cada etapa. No fim:
  - SESSION-LOG (só acréscimo, no fim do arquivo);
  - BACKLOG (F1-PORTAL-04 fechada só com o E2E verde; F1-PORTAL-03 fechada só com o job db verde no PR e o E2E verde);
  - TRILHAS.md (tira a trilha concluída, põe a seguinte e grava o cuidado novo);
  - ADR-029 e as emendas do ADR-027, do ADR-028, do ADR-021 e do ADR-018;
  - threat-model;
  - contratos-zod (regerado por script);
  - o guia (o mapa do 03 a cada arquivo novo em src e test; o 01 e o 02 com o fluxo de exportar e excluir);
  - o docs/ regenerado pelo publish_docs.py, com o gitleaks dir docs;
  - o HITL-037 com o ciclo, e o HITL novo da 1ª exclusão real (numa conta de teste), com runbook;
  - o next-step (só status, pendências apontando para HITL e runbook, e o prompt).
- O cofre ../base não é versionado: backup no scratchpad antes de editar. O ADR-004 é CRLF e o resto é LF, conferidos por bytes depois de cada edição. Editem o cofre pelo apply_blocks.py (com --check antes) e escrevam scripts pela ferramenta Write, nunca por heredoc no Git Bash: o shell colapsa as barras invertidas.

AO FINAL: o próximo prompt gerado deve ser tão completo quanto este, com as funcionalidades complexas que vierem a seguir, porque será rodado num modelo mais poderoso. Exemplos: o spike S-3 com P1 a P21 contra o projeto real por HITL; a hospedagem do portal e da API no S-5 (HSTS com preload, a Redirect URL definitiva, o Site URL, o TRUST_PROXY e o balde por IP do portal na API, ADR-028 D9); a F1-EVL-01 (golden dataset com gate de CI); ou o histórico de análises no portal.
```
