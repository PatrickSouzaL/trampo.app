---
tipo: adr
id: ADR-019
titulo: "CI no GitHub Actions: portão do monorepo, varredura de segredos, política verificável do workflow e job do banco (SR-15)"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]) dentro do ADR-001 §10, do threat-model (T26, T27; SR-03, SR-13, SR-14) e do ADR-018 (emenda ao D1). Push autorizado pelo humano em 2026-10-22 (PR #4 mergeado). Configurar a proteção do branch e as permissões de Actions no GitHub é ação humana (HITL-025, aberto ao fim da parte 1)."
data: 2026-10-22
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)", "[SCRIBE]"]
escopo: "F1-OPS-01 (.github/workflows, .gitleaks.toml, packages/ci-policy; parte 2: supabase/, apps/api test:db)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-018-postgres-schema-rls-and-criteria](ADR-018-postgres-schema-rls-and-criteria.md)", "[threat-model](../threat-model.md)", "*supabase-local*", "*BACKLOG §F1-OPS-01*", "*BACKLOG §QA-01*"]
---

# ADR-019: CI no GitHub Actions

## 1. Contexto

O monorepo não tem CI. O portão (build, lint, typecheck, testes com cobertura de 100%, depcruise) roda só na estação, em série. Três itens esperam o CI:
- **SR-14** (varredura de segredos) e a mitigação 5 do **T26** (`--frozen-lockfile` no CI);
- **QA-01:** o SR-09 (200 ms de relógio de parede) oscila quando o `api:test` disputa CPU com o `next build`. O humano decidiu não afrouxar o orçamento e isolar no CI (2026-10-21);
- **F1-DB-01 parte 3** (emenda ao ADR-018 D1): migrations e teste de RLS do SR-15 só no *runner*, porque a estação não comporta o Supabase local (HITL-022).

O repositório `PatrickSouzaL/trampo.app` é **privado** (cota de minutos do plano gratuito) e o PR #4 foi mergeado em 2026-10-22, o que autoriza o push.

O workflow é código que roda com acesso ao repositório. Ele precisa da mesma disciplina do resto: versão fixa, privilégio mínimo e um teste que derrube regressão.

## 2. Decisões

### D1. Partição (AGENTS §4.1)
| Parte | Entrega | Verificação |
|---|---|---|
| **1** | `ci.yml` com os jobs `secrets`, `quality` e `test`; `.gitleaks.toml`; pacote `@trampo/ci-policy` com a política do workflow testada | local: política, gitleaks e portão; no GitHub: primeira execução depois do push (HITL-025) |
| **2** | Job `db`: `supabase init`, migrations do ADR-018 D2 e D3, projeto Vitest `test:db` com o SR-15 completo | só no *runner* (HITL-022); verde abre o HITL-023 |
| **3** | Renovate com atraso (actions por SHA, `minimumReleaseAge`), job do e2e da CSP (SR-02) e gate de evals (depende do F1-EVL-01) | no GitHub |

### D2. Gatilhos e permissões
- `on`: `push` no `master` e `pull_request` para o `master`. Mais nada. **Proibidos:** `pull_request_target`, `workflow_run`, `issue_comment` e qualquer gatilho que rode código de PR com permissão de escrita.
- `permissions: { contents: read }` no topo. Job nenhum pede escrita.
- **Nenhum segredo no CI.** Nem `secrets.*`, nem `GITHUB_TOKEN` explícito. O job `db` usa só as chaves de demonstração que o Supabase local gera no próprio *runner*.
- `concurrency` por workflow e ref, cancelando a execução anterior do mesmo PR.

