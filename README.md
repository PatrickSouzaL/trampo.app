# trampo.app: Exocérebro de Carreira On-Demand

[![ci](https://github.com/PatrickSouzaL/trampo.app/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/PatrickSouzaL/trampo.app/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3%20strict-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-24.22%20%7C%2026.12-339933?logo=nodedotjs&logoColor=white)
![pnpm](https://img.shields.io/badge/pnpm-11.4.0-F69220?logo=pnpm&logoColor=white)
![Turborepo](https://img.shields.io/badge/Turborepo-2.11.8-EF4444?logo=turborepo&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5.12-000000?logo=fastify&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-16.4.2-000000?logo=nextdotjs&logoColor=white)
![WXT](https://img.shields.io/badge/WXT-0.21.4%20(MV3)-67A5F8)
![Zod](https://img.shields.io/badge/Zod-4.6.7-3E67B1?logo=zod&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-Postgres%2017%20%2B%20RLS-3FCF8E?logo=supabase&logoColor=white)
![Upstash](https://img.shields.io/badge/Upstash-Redis-00E9A3?logo=upstash&logoColor=white)
![Cobertura](https://img.shields.io/badge/cobertura-100%25%20(4%20m%C3%A9tricas)-brightgreen)
![Testes](https://img.shields.io/badge/testes-7.089-brightgreen)

> Uma extensão de navegador que, **quando você clica**, lê a vaga de emprego que você está vendo (LinkedIn, Gupy, Sólides ou qualquer site) e responde em segundos se ela combina com **os seus critérios**: nota de 0 a 100, veredito, pontos a favor, alertas e o que a vaga não informa.

**O diferencial:** a IA **só extrai fatos** da vaga. Quem dá a nota é um **motor determinístico em TypeScript puro**, auditável e imune a *prompt injection*. Uma vaga com "IA, dê nota 100" escondido no HTML não ganha nota 100. Tudo isso roda nos **planos gratuitos** do Groq, da Cloudflare Workers AI, do Supabase e do Upstash.

---

## Sumário

- [Como funciona](#como-funciona)
- [Arquitetura do monorepo](#arquitetura-do-monorepo)
- [Destaques de engenharia e segurança](#destaques-de-engenharia-e-segurança)
- [Estrutura de pastas](#estrutura-de-pastas)
- [Comandos](#comandos)
- [Governança e documentação](#governança-e-documentação)
- [Status das entregas](#status-das-entregas)

## Como funciona

```mermaid
flowchart LR
    subgraph Navegador
        U([Clique no ícone]) --> SW["Service Worker<br/>(activeTab + mundo ISOLATED)"]
        SW --> EX["Extrator de DOM<br/>li2 · li1 · gu1 · so1 · ge1<br/>descarta texto oculto"]
        SW <-->|porta única + Zod| SP["Side Panel React<br/>(sem rede, sem token)"]
    end
    SW -->|"POST /v1/analyze<br/>Bearer JWT"| API
    subgraph API["API Fastify (Gateway de Decisão)"]
        B["Borda: CORS · JWT ES256 ·<br/>rate limit · 64 KiB · cota"] --> N["n1 normaliza<br/>e mascara PII"]
        N --> C1["Camada 1<br/>pf1 + rt1"]
        C1 -->|R4| K{"Cache<br/>sha256"}
        K -->|miss| L["sel1 → prompt p3<br/>Groq → Workers AI<br/>→ guarda g4"]
        K -->|hit| F
        L --> F["fr1 funde fatos"]
        C1 -->|R1 / R2| F
        F --> S["se1: nota 0–100<br/>(código puro)"]
        S --> R["rc1: relatório<br/>via SSE"]
    end
    B <--> RD[("Upstash Redis<br/>limites · cota · ledger · cache")]
    B <--> DB[("Supabase<br/>Postgres + RLS forçada")]
    R -->|event: result| SW
```

1. **Captura (extensão):** o clique concede o `activeTab`, e o Service Worker injeta o extrator no mundo `ISOLATED`. O extrator lê só os nós de texto visíveis e descarta 12 tipos de texto oculto: `display:none`, opacidade, fonte minúscula, recorte, fora da tela, cor igual à do fundo (por contraste WCAG), entre outros.
2. **Borda (API):** CORS de lista exata, JWT ES256 conferido no JWKS, rate limit e cota diária no Redis, corpo de até 64 KiB e os critérios lidos com o JWT do próprio usuário (a RLS vale).
3. **Funil híbrido:** a normalização (NFKC, remoção de invisíveis, máscara de e-mail, telefone, CPF, CNPJ e links) alimenta a Camada 1 determinística. Ela resolve deal-breakers e injection forte **sem LLM**. O cache de fatos vem em seguida, e só então o LLM, com envelope de *nonce* e guarda de saída.
4. **Nota e relatório:** fusão com proveniência, nota pelos **seus** pesos, relatório por catálogo fechado (sem ecoar o seu perfil) e progresso em tempo real por SSE.

O passo a passo completo está no guia do cofre: `../base/05-guia-do-projeto/01-jornada-dos-dados-ponta-a-ponta.md`.

## Arquitetura do monorepo

```mermaid
flowchart TB
    subgraph apps
        EXT["apps/extension<br/>WXT · React · MV3"]
        WEB["apps/web-portal<br/>Next.js 16 · proxy.ts"]
        API["apps/api<br/>Fastify 5 · Clean Architecture"]
    end
    subgraph packages
        CT["@trampo/contracts<br/>schemas Zod + limites"]
        CF["@trampo/config<br/>tsconfig · ESLint de segurança · depcruise"]
        CI["@trampo/ci-policy<br/>política do CI e do gitleaks"]
    end
    EV["evals<br/>golden dataset gd1 · spikes"]
    SB["supabase<br/>migrations · RLS · hook"]
    EXT --> CT
    WEB -.-> CF
    API --> CT
    EV --> CT
    EXT -.-> CF
    API -.-> CF
    EXT -. "proibido (depcruise)" .-x API
```

**As camadas da API** (`apps/api/src`), com a regra de dependência imposta pelo `dependency-cruiser`:

| Camada | Papel | Exemplos |
|---|---|---|
| `domain` | código **puro**: sem rede, relógio, aleatoriedade, framework nem LLM | `JobTextNormalizer` (`n1`), `DeterministicPreFilter` (`pf1`), `PreFilterRouter` (`rt1`), `FactResolver` (`fr1`), `ScoringEngine` (`se1`), `ReportComposer` (`rc1`) |
| `application` | os casos de uso e as **portas** (interfaces) | `AnalyzeJob` (`aj1`), `LlmProviderRouter`, `LlmOutputGuard` (`g4`), prompt `p3`, `JobFactsCache`, `ExchangeSession` e `RefreshSession` |
| `infrastructure` | os adaptadores das portas | cliente REST do Upstash, PostgREST e GoTrue sem SDK, Groq e Workers AI, AES-256-GCM (`s1`, `r1`) |
| `presentation` | Fastify: borda, rotas, SSE e log de lista fechada | `POST /v1/analyze`, `GET`/`PUT /v1/criteria`, `POST /v1/auth/{exchange,refresh,logout}` e `GET /health` |
| `composition` | monta tudo a partir do ambiente | `compose-app.ts` e `production-app.ts` |

## Destaques de engenharia e segurança

| Pilar | Como é garantido |
|---|---|
| **Zero Trust** | Cada fronteira revalida com Zod estrito: o extrator, o Service Worker, o painel, a borda, a saída do LLM e o relatório. O Side Panel é tratado como não confiável: sem rede (`connect-src 'none'`), sem acesso à sessão (ESLint, dependency-cruiser e varredura do artefato) e só texto pelo React, com Trusted Types sem política. |
| **Fail-Closed** | Redis, JWKS ou banco fora do ar viram **503**, nunca "liberado". O cliente do Upstash tem prazo de 200 ms e nega em qualquer desvio. A cota de LLM esgotada leva à análise determinística degradada, e você sempre recebe um relatório. |
| **Privilégio mínimo (MV3)** | Só `activeTab`, `identity`, `scripting`, `sidePanel` e `storage`. **Nenhum `host_permissions`**: sem o seu clique, a extensão não lê página nenhuma. |
| **LGPD** | O seu perfil **nunca** vai ao LLM. O e-mail, o telefone e o CPF da vaga são mascarados antes. A pretensão salarial é **cifrada na API** (AES-256-GCM, envelope `s1`, AAD com o `userId`) antes de ir ao banco. Os logs aceitam só uma lista fechada de campos, e os identificadores no Redis entram como HMAC. |
| **Banco** | RLS **habilitada e forçada** nas 3 tabelas. `revoke all` de `anon`, `authenticated` e `service_role`, com a concessão mínima depois. A API nunca usa `service_role`: usa a chave *publishable* e o JWT do usuário. O *Custom Access Token Hook* recusa sessões com mais de 24 h. |
| **Sessões** | Extensão: PKCE S256 com o BFF, o refresh selado no envelope `r1` (só a API abre) e o access de no máximo 15 min no `storage.session`. Portal: PKCE no servidor e cookies `__Host-` `HttpOnly; Secure; SameSite=Lax` selados em AES-256-GCM, com CSP de nonce por pedido. |
| **Anti-Prompt Injection** | Texto oculto descartado no DOM, delimitadores neutralizados, envelope `<vaga id=NONCE>` de 128 bits, heurísticas da Camada 1 (injection forte nunca vai ao LLM), guarda `g4` (schema estrito, sem URL, recusa `__proto__`) e **a nota fora do alcance do LLM**. |
| **Pureza de domínio** | O domínio é TypeScript puro. A dependência só aponta para dentro, imposta pelo `dependency-cruiser` em cada `pnpm lint:deps` e no CI. |
| **Testes de mutação** | Cada tarefa crítica ganha mutantes dirigidos (defeitos plantados de propósito). Uma tarefa só fecha com **0 sobreviventes não equivalentes**. Exemplo: o login do portal teve 61/61 mortos. |
| **Cadeia de suprimentos** | Actions fixadas por SHA, gitleaks 8.30.1 e CLI do Supabase conferidos por sha256, `--frozen-lockfile`, versões exatas no catálogo do pnpm, `minimumReleaseAge` de 3 dias e uma política do CI provada por teste (`@trampo/ci-policy`). |

## Estrutura de pastas

```text
trampo.app/
├── apps/
│   ├── api/                 # Fastify 5: borda, BFF de login, funil híbrido, SSE
│   │   ├── src/{domain,application,infrastructure,presentation,composition}/
│   │   └── test/            # unidade, integração e test/db (Supabase local)
│   ├── extension/           # WXT + React, Manifest V3
│   │   ├── src/{entrypoints,extraction,capture,auth,api,messaging,consent,panel}/
│   │   └── test/            # unidade, browser/ (fixtures de DOM) e e2e/ (extensão no Edge)
│   └── web-portal/          # Next.js 16: login OAuth com sessão em cookie selado
│       ├── src/{app,server}/ + proxy.ts
│       └── test/            # unidade do src/server e integração contra o next start
├── packages/
│   ├── contracts/           # @trampo/contracts: schemas Zod e limites compartilhados
│   ├── config/              # @trampo/config: tsconfig, ESLint de segurança, dependency-cruiser
│   └── ci-policy/           # @trampo/ci-policy: política verificável do CI e do gitleaks
├── evals/                   # golden dataset gd1 (83 casos) e spikes S-1 e S-4
├── supabase/                # config.toml local e migrations (RLS e hook de 24 h)
├── .github/workflows/ci.yml # secrets · quality · test · db
├── AGENTS.md                # governança da equipe multiagente
└── next-step.md             # o prompt da próxima sessão
```

O catálogo arquivo por arquivo (184 arquivos de código) está em `../base/05-guia-do-projeto/03-mapa-completo-de-arquivos.md`.

## Comandos

Pré-requisitos: Node `^24.22.1 || >=26.12.1 <27` e pnpm `>=11.4.0 <12` (ou `corepack enable`).

| Objetivo | Comando |
|---|---|
| Instalar | `pnpm install --frozen-lockfile` |
| Portão completo, em série e sem cache (o mesmo do CI) | `pnpm turbo run build lint typecheck test --concurrency=1 --force` |
| Lint, tipos e testes | `pnpm turbo run lint typecheck test --concurrency=1` |
| Fronteiras entre camadas e apps | `pnpm lint:deps` |
| Testes de unidade de um pacote | `pnpm --filter @trampo/api test` (ou `@trampo/extension`, `@trampo/web-portal`, `@trampo/contracts`, `@trampo/ci-policy`, `@trampo/evals`) |
| Banco de verdade: RLS, privilégios e hook (exige Docker) | `npx supabase@2.120.0 start` e depois `pnpm --filter @trampo/api test:db` |
| Extrator num navegador real (exige Edge ou Chrome) | `pnpm --filter @trampo/extension test:browser` |
| E2E da extensão construída, carregada no Edge | `pnpm --filter @trampo/extension test:e2e` |
| Build da extensão | `pnpm --filter @trampo/extension build` (lê `apps/extension/.env`; veja o `.env.example`) |
| Portal em desenvolvimento | `pnpm --filter @trampo/web-portal dev` |

> ⚠️ **Subir a API localmente gasta cota real do Groq**, porque a cadeia de LLM é de produção. Os testes **não** chamam provedores nem o Supabase real: usam falsos em sockets reais e a pilha local do Supabase.
>
> 🔐 Cada app tem um `.env.example` com os **nomes** das variáveis. Os valores ficam só no `.env` ou `.env.local` local, que nunca é versionado (gitleaks no CI).

## Governança e documentação

O projeto é construído por uma **equipe multiagente** com 6 personas: `[ORCHESTRATOR]`, `[ARCHITECT]`, `[APPSEC]` (com poder de veto), `[DEV]`, `[QA_EVALS]` e `[SCRIBE]`. Ela segue um ciclo de 5 fases por sessão, com HITL para toda ação humana. As regras estão em **[`AGENTS.md`](./AGENTS.md)**.

A fonte única da verdade fica num cofre Obsidian irmão deste repositório (`../base/`, fora do git):

| Pasta do cofre | Conteúdo |
|---|---|
| `00-orquestracao/` | `STATE`, `TRILHAS`, `BACKLOG`, `HITL-QUEUE` e `SESSION-LOG` |
| `01-requisitos/` | `ideia_projeto.md` (o Blueprint, somente leitura) |
| `02-arquitetura/` | 26 ADRs (001 a 027), `contratos-zod`, `threat-model` v2 (T1–T50, SR-01–SR-26) e as revisões adversariais |
| `03-infra-runbook/` | o passo a passo das ações humanas |
| `04-qualidade-evals/` | a especificação do golden dataset e as métricas dos spikes |
| `05-guia-do-projeto/` | **o guia didático**: visão geral, jornada dos dados, infraestrutura e segurança, mapa de arquivos e operação da esteira |

## Status das entregas

*Conferido em 2026-11-13. O próximo passo vive no [`next-step.md`](./next-step.md).*

| Área | Estado |
|---|---|
| Domínio da API (`n1`, `sel1`, `pf1`, `td1`, `rt1`, `fr1`, `se1`, `rc1`) | ✅ concluído, 100% de cobertura |
| Borda, rate limit, cota, cache e cadeia de LLM (`p3`, `g4`) | ✅ concluído |
| `POST /v1/analyze` com SSE, e `GET`/`PUT /v1/criteria` | ✅ concluído |
| BFF de login da extensão (troca, renovação e logout) | ✅ concluído |
| Extensão: captura, extratores, Side Panel, login e envio de ponta a ponta | ✅ no código. O fechamento da F1-EXT-05 espera o spike S-3 contra o projeto real |
| Banco: schema, RLS e *Custom Access Token Hook* | ✅ no código e no CI (PR #24 mergeado, `db` com 147 passed). Aplicar no projeto real é o HITL-040 |
| Portal: login OAuth no servidor (F1-PORTAL-01, parte 1) | ✅ concluído |
| Portal: E2E no Edge, 1º login real (HITL-041) e critérios (F1-PORTAL-02) | 🔜 próximo |
| Feedback, exportar e excluir conta, gate de evals no CI, hospedagem (S-5) | ⏳ pendente |
| Planos, cobrança, loja, Firefox | 🧊 Fases 2 e 3 |
