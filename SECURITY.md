# Política de segurança

O Trampo.app trata segurança como requisito de projeto, não como etapa final. Este documento diz como reportar uma vulnerabilidade e resume as defesas da arquitetura. O detalhe está no [*threat model*](./docs/arquitetura/threat-model.md) (fronteiras TB1–TB13, ameaças T1–T50 e requisitos SR-01–SR-26) e nos [ADRs](./docs/arquitetura/ADRs/).

## Versões suportadas

O projeto está em desenvolvimento ativo (Fase 1, antes da 1.0). Só o branch `master` recebe correções de segurança.

| Versão | Suportada |
|---|---|
| `master` | ✅ |
| qualquer outro branch ou commit antigo | ❌ |

## Como reportar uma vulnerabilidade

**Não abra uma *issue* pública.** Use o reporte privado do GitHub:

1. Vá na aba **Security** do repositório e clique em **Report a vulnerability** (GitHub *Private Vulnerability Reporting*).
2. Descreva o componente (`apps/api`, `apps/extension`, `apps/web-portal`, `supabase/`, CI), o impacto, os passos para reproduzir e, se tiver, uma prova de conceito mínima.
3. Não inclua dados pessoais de terceiros nem segredos reais no relatório.

**Prazos de referência:** confirmação de recebimento em até 5 dias úteis, triagem com severidade (CVSS 4.0) em até 10 dias úteis e correção priorizada pela severidade. Quem reportar recebe o crédito no *advisory*, se quiser.

### Escopo

- **Dentro:** o código deste repositório. Isso inclui a API, a extensão MV3, o portal, as migrations e políticas RLS, o *Custom Access Token Hook*, o workflow de CI e as políticas do `@trampo/ci-policy`.
- **Fora:**
  - a infraestrutura dos provedores (Supabase, Upstash, Groq, Cloudflare, GitHub);
  - ataques de negação de serviço volumétrica;
  - engenharia social;
  - achados que exigem um navegador ou sistema operacional já comprometido.

### Porto seguro

A pesquisa de boa-fé, dentro do escopo e sem acesso a dados de outras pessoas, não será tratada como violação. Teste contra a sua própria instância local: o repositório sobe a pilha inteira com falsos (`test:db` com o Supabase local, GoTrue e provedores de LLM simulados em socket real). Não teste contra a infraestrutura de produção.

## Arquitetura Zero Trust, em resumo

| Camada | Defesa principal | Referência |
|---|---|---|
| **Extensão (MV3)** | <ul><li>Só `activeTab` + `scripting` sob clique, sem `host_permissions`.</li><li>O extrator descarta 12 classes de texto oculto (anti-*prompt injection* no DOM).</li><li>Tokens só no `storage.session` do Service Worker.</li><li>O Side Panel não tem rede (`connect-src 'none'`), usa Trusted Types sem política e fala por uma porta única validada por Zod nas duas pontas.</li></ul> | [ADR-004](./docs/arquitetura/ADRs/ADR-004-extension-auth.md), [ADR-023](./docs/arquitetura/ADRs/ADR-023-generic-dom-extractor.md), [ADR-025](./docs/arquitetura/ADRs/ADR-025-side-panel-ui.md) |
| **Borda da API** | <ul><li>CORS por lista exata.</li><li>JWT ES256 conferido no JWKS.</li><li>Rate limit e cota diária em Redis, com chave HMAC.</li><li>Corpo limitado a 64 KiB antes do parse e contratos `z.strictObject`.</li><li>Falha fechada: dependência fora do ar dá 503, nunca "liberado".</li></ul> | [ADR-007](./docs/arquitetura/ADRs/ADR-007-api-edge.md), [ADR-013](./docs/arquitetura/ADRs/ADR-013-jwt-verification.md), [ADR-014](./docs/arquitetura/ADRs/ADR-014-rate-limit-and-quota.md) |
| **LLM** | <ul><li>Só extrai fatos: a nota é de um motor determinístico em TypeScript puro.</li><li>O perfil do usuário nunca vai ao modelo.</li><li>A vaga vai num envelope com *nonce* de 128 bits.</li><li>A guarda de saída `g4` aplica schema estrito, sem URL e sem `__proto__`.</li><li>Injection forte nunca chega ao LLM.</li></ul> | [ADR-001](./docs/arquitetura/ADRs/ADR-001-hybrid-engine-and-monorepo.md), [ADR-008](./docs/arquitetura/ADRs/ADR-008-llm-output-guard.md), [ADR-016](./docs/arquitetura/ADRs/ADR-016-deterministic-pre-filter.md) |
| **Dados (LGPD)** | <ul><li>Máscara de e-mail, telefone, CPF, CNPJ e links antes de qualquer provedor.</li><li>Pretensão salarial cifrada na API (AES-256-GCM, AAD com o `userId`).</li><li>Logs de lista fechada.</li><li>RLS habilitada e forçada, sem `service_role` nas rotas de usuário.</li></ul> | [ADR-010](./docs/arquitetura/ADRs/ADR-010-log-allowlist-and-telemetry.md), [ADR-018](./docs/arquitetura/ADRs/ADR-018-postgres-schema-rls-and-criteria.md), [ADR-026](./docs/arquitetura/ADRs/ADR-026-custom-access-token-hook.md) |
| **Portal** | <ul><li>PKCE no servidor.</li><li>Cookies `__Host-` `HttpOnly; Secure; SameSite=Lax` selados.</li><li>CSP com *nonce* por pedido e `frame-ancestors 'none'`.</li><li>Logout só por `POST` com `Origin` exato.</li><li>Nenhum destino de redirecionamento vem do pedido.</li></ul> | [ADR-027](./docs/arquitetura/ADRs/ADR-027-portal-login.md) |
| **Cadeia de suprimentos** | <ul><li>Actions fixadas por SHA e `permissions: contents: read`.</li><li>CI sem segredos e sem `pull_request_target`.</li><li>Binários (gitleaks 8.30.1, CLI do Supabase) conferidos por sha256.</li><li>Versões exatas e `minimumReleaseAge`.</li><li>A política do workflow é provada por teste.</li></ul> | [ADR-019](./docs/arquitetura/ADRs/ADR-019-ci-github-actions.md) |

## Dados de teste

Nenhum dado real de terceiros é versionado:

- **Golden dataset** (`evals/golden/cases/`): os textos de vaga são **sintéticos**. São reescritas isomórficas que preservam os fatos que o gabarito mede (tecnologias, salário, modelo, contrato, senioridade e armadilhas), com nomes de empresa fictícios.
- **Fixtures de DOM** (`apps/extension/test/browser/fixtures/`): o texto foi trocado por pseudopalavras do mesmo tamanho. A estrutura HTML e o CSS das plataformas ficam como estão, porque são eles que os extratores medem.
- **Segredos:** os segredos que aparecem nos testes são canários falsos, liberados no `.gitleaks.toml` só por valor exato.
