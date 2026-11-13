# Documentação do Trampo.app

Esta pasta é o espelho público e sanitizado da documentação viva do projeto. O original fica num cofre Obsidian privado, mantido pela persona `[SCRIBE]` (veja o [`AGENTS.md`](../AGENTS.md)).

| Pasta | O que tem | Por onde começar |
|---|---|---|
| [`guia/`](./guia/) | O guia didático em 5 partes: visão geral, a jornada de uma vaga ponta a ponta, infraestrutura e segurança, o mapa de todos os arquivos e a operação da esteira multiagente | [`00-indice-e-visao-geral.md`](./guia/00-indice-e-visao-geral.md) |
| [`arquitetura/`](./arquitetura/) | <ul><li>O [*threat model*](./arquitetura/threat-model.md), com fronteiras, ameaças, requisitos de segurança e riscos residuais.</li><li>O catálogo dos [contratos Zod](./arquitetura/contratos-zod.md).</li><li>As revisões adversariais ([M1](./arquitetura/revisao-adversarial-M1.md) e [auth](./arquitetura/revisao-adversarial-auth.md)).</li></ul> | [`threat-model.md`](./arquitetura/threat-model.md) |
| [`arquitetura/ADRs/`](./arquitetura/ADRs/) | As 26 decisões de arquitetura (ADR-001 a ADR-027; não existe ADR-003), cada uma com contexto, decisão, auditoria do `[APPSEC]` e emendas datadas | [`ADR-001`](./arquitetura/ADRs/ADR-001-hybrid-engine-and-monorepo.md) |

## Convenções

- **Referências em itálico sem link** (por exemplo, *HITL-QUEUE* ou *BACKLOG*) apontam para notas operacionais do cofre privado: a fila de ações humanas, o backlog, os runbooks de contas e o registro de sessões. Elas não são publicadas.
- **Na dúvida entre o documento e o código, vale o código.** Os números do guia citam o arquivo de origem.
- Os documentos guardam o histórico de decisão com datas e emendas. Um ADR "proposto" ou uma emenda antiga é registro, não estado atual. O estado atual está no [`README`](../README.md) da raiz.