### D3. Cadeia de suprimentos das actions (T26)
- Toda `uses:` é `dono/repo@<SHA de 40 hex>` com a tag no comentário. Tag móvel, branch, `docker://` e action local são proibidos.
- **Lista fechada de actions:** `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `pnpm/action-setup` v6.1.0 e, na parte 2, `supabase/setup-cli`. Action nova exige mudar a política (revisão do `[APPSEC]`).
- Versão escolhida com pelo menos 7 dias de publicação (a da `setup-node` tem 14).
- `actions/checkout` sempre com `persist-credentials: false`: o token não fica no `.git/config` para os passos seguintes.
- **Sem cache** na parte 1: nem `cache` do `setup-node`, nem do `pnpm/action-setup`, e `package-manager-cache: false`. Cache compartilhado entre execuções é vetor de envenenamento. O custo (instalação a frio) é aceito; revisar com números no S-5.
- `pnpm install --frozen-lockfile`. As políticas do `pnpm-workspace.yaml` (`strictDepBuilds`, `minimumReleaseAge`, `trustPolicy`, `blockExoticSubdeps`) valem no *runner* do mesmo jeito.
- Proibidos nos `run:`: `npx`, `pnpm dlx`, `pnpx` e `curl`/`wget` com pipe para shell. Download só com `sha256sum --check` no mesmo passo.

### D4. Injeção de script
- Nenhum `run:` contém `${{ }}`. Valor de contexto entra por `env:` e é lido como variável de shell. Isso fecha a injeção por título de PR ou nome de branch.

### D5. Jobs da parte 1
- **Runner fixo** `ubuntu-24.04` (nunca `*-latest` nem `self-hosted`), `timeout-minutes` em todo job (teto de 30), **Node 24**, o piso do `engines` e a linha LTS. A estação roda 26; o CI prova o piso.
- **`secrets`:** checkout com histórico completo e **gitleaks 8.30.1** baixado do release oficial, com o sha256 do `linux_x64` fixado no workflow e conferido antes de extrair. É o binário, não a `gitleaks-action` (que pede token e licença em organizações). Varre **todo o histórico** com `--redact`. Sem Node.
- **`quality`:** install, `turbo run build lint typecheck` e `pnpm lint:deps` (SR-03 e SR-13).
- **`test`:** install e `turbo run test --concurrency=1` num job **próprio**. Cada job é uma VM nova: o SR-09 não disputa CPU com o `next build` do `quality` (QA-01). As cotas de 100% de cada pacote valem como estão. Inclui o teste do manifesto da extensão (SR-02 estático) e o da política do workflow.
- Telemetria do Turborepo desligada (`TURBO_TELEMETRY_DISABLED`, `DO_NOT_TRACK`).

### D6. Falsos positivos do gitleaks
A varredura local (2026-10-22, gitleaks 8.30.1 com o binário conferido) achou **9 ocorrências, todas *fixtures* falsas** dos testes da API: tokens JWS montados à mão (`{"sub":"a"}`, assinatura `c2lnbmF0dXJh`), a chave *secret* fictícia `sb_secret_AbC123-teste_xyz` e o prefixo legado `eyJhbGciOiJIUzI1NiJ9`.
- `.gitleaks.toml` estende a configuração padrão e libera **cada valor exato** por regex ancorada (`regexTarget = "match"`). **Não** libera caminho: um segredo real colado num arquivo de teste continua sendo pego.
- *Fixture* nova que dispare o gitleaks entra na lista com revisão do `[APPSEC]`, ou passa a ser montada em tempo de execução.
- **Emenda (2026-11-09, incidente do PR #18):**
  - o job `secrets` falhou com `leaks found: 1`. A regra padrão `generic-api-key` pegou, no commit `cd141d2` (F1-EXT-05a 05a-4), o canário `Q0FOQVJJTy1uYW8tZS1jaGF2ZQ==` do `apps/extension/test/manifest.test.ts`, base64 de `CANARIO-nao-e-chave`. Ele prova que o build recusa uma `TRAMPO_EXTENSION_KEY` fora da forma sem ecoar o valor. Falso positivo;
  - o gitleaks varre o *patch* de cada commit. Montar o valor em tempo de execução num commit novo não tira o achado do commit já publicado, e reescrever o histórico do PR exigiria *force push*. Por isso, as duas saídas do D6 foram aplicadas juntas (`56c6612`): o valor exato e ancorado entrou na lista (`[APPSEC]`: falso, ancorado, sem caminho) e o teste passou a montá-lo com `Buffer.from(...)`;
  - prova: gitleaks 8.30.1 local (binário do Windows conferido pelo `checksums.txt` do release, cujo hash do `linux_x64` é o mesmo fixado no workflow) com 0 achados nos 167 commits. Prova negativa num diretório descartável: um valor com 1 caractere diferente continua pego, e o valor exato sem a liberação também. `@trampo/ci-policy` 258/258 e extensão 1.255/1.255, os dois com 100%;
  - resultado: `secrets`, `quality`, `test` e `db` verdes no run `42624571844` (head `56c6612`);
  - lição: o CI só roda em PR para o `master`, então um achado num commit do branch só aparece no PR. Quem escrever *fixture* com cara de chave (base64 longo ao lado de `KEY`, `TOKEN` ou `SECRET`) monta o valor em tempo de execução desde o primeiro commit, ou roda o gitleaks local antes do push.

### D7. Política do workflow como teste (`@trampo/ci-policy`)
As regras D2 a D5 viram uma função pura, `auditWorkflow(documento)`, que devolve a lista de violações. Um teste carrega **todo** arquivo de `.github/workflows/` e exige zero violação. O teste roda no `pnpm test`, então o próprio CI derruba um workflow que afrouxe a política.
- Parser: `js-yaml` 4.3.2, que já está no lockfile (transitiva do ESLint), com o `CORE_SCHEMA`. Vira devDependency pelo `catalog:`; nenhum pacote novo é baixado. Os tipos são uma declaração local mínima, sem `@types/js-yaml`.
- Cobertura de 100% e mutação, como no código de produção.

### D8. Parte 2 (job `db`), fixado agora para a auditoria
- `supabase/setup-cli` por SHA, com a versão do CLI fixa.
- `supabase start` só com o necessário (Postgres, GoTrue e PostgREST); os demais serviços ficam de fora com `-x`.
- **Nunca** `supabase link`, `db push` nem `SUPABASE_ACCESS_TOKEN`. O teste recusa URL que não seja `127.0.0.1` ou `localhost`.
- As chaves vêm do `supabase status` no próprio *runner*. São as de demonstração do CLI, públicas e sem valor fora dele.
- `test:db` num projeto Vitest separado, fora do `pnpm test` (ADR-018 D7).

## 3. Auditoria `[APPSEC]`
**Sem veto.** Critérios de aceite da parte 1:

1. **Política verificada por teste**, não por revisão: SHA de 40 hex, lista fechada de actions, `persist-credentials: false`, permissões só de leitura, gatilhos fechados, nenhum `secrets.*`, nenhum `${{ }}` em `run:`, runner fixo, prazo em todo job, sem cache, `--frozen-lockfile` e download só com sha256. Cada regra com teste negativo.
2. **O workflow real passa na política** dentro do `pnpm test`.
3. **gitleaks sem achados** no histórico inteiro, com a lista de liberação só de valores exatos e falsos.
4. **Nenhum segredo** no workflow, no cofre ou no git.
5. **SR-09 isolado** num job próprio, sem mudar o orçamento.

**Riscos residuais aceitos:**
- **Action fixada por SHA ainda pode ter código malicioso naquele commit.** A lista fechada, as versões com pelo menos 7 dias e a revisão manual de cada troca (até o Renovate da parte 3) reduzem a janela.
- **Sem proteção de branch, o CI é só informativo.** Exigir os checks no `master` é configuração do repositório, que a equipe não alcança: HITL-025.
- **O gitleaks olha só o que foi commitado.** Segredo em `.env` local continua protegido só pelo `.gitignore` (T27).
- **Node 24 no CI e 26 na estação:** uma diferença de runtime aparece no CI, que é onde deve aparecer.

### 3.1 Parte 1 entregue (2026-10-22, commit `b48a6cc`, local)
Código:
- `.github/workflows/ci.yml`: jobs `secrets`, `quality` e `test` (D5);
- `.gitleaks.toml`: padrão estendido e 8 valores exatos liberados (D6);
- `packages/ci-policy`: `auditWorkflow`, `WORKFLOW_POLICY` e `parseWorkflow`, com a declaração local do `js-yaml`;
- `pnpm-workspace.yaml`: `js-yaml: 4.3.2` no `catalog:`. O lockfile ganhou só o importador e a entrada do catálogo (`pnpm install --offline`, nenhum download).

Refinamentos do desenho, sem mudar decisão:
- **Instalação fora do pnpm é proibida por inteiro** (`npm`, `yarn`, `pnpm add`), não só a sem lockfile. O `run_install` do `pnpm/action-setup` também.
- **O pipe para shell conta só na linha do `curl`/`wget`.** Download para arquivo, conferido por `sha256sum --check` no mesmo passo, é o único caminho aceito.
- **`with` que não é objeto vale como vazio**, então cai na regra (credencial ou cache) em vez de passar.
- **Segredo procurado em toda string do documento** (`env`, `with`, gatilhos, listas), não só no `run`.

Verificação:
- **Política:** 134 testes, 100% de cobertura (108/108 ramos). Cada regra tem caso negativo, e o `ci.yml` real passa com zero violação.
- **Mutação**, um mutante por vez, com o script em arquivo no scratchpad e o sha256 do original conferido depois de cada um: **74 mutantes, 72 mortos e 2 equivalentes**. Os sobreviventes R18 (`\b` antes do `sha256sum`) e U9 (`with` que não é objeto) viraram 2 testes. Os equivalentes:
  - B3 (`typeof runner !== "string"`): o `includes` já recusa o que não é string. Fica como *type guard*;
  - B7 (`typeof timeout === "number"`): o `Number.isInteger` já recusa. Fica como *type guard*.
- **gitleaks 8.30.1 local** (binário conferido pelo sha256 do release): o histórico inteiro, inclusive o commit `b48a6cc`, sai **sem achados**. Prova negativa num repositório descartável: com a fixture liberada e duas chaves novas no mesmo arquivo de teste, as duas novas são pegas.
- **Portão:** turbo 21/21 em série (`build lint typecheck test`) e depcruise sem violações (362 módulos).
- **Não verificado nesta janela:** a execução no GitHub. Ela depende do push (HITL-025).

**Auditoria `[APPSEC]` do código: sem veto.**

| Critério | Situação |
|---|---|
| 1 (política por teste) | **cumprido:** as 16 regras com caso negativo e mutação |
| 2 (workflow real na política) | **cumprido:** `repo-workflows.test.ts` no `pnpm test` |
| 3 (gitleaks sem achados) | **cumprido localmente:** zero no histórico, liberação só por valor exato. No CI, depois do push |
| 4 (nenhum segredo) | **cumprido:** o workflow não lê `secrets.*` nem `github.token`. O `.env` não foi lido: a varredura de diretório, que não vai para o CI, foi rodada uma vez com `--redact` e só listou arquivos ignorados pelo git, sem valor |
| 5 (SR-09 isolado) | **cumprido no desenho:** o job `test` é uma VM só dele. Confirmação na primeira execução (fecha o QA-01) |

Risco residual novo, aceito: **o `pnpm/action-setup` instala o pnpm do registry npm** pela versão do `packageManager`. A action está fixada por SHA, mas o pnpm baixado é conferido só pela integridade do registry. O `minimumReleaseAge` não se aplica a ele. A versão é fixa (11.4.0), então não há atualização silenciosa.

### 3.2 Parte 2 entregue (2026-10-22, local; a execução no GitHub é o HITL-026)
**HITL-025 fechado** (humano, 2026-10-22): os jobs `secrets`, `quality` e `test` ficaram verdes no GitHub Actions; as actions estão restritas e o `GITHUB_TOKEN` é só leitura; proteção do `master` pela **opção B** (GitHub Pro, PR e *status checks* obrigatórios). O **QA-01 fechou** com o job `test` verde.

Código:
- `supabase/`: `config.toml` gerado pelo `supabase init` da CLI 2.120.0 (binário do release, conferido pelo `checksums.txt`, no scratchpad), com Studio, Realtime, Storage, SMTP local, Edge Runtime, Analytics e o *seed* desligados; a migration `20261022230000_criterios_analises_feedback.sql` (ADR-018 D2 e D3, ver o ADR-018 §3.3);
- `ci.yml`: job `db` (D8). `supabase/setup-cli` **v2.1.2** por SHA (`afb1b151…`), com `version: "2.120.0"`. O passo seguinte confere por sha256 os dois binários extraídos (`supabase` e `supabase-go`) antes de qualquer comando nosso, desliga a telemetria da CLI e só então sobe a pilha com `-x` (fica só Postgres, GoTrue, PostgREST e Kong). Do `supabase status -o env` saem só `API_URL`, `DB_URL` e `PUBLISHABLE_KEY`;
- `apps/api`: `test:db` (`vitest.db.config.ts`, fora do `pnpm test`), com o guarda `test/db/support/local-stack-env.ts`, o acesso `local-stack.ts` (fetch com `redirect: "error"` e `psql` com ambiente limpo) e as consultas de catálogo `catalog-sql.ts`;
- `@trampo/ci-policy`: `supabase/setup-cli` na lista fechada e duas regras novas, cada uma com caso negativo:
  - **`versao_nao_fixa`:** o `setup-cli` exige `version` semver exata (sem `latest`, `beta`, `v`, intervalo ou pré-release), e o `github-token` conta como `segredo`;
  - **`supabase_remoto`:** em `run`, só os subcomandos `start`, `status`, `stop`, `telemetry` e `--version` (lista positiva: `link`, `db push`, `login`, `projects`, `secrets` e qualquer comando novo ficam de fora). Em todo o documento, **inclusive nas chaves de objeto**, nenhuma marca do projeto real: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `--db-url`, `--linked`, `--project-ref` e `*.supabase.co|com|in`.

Refinamentos do desenho, sem mudar decisão:
- **`setup-cli` v2.1.2, não a v3.0.1:** as duas baixam dependências com o `bun install --frozen-lockfile` e não conferem o binário da CLI. A v3 instala a CLI pelo npm, com o `postinstall` do pacote `supabase`; a v2.1.2 baixa o tarball direto do release. A v2.1.2 tem menos peças, e o sha256 dos binários fixado no workflow fecha a lacuna do lado de cá. As duas têm mais de 7 dias (29 e 28).
- **CLI 2.120.0 (16 dias), não a 2.121.0 (8 dias):** a mesma folga da `setup-node`.
- **O guarda aceita só `127.0.0.1`** (ordem do humano de 2026-10-22, mais estrita que o D8, que admitia `localhost`). É uma lista positiva por regex ancorada, sem parser de URL: o libpq lê a URI do banco por conta própria (multi-host, `?host=`, `?hostaddr=`). O guarda também recusa a presença de `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_ID` e `SUPABASE_PROJECT_REF`, mesmo vazias, e qualquer chave que não seja publishable.
- **Nenhuma chave *secret* nem `service_role` no teste:** usuários pelo `/auth/v1/signup` (o local não confirma e-mail) com a publishable; o *cascade* sai por SQL (`delete from auth.users`) como `postgres` no banco local. O `psql` roda com ambiente limpo (só o `PATH`): nenhuma `PGHOST`, `PGHOSTADDR` ou `PGSERVICE` do runner redireciona a conexão.
- **O teste exercita o adapter real da API** (`createPostgrestUserClient` + `createSupabaseCriteriaRepository` + `SalaryCipher` com chave gerada no teste) contra o PostgREST de verdade: A lê e abre a pretensão; B, com o `userId` de A, recebe `found: false`. É a prova de que a RLS sozinha segura, mesmo se a primeira barreira errasse o dono.

Verificação local (a estação não tem Docker; o runner é a prova definitiva):
- **Simulação do runner, fora do repositório** (scratchpad): PGlite 0.5.8 (Postgres 18 em WASM, sem dependências, instalado com `--ignore-scripts`, 57 dias de publicação) com um esboço do Supabase: schema `auth`, `auth.uid()` igual ao do Supabase, `anon`, `authenticated` e `service_role` (com `BYPASSRLS`), e o *default privilege* que dá tudo a eles em tabela nova. A migration roda como um dono que não é superusuário.
  - **88 cenários SQL do SR-15** (como o PostgREST os executa: `SET ROLE` e o claim do `sub`), com as mesmas consultas de catálogo do repositório: 88/88.
  - **O próprio `rls.db.test.ts`**, por um emulador mínimo de Auth e PostgREST em `127.0.0.1` sobre o mesmo PGlite e um `psql` de mentira (compilado com o `csc` do .NET, que repassa o SQL ao emulador): **47/47**, com 100% de cobertura no `local-stack.ts` e no `catalog-sql.ts`. Ele também provou o ambiente limpo do `psql`: a variável do emulador não chegou ao processo filho.
  - Sem o ambiente, e com uma URL `*.supabase.co`, o `pnpm test:db` falha no guarda antes de qualquer conexão.
- **Mutação**, um mutante por vez, script em arquivo no scratchpad, original conferido por sha256 depois de cada um:
  - **migration, pela simulação SQL e de novo pela suíte do CI no emulador:** 65 mutantes, **63 mortos e 2 equivalentes**. O `revoke` de `PUBLIC` é equivalente porque o Supabase não dá grant padrão de tabela a `PUBLIC`; fica como defesa. O teto de 1.024 caracteres também é equivalente: o regex do envelope já limita a 402. Fica por espelhar o ADR-018 D2;
  - **`@trampo/ci-policy`:** 32 mutantes, 31 mortos e 1 equivalente (`typeof version`, um *type guard*: o regex já recusa número). Três sobreviventes da 1ª rodada viraram testes: marca em chave do `env` de um passo, subdomínio `.supabase.company` e palavra que só contém `supabase`;
  - **guarda do `test:db`:** 35 mutantes, 35 mortos. Três sobreviventes da 1ª rodada viraram testes: texto antes da URL do banco, texto antes da chave e o ponto do IP como curinga.
- **Testes:** `@trampo/ci-policy` com 175 (100%, 124/124 ramos); API com 2.162 (54 novos do guarda; 100%, 1.795/1.795 ramos).
- **Portão:** turbo 21/21 em série e depcruise sem violações (368 módulos).
- **gitleaks 8.30.1** (Windows, conferido pelo `checksums.txt`): histórico sem achados, e os 17 arquivos novos e alterados também. As *fixtures* novas são montadas em tempo de execução, então o `.gitleaks.toml` não mudou.
- **Não verificado nesta janela:** o job `db` no GitHub (HITL-026).

**Auditoria `[APPSEC]` do código e do YAML: sem veto.**

| Critério | Situação |
|---|---|
| `setup-cli` na lista fechada, por SHA e com a CLI fixa | **cumprido:** a regra `versao_nao_fixa` e o teste do workflow real |
| Nunca `link`, `db push`, token nem o projeto real | **cumprido:** lista positiva de subcomandos e marca do projeto real proibida em valor e em chave. O guarda recusa URL fora de `127.0.0.1` e as variáveis de credencial |
| Nenhuma credencial vaza | **cumprido:** o job não lê `secrets.*`; do `status` saem só 3 variáveis, nenhuma secret. O `.env` não foi lido. O gitleaks está limpo |
| D2 (gatilhos, permissões e nenhum segredo) e D4 (nenhum `${{ }}` em `run`) | **mantidos:** o job novo passa na política inteira |

**Riscos residuais novos, aceitos:**
- **A `setup-cli` roda `supabase --version` antes da nossa conferência**, ou seja, um binário ainda não conferido executa uma vez dentro da action. O job não tem segredo, o token é só leitura e a VM é descartável. Um binário trocado é pego no passo seguinte, que derruba o job antes do `start` e do teste.
- **A action instala o Bun (`oven-sh/setup-bun`, fixado por SHA dentro dela) e as dependências dela** com o `bun install --frozen-lockfile`, pela integridade do `bun.lock`, sem o `minimumReleaseAge` do nosso pnpm.
- **As imagens Docker do `supabase start`** são fixadas pela versão da CLI (tags), não por *digest*.
- **O emulador local não é o PostgREST.** As diferenças de mapeamento (status HTTP por código do Postgres e o formato do erro) aparecem só no runner. É por isso que a parte 2 fecha só com o job `db` verde.

### 3.3 Parte 2 fechada no GitHub (2026-10-23, HITL-026)
**Job `db` verde** no run `39964371879` (commit `852e852`): o Supabase local subiu no runner, a migration aplicou, e o `test:db` passou com **47/47** contra o Auth e o PostgREST de verdade. A regra do `master` passou a exigir `secrets`, `quality`, `test` e `db`. O PR #6 foi mergeado (`031fcf1`). A equipe conferiu o run e a regra pelo `gh`, só lendo.

Mudanças no caminho (todas de configuração, com a política verde):
- **Hotfix de CVE do Node (`1cc4055`, sessão própria, *SESSION-LOG* de 2026-10-23 e [threat-model](../threat-model.md) §0.2):** `node-version` `24.22.1` nos 3 jobs (antes `"24"`), `.nvmrc` `26.12.1` e `engines.node` `^24.22.1 || >=26.12.1 <27`. O teste do workflow passou a fixar `24.22.1`. Refina o D5: o Node do CI agora é exato, não só a linha.
- **Lista de actions (`35875b3`, `da1a732`, do humano):** o 1º run deu `startup_failure` com a lista mal formatada. A lista correta é separada por vírgula.
- **Build antes do `test:db` (`852e852`, do humano):** o 2º run falhou com `Failed to resolve entry for package "@trampo/contracts"`. O `test:db` roda fora do turbo, então o `^build` não dispara, e o runner não tem o `dist/` dos contratos. A correção foi o passo `pnpm exec turbo run build --filter=@trampo/api^...` entre o `install` e o `test:db`, com teste de ordem no `@trampo/ci-policy`.

**Lição (para as próximas simulações do runner):** a simulação local rodou numa árvore que já tinha os `dist/` compilados. Toda simulação de job novo parte de um *checkout* limpo (`git worktree` ou `git clone` local, sem `dist/` nem `node_modules`), e roda os passos do job na mesma ordem do YAML.

`[APPSEC]`: sem veto. O passo novo só compila pacotes do workspace, com o lockfile congelado, e não lê segredo. Os riscos residuais da §3.2 continuam valendo.

### 3.4 Emenda do 07h: contrato de autenticação no job `db` (F1-API-07, 2026-11-07, `4efd96c`)
O job `db` passa a provar também o BFF de autenticação do [ADR-004-extension-auth](ADR-004-extension-auth.md) (§4.3 e D8 item 5) contra o GoTrue da pilha local. Nada muda nos gatilhos, nas permissões, nas actions nem na lista de subcomandos da CLI.

**Engenharia do teste local:**
- **Chave ES256 do GoTrue, nascida e morta na VM.** Passo novo antes do `supabase start`: `node apps/api/test/db/support/write-signing-key.ts supabase/signing_keys.json`. O script roda direto no Node 24 (só tipo apagável e só módulos `node:`), grava uma lista com uma JWK P-256 privada e `kid` aleatório, com `wx` (nunca sobrescreve) e modo 0600, e recusa outro nome de destino. Nada vai para a saída. O comando `supabase gen signing-key` ficou de fora: as *flags* não foram confirmadas, e ele exigiria abrir a lista positiva de subcomandos.
- **`config.toml` espelhando a produção:** `jwt_expiry = 900` (o `maxTokenAge` do verificador, HITL-004) e `signing_keys_path = "./signing_keys.json"`. A rotação com reuso de 10 s e os limites 150 e 30 já estavam iguais aos do projeto real (P19).
- **Dois grupos no `test:db`** (`vitest.db.config.ts`, `groupOrder`): o grupo `db` (RLS do SR-15, gravação de critérios e o contrato de auth) e, depois, o `db-limite` (a sonda do limite por IP), porque a sonda esvazia o balde do `/token`. A cobertura do `test:db` ganhou o `auth-stack.ts`, sem ramo; a contagem da sonda (`rate-limit-probe.ts`) fecha no `pnpm test`, porque o job percorre só um dos ramos dela.
- **Só a pilha local:** os testes novos passam pelo mesmo `parseLocalStackEnv` (só `127.0.0.1` e a publishable), e o usuário nasce pelo `/signup` com senha. Nenhuma chave *secret* nem `service_role`.

**Gates novos no `@trampo/ci-policy`:**
- a chave nasce antes do `start`, e nenhum outro passo cita o `signing_keys.json`;
- o `config.toml` tem `jwt_expiry = 900`, o `signing_keys_path`, a rotação, o reuso de 10 s e os limites 150 e 30;
- o `.gitignore` barra o `supabase/signing_keys.json` e o `*.pem`;
- **regra própria do gitleaks** (`gitleaks-config.ts` e `gitleaks-config.test.ts`): `trampo-auth-seal-keys` e `trampo-auth-seal-keys-files` ([ADR-004-extension-auth](ADR-004-extension-auth.md) §4.8). O leitor aceita só o subconjunto do TOML que o repositório escreve, recusa allowlist, `entropy` ou qualquer chave desconhecida dentro de uma regra própria, e recusa regex que o RE2 e o V8 leriam diferente (lookaround, referência para trás, flag solta e `(?P<`). A árvore versionada inteira passa pelas duas regras no `pnpm test`.

**Verificação local** (a estação não tem o *daemon* do Docker, e o download do binário do gitleaks foi negado nesta sessão):
- `@trampo/ci-policy` com 258 testes e a API com 3.553, as duas com 100% nas 4 métricas; turbo 21/21 em série na 1ª rodada; depcruise sem violações (480 módulos);
- mutação dirigida, um mutante por vez, com o original conferido por sha256: **57 mutantes, 56 mortos e 1 equivalente** (a flag solta `(?i)`, que o V8 já recusa ao compilar). Quatro sobreviventes da 1ª rodada viraram testes: o valor na linha de baixo do YAML (a regra passou a aceitá-lo, porque é vazamento real), o material de exatamente 32 caracteres, a chave desconhecida com valor string numa regra e a palavra-chave separada da regex;
- o histórico do git, varrido com a regex da regra (`git log -p`, uma linha por vez), não tem atribuição ao `AUTH_REFRESH_SEAL_KEYS` nem `.pem`;
- **só no CI:** o gitleaks com a configuração nova sobre o histórico inteiro (job `secrets`), o contrato e a sonda (job `db`).

**No GitHub (PR #17, 2026-11-07):** no 1º run (`42397764768`, `4efd96c`), o `db` falhou em 1 dos 72 casos, um erro do próprio teste (Fastify mínimo em vez do `buildApp`, 500 no lugar de 401), corrigido em `316da68`. No 2º (`42398183789`), os 4 jobs passaram: `secrets` sem achado com as duas regras novas, `db` com 72/72 e cobertura de 100%, `test` e `quality`. A sonda saiu **inativa** nos dois runs: o GoTrue da CLI 2.120.0 não aplica o limite por IP. O `groupOrder` do `vitest.db.config.ts` não segurou a ordem dos grupos (a sonda rodou primeiro), e a sonda passou a devolver o balde cheio ao terminar, em modo ativo.

**Integração no remoto:** antes do push, o branch tinha recebido o `47db338` (agente Copilot, com coautoria do humano), que libera no `.gitleaks.toml` o UUID `6f0c2a4e-…-9a1b2c3d4e5f`, fixture falsa de mais de 20 testes da API. Valor exato, ancorado e falso: o `[APPSEC]` aceitou no molde do D6. Os commits locais entraram por *rebase* (o 07h passou de `7962d4f` a `4efd96c`).

`[APPSEC]`: sem veto. O passo novo gera material de chave que existe só na VM descartável e nunca sai dela (sem `cat`, sem *upload*, sem artefato). A chave só assina tokens da pilha local, que morrem com o job. Risco residual aceito: um passo futuro que leia o arquivo e o imprima vazaria uma chave sem valor fora da VM; o teste da política já recusa qualquer outra menção ao arquivo no workflow.

## 4. Consequências
- `packages/ci-policy` entra no workspace e no `turbo run test`.
- `js-yaml` entra no `catalog:` com versão exata.
- O HITL-025 abre ao fim da parte 1: push, primeira execução verde, *required checks* no `master` e as permissões de Actions do repositório.
- O QA-01 fecha quando o job `test` ficar verde no GitHub.
