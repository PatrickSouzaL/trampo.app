# Próximo passo: job `db` do PR do 7º ciclo e F1-PORTAL-01 (login do portal com cookie HttpOnly e CSP)

> Abra uma sessão nova e envie o prompt abaixo. Nenhum HITL bloqueia o código da trilha.
> Última entrega: sessão 24, a F1-DB-02 no código (`cf5fe64`: a migration do Custom Access Token Hook, o `config.toml` com o hook ligado, o `auth-hook.db.test.ts` e a regra do `@trampo/ci-policy`) e a F1-EXT-08 (`9efcc55`: a análise sem token segue a sessão; o E2E do Chrome 157 sem falha). Detalhes no `SESSION-LOG`; desenho no ADR-026 e no ADR-025 §6.6; trilhas e cuidados em `../base/00-orquestracao/TRILHAS.md` (cuidado 32 novo).

## Pendências do humano

- **HITL-037, 7º ciclo:** abrir o PR do `spike/s1-extraction` para o `master` e conferir os 4 checks. **O job `db` desse PR é a 1ª execução do `auth-hook.db.test.ts` contra o GoTrue de verdade** (esperado: 136 passed); só mergeie com ele verde. Runbook `../base/03-infra-runbook/publicar-branch-pr.md` (§4 a §6).
- **HITL-040 (depois do `db` verde e do merge):** aplicar a migration do hook no projeto Supabase real, ligar o hook no painel e rodar os 4 testes de fumaça. Runbook `../base/03-infra-runbook/supabase-hook-real.md`. Fecha o P18, a CA-15 e o T48.

## Próximo prompt

