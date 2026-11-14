# Próximo passo: F1-API-09 no código, F1-PORTAL-02 (critérios no portal: desenho e código) e o PR do 10º ciclo

> **Última entrega, sessão 29 (2026-11-13):** a F1-PORTAL-01 está fechada no código.
> - `f24325c`: o E2E do portal no Edge, com 3 rodadas de 8/8 e a mutação Q- em 8/8.
> - `7798a19`: a correção que o E2E achou. O "Sair" levava `Origin: null` com `Referrer-Policy: no-referrer`; agora é `same-origin`.
> - `830c259`: a prova da conta do tamanho do access usada no runbook.
> - Fora do código: o runbook do 1º login real, o HITL-041 e a F1-API-09 desenhada no ADR-004 D5. O HITL-040 e o HITL-042 (opção B) estão fechados.
>
> Detalhes no `SESSION-LOG`; trilhas e cuidados em `../base/00-orquestracao/TRILHAS.md` (cuidado 36 novo).

## Pendências do humano

- **HITL-037, 10º ciclo:** abrir o PR do `spike/s1-extraction` para o `master`, conferir os 4 checks e mergear com merge commit. O PR leva o `7798a19`, o `f24325c`, o `830c259` e o commit de docs. Runbook `../base/03-infra-runbook/publicar-branch-pr.md` (§4 a §6).
- **HITL-041 (depois do merge):** o 1º login real do portal, com o Google e o GitHub, em `http://127.0.0.1:3100`. A Redirect URL de loopback entra na allow-list só durante o roteiro e é removida no fim. Responda só com atributos, avisos e o número da coluna Size. Runbook `../base/03-infra-runbook/auth-portal.md`.

## Próximo prompt