```text
Equipe, sigam em ciclo estrito de DevSecOps (AGENTS.md), em batelada de etapas com checkpoint no STATE.md entre elas e um commit atômico por etapa. Trilhas: (0) o job db do PR do 7º ciclo, se o PR existir; (1) F1-PORTAL-01, o login OAuth do portal (apps/web-portal, Next.js 16) com a sessão em cookie HttpOnly, Secure e SameSite=Lax e os cabeçalhos de segurança com CSP frame-ancestors 'none'; e, se a janela permitir, (2) F1-API-09 só no desenho (o teto do AUTH_SESSION_MAX_AGE_SECONDS, que espera o HITL-040 para o código). Nada gasta cota de LLM nem chama o Supabase real: o portal é provado contra um GoTrue simulado em socket real e o job db contra a pilha local do CI; o login contra o projeto real é HITL. Push do spike/s1-extraction autorizado no fim de cada etapa, depois do git fetch e do gitleaks 8.30.1 conferido. Se a janela de contexto apertar, parem no fim de uma etapa, gravem o STATE e gerem o next-step com o que falta (AGENTS §4.4).

FASE 1 [ORCHESTRATOR]
- Leiam o STATE.md (bloco da sessão 24), o HITL-QUEUE.md (HITL-037 no 7º ciclo e HITL-040) e o TRILHAS.md (tabela e cuidados 7, 10, 14, 25, 26, 31 e 32). Rodem git fetch, gh pr list --state all --limit 3 e gh pr view <n> --json state,mergeCommit,headRefOid do PR do 7º ciclo. Registrem a divergência se o prompt e o GitHub discordarem: nunca fechem um ciclo do HITL-037 nem o HITL-040 pela declaração.
- Leiam o ADR-026 inteiro (o hook vale para toda sessão do projeto, inclusive a do portal), o ADR-004 (D2 a D4, D6 a D8, D11, D15, §3 e o T48), o ADR-013 (verificação do JWT), o ADR-007 (borda da API e CORS), o ADR-018 D5 (cliente de usuário do PostgREST) e o ADR-001 §5 e §10 (o lugar do portal no monorepo e as arestas proibidas); o threat-model (T33, T41 a T48, §9) e a revisao-adversarial-auth; o BACKLOG#F1-PORTAL-01, #F1-PORTAL-02, #F1-PORTAL-03 e #F1-API-09; o runbook auth-extensao (§2, Redirect URLs e Site URL, e o pré-spike da §3, molde de roteiro manual).
- Leiam o código antes de propor: apps/web-portal (o scaffold do create-next-app: next.config.ts com cacheComponents e partialPrefetching, layout.tsx, page.tsx, eslint.config.mjs, package.json), packages/contracts (auth.ts, limits.ts, api.ts), apps/api/src/infrastructure/supabase/gotrue-token-client.ts (a classificação recusado, nao_recebido e pode_ter_rotacionado, que o portal deve reaproveitar em espírito e não por import, pela aresta proibida), apps/api/test/support/fake-gotrue.ts (o GoTrue simulado do QA-02), o .dependency-cruiser.cjs e o turbo.json.

ETAPA 0: job db do PR [QA_EVALS] + [DEV] (só se o PR do 7º ciclo existir)
- gh pr checks <n> --watch. Verde: registrem no STATE, no HITL-037 e no ADR-026 §4.3 (a prova que vale cumprida, com o run e a contagem) e sigam. Vermelho no db: gh run view <run> --log-failed, leiam o caso e o código do GoTrue v2.197.0 do ponto que divergiu (cuidado 26), corrijam só o teste ou a migration, rodem a mutação do mut_db02.py nos mutantes afetados (pilha simulada do scratchpad da sessão 24, cuidado 32; se o scratchpad sumiu, recriem pelo SESSION-LOG da sessão 24), commit, push e --watch de novo. Nunca marquem a F1-DB-02 como fechada com o db vermelho. Se a migration mudar, o sha256 do runbook supabase-hook-real §1 e do HITL-040 muda junto.

ETAPA 1: desenho da F1-PORTAL-01 [ARCHITECT] + [APPSEC], sem código (ADR-027 próprio)
Decidam e registrem, com a fonte de cada fato do Next.js 16 e do Supabase (documentação oficial; nada de memória):
- o fluxo: PKCE iniciado e trocado no servidor do portal (Route Handlers do App Router), com o verifier e o state num cookie HttpOnly de curta duração e assinado, nunca no localStorage nem em JS do cliente; o Redirect URL exato do portal na allow-list do Supabase (o que muda no runbook auth-extensao §2); o SDK @supabase/ssr ou um cliente próprio no molde do gotrue-token-client (decidam com o [APPSEC]: dependência nova passa pela política de supply chain, ADR-019 e T26, e o pnpm-lock);
- a sessão: o access e o refresh em cookies HttpOnly, Secure e SameSite=Lax, com Path e Max-Age decididos; o refresh selado como o envelope do ADR-004 D5 ou cru (decidam e expliquem o efeito no T44 e no T47); a renovação no servidor; a recusa da renovação pelo hook (403 error_code unknown do GoTrue, ADR-026 D3) vira "entre de novo", e o 503 nunca apaga a sessão (T30);
- CSRF (T33): SameSite=Lax mais a conferência do Origin nas rotas que mudam estado, e o logout por POST; clickjacking: CSP com frame-ancestors 'none' e X-Frame-Options DENY; a CSP inteira (script-src com nonce ou hash, como o Next 16 recomenda com cacheComponents), Referrer-Policy, Permissions-Policy e HSTS; onde ficam (middleware/proxy ou next.config headers) e como o teste os prende;
- o amr: o portal aceita só login social (oauth), como o verificador da API (ADR-004 D6), e verifica o JWT pelo JWKS do projeto (ES256), sem confiar no cookie;
- o logout: scope global (derruba também a extensão, como o D11.5) ou local (decidam com o efeito na extensão e registrem);
- o que o portal NÃO faz nesta trilha: critérios (F1-PORTAL-02), exclusão de conta (F1-PORTAL-03) e qualquer handoff para a extensão;
- o plano de testes e a partição em commits.
- [APPSEC]: auditoria com veto. Pontos obrigatórios: T33, T41, T42, T44, T47, T48 (a sessão do portal também morre em 24 h pelo hook), SR-12 (nada de token, código, verifier ou e-mail em log), cookies sem token legível por JS (prova pelo document.cookie num teste de navegador), nenhuma rota do portal que aceite redirect_to arbitrário (open redirect), e a fronteira nova no threat-model (TB nova e fichas).

ETAPA 2: implementação [DEV] + [QA_EVALS], testes antes do código
- Contratos novos, se houver, nascem em packages/contracts com Zod (DOC-01: contratos-zod §4 regerado por script).
- Testes: unidade das peças puras (state, verifier, cookies, classificação das respostas do GoTrue, a recusa do hook como "entre de novo"); integração dos Route Handlers contra o GoTrue simulado em socket real (o fake-gotrue da API como molde, com o 403 unknown do hook, o 503 e a resposta perdida); cabeçalhos de segurança em toda resposta, inclusive erro e 404; e um E2E no Edge com o Playwright (o portal de pé em 127.0.0.1, o IdP falso e a prova de que nenhum token é legível pelo JS da página e de que o portal num iframe não carrega). 100% nas 4 métricas nos módulos novos.
- Lint e depcruise: o portal não importa apps/api nem apps/extension; regra nova ganha fixture de prova negativa.
- Mutação dirigida (mut_portal01.py, molde do mutlib.py da sessão 23): cookie sem HttpOnly, SameSite None, sem Secure, state não conferido, verifier no cliente, frame-ancestors retirado, Origin não conferido no logout, a recusa do hook tratada como 503, o 503 tratado como recusa, o amr password aceito e o redirect_to aberto.

ETAPA 3: HITL e runbook [SCRIBE]
- O Redirect URL do portal no painel do Supabase e o roteiro manual do 1º login real (sem segredo no chat), como emenda ao runbook auth-extensao ou num runbook próprio, e o HITL novo (041) com "bloqueia", "o que fazer" e "como responder".

ETAPA 4 (se a janela permitir): F1-API-09 só no desenho
- Emenda ao ADR-004 D5: o teto do AUTH_SESSION_MAX_AGE_SECONDS em 86.400 (o boot recusa o valor que o hook anula), o teste do boot e o test:db da constante. O código espera o HITL-040.

PORTÃO E FASE 4 [SCRIBE]
- Turbo build typecheck lint test em série, sem cache; depcruise; E2E da extensão inteiro no Edge (nada dela deve mudar) e o E2E novo do portal em 3 rodadas; gitleaks 8.30.1 conferido pelo checksums.txt antes de cada push; git fetch antes do push; push sem force.
- STATE a cada etapa; no fim, SESSION-LOG (só acréscimo, no fim do arquivo), BACKLOG, TRILHAS.md (tira a trilha concluída, põe a seguinte e grava o cuidado novo), ADR-027, threat-model, HITL-037 com o ciclo e o next-step (só status, pendências apontando para HITL e runbook, e o prompt).
- O cofre ../base não é versionado: backup no scratchpad antes de editar; o ADR-004 é CRLF e o resto LF, conferidos por bytes depois de cada edição (os scripts vault_pairs.py, vault_block.py, vault_append.py e eol.py do scratchpad da sessão 24 são o molde; escrevam o JSON dos pares com a ferramenta Write, nunca por heredoc no Git Bash).

AO FINAL: o próximo prompt gerado deve ser tão completo quanto este, com as funcionalidades complexas que vierem a seguir (por exemplo a F1-PORTAL-02, o formulário de critérios com o UserCriteria e a escrita pelo cliente de usuário do ADR-018 D5, ou o spike S-3 com P1 a P21 contra o projeto real depois do HITL-040), porque será rodado num modelo mais poderoso.
```