```text
Equipe, sigam em ciclo estrito de DevSecOps (AGENTS.md), em batelada de etapas com checkpoint no STATE.md entre elas e um commit atômico por etapa. Trilhas: (0) o PR do 10º ciclo, se existir; (1) o código da F1-API-09; (2) a F1-PORTAL-02, primeiro o desenho num ADR novo e depois o código em fatias; e, se a janela permitir, (3) a F1-PORTAL-04 só no desenho. Nada gasta cota de LLM nem chama o Supabase real: o portal é provado contra o GoTrue simulado e uma API simulada do próprio portal, em socket real; tudo que tocar o projeto real é HITL. Push do spike/s1-extraction autorizado no fim de cada etapa, depois do git fetch e do gitleaks 8.30.1 conferido pelo checksums.txt. O repositório é PÚBLICO: nenhum caminho local, e-mail, host real ou ID de scratchpad em arquivo rastreado nem em mensagem de commit (cuidado 35). Se a janela de contexto apertar, parem no fim de uma etapa, gravem o STATE e gerem o next-step com o que falta (AGENTS §4.4).

FASE 1 [ORCHESTRATOR]
- Leiam o STATE.md (bloco da sessão 29), o HITL-QUEUE.md (HITL-037 no 10º ciclo e HITL-041) e o TRILHAS.md (tabela e cuidados 7, 14, 24, 26, 32, 33, 35 e 36). Rodem git fetch, gh pr list --state all --limit 3 e gh pr view <n> --json state,mergeCommit,headRefOid,statusCheckRollup do PR do 10º ciclo. Registrem a divergência se o prompt e o GitHub discordarem: nunca fechem um ciclo do HITL-037 pela declaração.
- Se este prompt trouxer a resposta do HITL-041, façam a conta do access para cada provedor: access = ⌊3·(Size − 66)/4⌋ − 125 (o kid p1 e o refresh de 12 caracteres; com refresh mais longo, é um teto). Registrem o número no ADR-027 D3 (emenda datada) e no threat-model, e fechem a F1-PORTAL-01 por inteiro. Se algum provedor passar de 2.000 caracteres, a decisão de dividir a sessão em dois cookies selados volta ao [ARCHITECT] antes de qualquer outra trilha do portal. Resposta sem "loopback removida e conferida" mantém o HITL-041 aberto.
- Leiam o ADR-004 D5 inteiro, com a emenda da F1-API-09 (sessão 29). Leiam também o ADR-018 (D4 a D6, o cliente de usuário e a RLS), o ADR-021 inteiro (critérios: D2, D4, D8.1 e D9, CriteriaGuard e pretensão s1), o ADR-027 (D1 a D12, a §6 e a §7) e o ADR-007 (borda, CORS por rota e chaves de rate limit). Do contratos-zod, leiam a §4 do user-criteria e o limits. Do threat-model, leiam TB5, TB12, TB13, T33, T49, T50, SR-12, SR-25, SR-26 e a §9.
- Leiam o código antes de propor. Na API: src/infrastructure/auth/auth-session-env.ts e o teste dele, test/compose-app.test.ts, test/db/auth-hook.db.test.ts, src/presentation/routes/criteria.ts, src/presentation/edge/cors.ts e os limites e classes de rate limit da borda. Nos contratos: packages/contracts/src/user-criteria.ts, enums.ts e limits.ts. No portal: apps/web-portal/src/server (gotrue.ts é o molde do cliente HTTP), src/proxy.ts, as rotas, as páginas, test/support/fake-gotrue.ts, test/integration/next-start.test.ts e test/e2e (stack.ts e portal.e2e.test.ts).

ETAPA 0: PR do 10º ciclo [QA_EVALS] + [DEV] (só se o PR existir)
- gh pr checks <n> --watch. Verde: registrem no STATE e no HITL-037 e sigam. Vermelho no test do portal: o Referrer-Policy mudou para same-origin no 7798a19 (a unidade e a integração conferem o valor novo). Confiram o caso que caiu e corrijam o teste ou a configuração, nunca afrouxando uma asserção de cabeçalho. O E2E não roda no CI.

ETAPA 1: F1-API-09 no código [DEV] + [QA_EVALS] (TDD estrito, emenda do ADR-004 D5 já aprovada)
- Testes vermelhos primeiro:
  - test/infrastructure/auth-session-env.test.ts: 86.400 e 3.600 aceitos; 86.401 e 604.800 recusados com a mensagem sem o valor; inatividade acima da idade configurada recusada; o max igual ao fallback;
  - test/compose-app.test.ts: o boot com AUTH_SESSION_MAX_AGE_SECONDS=86401 não sobe, e nenhum log traz o valor;
  - test/db/auth-hook.db.test.ts: o secs => N do pg_get_functiondef é igual ao max e ao fallback do AUTH_SESSION_LIMITS.
- Depois o código: o AUTH_SESSION_LIMITS.maxAgeSeconds.max vai a 86_400, e o comentário do DECIMAL_SECONDS é atualizado (a regex fica).
- Mutação mut_api09.py (molde do mutlib.py da sessão 29: vários pares por mutante e a saída em mutlogs/, conferindo QUAL teste caiu):
  - o teto de volta a 604.800;
  - o > trocado por >= no corte;
  - o fallback diferente do max;
  - o test:db comparando só com o fallback, provado na pilha local da CLI 2.120.0 com Docker (o job db do ci.yml) ou na pilha simulada da sessão 24.
- O test:db novo só se prova no job db do PR (gh pr checks --watch).
- Cofre: o aviso do .env no runbook auth-extensao §1.5 (quem tiver AUTH_SESSION_MAX_AGE_SECONDS acima de 86.400 no apps/api/.env não sobe a API; a equipe nunca lê o .env), o BACKLOG F1-API-09 e o mapa do guia se algum arquivo mudar de papel.

ETAPA 2: F1-PORTAL-02, desenho [ARCHITECT] + [APPSEC], sem código (ADR-028 novo, com a auditoria do [APPSEC] e as condições numeradas)
- Fatos antes do desenho, pela documentação da versão instalada em node_modules/next/dist/docs (Server Functions e Server Actions, data-security.md, forms e a proteção de Origin e Host das Server Actions) e pelo código da API. Nada de memória.
- Decisões em aberto:
  - Caminho dos dados:
    - (A) recomendação a provar: o servidor do portal chama o GET e o PUT /v1/criteria da API com o Bearer do access do cookie selado, servidor a servidor. A API continua dona da pretensão cifrada (s1, anel só na API), do CriteriaGuard, da RLS pelo PostgREST e do bodyLimit;
    - (B) o portal fala direto com o PostgREST pelo cliente de usuário do ADR-018 D5. Exigiria o anel da pretensão no portal, e o [APPSEC] deve avaliar o veto.
  - Cliente HTTP da API no portal (src/server/api-client.ts, molde do gotrue.ts, reescrito):
    - lista fechada de cabeçalhos, só o Bearer e o content-type, nunca o cookie do navegador;
    - redirect "error", prazo explícito, teto de resposta, UTF-8 estrito e JSON sem chave de protótipo;
    - classificação recusado | nao_recebido | pode_ter_gravado, sem nova tentativa no PUT;
    - nunca rejeita.
  - Variável nova API_ORIGIN (https exato, ou http só em loopback), no D9 do ADR-027 e no .env.example.
  - Borda da API para o portal:
    - o CORS por rota para pedido sem Origin (servidor a servidor);
    - o rate limit da classe criterios, cuja chave é por usuário ou por IP: com todos os usuários atrás do IP do portal, a chave por IP vira um balde só, e é preciso decidir;
    - o 401 da API com sessão válida no portal (sid revogado, hook) vira "entre de novo" e apaga o cookie;
    - o 503 e o 429 viram "indisponível" sem perder a sessão;
    - renovar antes de chamar a API quando o access tem até 60 s pela frente (como o logout, D7).
  - Formulário: Route Handler POST /conta/criterios (Origin exato e Sec-Fetch-Site same-origin, como o logout, com corpo application/x-www-form-urlencoded) ou Server Action (proteção de Origin e Host do Next, ID da action, compatibilidade com a CSP de nonce e com o cacheComponents desligado). Escolham uma e provem que funciona SEM JavaScript de cliente: nenhum "use client" nesta trilha.
  - Mapeamento campo a campo do formulário para o UserCriteriaSchema (strictObject) do @trampo/contracts:
    - listas de enums fechados (enums.ts) e tetos do limits.ts (o CRITERIA_BODY_MAX_BYTES de 12.288);
    - nenhum texto livre alimentando regra;
    - o erro de validação volta ao formulário só com o nome do campo e um texto do catálogo fechado, nunca com o texto do Zod.
  - LGPD e pretensão salarial:
    - a pretensão só aparece para o dono, na /conta/criterios, com Cache-Control: no-store;
    - nunca em URL, log ou aviso;
    - o rascunho que falhou volta renderizado pelo servidor, sem localStorage.
  - Depcruise: o portal pode importar @trampo/contracts/user-criteria (a extensão não, F-02), mas nunca a API.
  - Threat-model:
    - TB5 (portal → API) vira real;
    - ficha nova para o portal como *confused deputy* (o Bearer do usuário repassado só para a origem fixa da API, sem SSRF, porque o destino nunca vem do pedido);
    - SR novo para a gravação de critérios pelo portal;
    - residual do balde de rate limit compartilhado.
- Plano de testes: unidade 100% em src/server, integração contra o next start com o fake-gotrue e uma API simulada nova (test/support/fake-api.ts: GET e PUT /v1/criteria, Bearer conferido contra os access emitidos pelo fake-gotrue, modos 401, 403, 413, 429, 503, lento e corta), E2E pelo botão real (cuidado 36) e a mutação mut_portal02.py (U-, I- e Q-).

ETAPA 3: F1-PORTAL-02, código parte 1 [DEV] + [QA_EVALS]
- Contrato primeiro: se o formulário precisar de um schema de borda (form → UserCriteria), ele nasce em packages/contracts com z.strictObject, e o contratos-zod §4 é regerado por script (DOC-01).
- src/server/api-client.ts, a DAL de critérios (ler e gravar, com a renovação antes e o mapa de erros do desenho) e o fake-api.ts, com os testes antes do código e 100% nas 4 métricas.
- Mutação do núcleo: U- pela unidade.

ETAPA 4: F1-PORTAL-02, código parte 2 [DEV] + [QA_EVALS]
- A página /conta/criterios (Server Component, sem JS próprio, nonce em todo script), a rota ou action de gravação, o link na /conta e os avisos do catálogo.
- Integração contra o next start: cabeçalhos uma vez cada na página nova, no-store, Origin e Sec-Fetch-Site na gravação, open redirect na tabela, nenhum segredo nem a pretensão na saída do processo.
- E2E no Edge: preencher e salvar pelo botão real. O valor salvo volta ao abrir de novo, a pretensão nunca vai a URL, o 401 da API vira "entre de novo", o 503 mantém a sessão e o rascunho, e não há erro de CSP. 3 rodadas.
- Mutação: I- pela integração e Q- pelo E2E com rebuild, em primeiro plano e em lotes de 3 ou 4; reconstruam o portal no fim.

ETAPA 5 (se a janela permitir): F1-PORTAL-04 só no desenho ("Sair de todos os dispositivos")
- Emenda ao ADR-027 D7: logout com escopo global por POST com Origin exato e uma confirmação sem JS (uma 2ª página com o próprio formulário). O efeito na extensão (a sessão dela cai na próxima renovação) aparece no texto da página. Mapa de erros igual ao do logout local, e T41 e T44 revistos.

PORTÃO E FASE 4 [SCRIBE]
- Turbo build typecheck lint test em série, sem cache; depcruise; E2E da extensão inteiro no Edge (nada dela deve mudar) e o E2E do portal em 3 rodadas depois do build. Gitleaks 8.30.1 conferido pelo checksums.txt antes de cada push, a varredura pública (caminho, e-mail, host e ID de scratchpad, com controle positivo) nos commits e no docs/, git fetch antes do push e push sem force.
- STATE a cada etapa. No fim:
  - SESSION-LOG (só acréscimo, no fim do arquivo);
  - BACKLOG (F1-API-09 fechada só com o job db verde no PR; F1-PORTAL-02 fechada só com o E2E verde);
  - TRILHAS.md (tira a trilha concluída, põe a seguinte e grava o cuidado novo);
  - ADR-028 e as emendas do ADR-027, do ADR-021 e do ADR-004;
  - threat-model;
  - o guia (o mapa do 03 a cada arquivo novo em src e test; o 01 e o 02 se o fluxo de critérios mudar);
  - o docs/ regenerado pelo publish_docs.py da sessão 28, com o gitleaks dir docs;
  - o HITL-037 com o ciclo;
  - o next-step (só status, pendências apontando para HITL e runbook, e o prompt).
- O cofre ../base não é versionado: backup no scratchpad antes de editar. O ADR-004 é CRLF e o resto é LF, conferidos por bytes depois de cada edição. Escrevam scripts e JSON com barra invertida pela ferramenta Write, nunca por heredoc no Git Bash: o shell colapsa as barras, até numa regex de grep.

AO FINAL: o próximo prompt gerado deve ser tão completo quanto este, com as funcionalidades complexas que vierem a seguir, porque será rodado num modelo mais poderoso. Exemplos: a F1-PORTAL-03 (exportar e excluir a conta, LGPD, com o apagamento em cascata provado no job db); a F1-PORTAL-04 no código; o spike S-3 com P1 a P21 contra o projeto real por HITL (o P18 já está destravado pelo HITL-040); ou a hospedagem do portal no S-5 (HSTS com preload, a Redirect URL definitiva e o Site URL).
```
