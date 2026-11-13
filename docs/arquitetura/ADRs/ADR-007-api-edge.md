---
tipo: adr
id: ADR-007
titulo: "Borda da API (E0): só JSON, 413 antes do parse, 415 para compressão, timeouts explícitos, trustProxy fechado e CORS por hook próprio"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]), dentro do ADR-001 §5.1 aprovado no HITL-001. Não muda contrato público."
data: 2026-10-19
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "F1-API-01 (apps/api/src/presentation e main.ts)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[threat-model](../threat-model.md)", "[contratos-zod](../contratos-zod.md)", "*BACKLOG*"]
---

# ADR-007: Borda da API (E0)

## 1. Contexto

O ADR-001 §5.1 fixa a ordem da borda: `onRequest` sem ler o corpo → parser → `preValidation`. O **SR-07** exige 413 **sem** parse para corpo acima de 64 KiB, e 415 para tipo não JSON ou `Content-Encoding` diferente de `identity`. Os padrões do Fastify 5.12.7 são inseguros em três pontos:

- `requestTimeout: 0` **sobrescreve** o padrão de 300 s do Node e deixa a recepção sem prazo;
- `connectionTimeout: 0`;
- o Node só confere `headersTimeout` e `requestTimeout` a cada `connectionsCheckingInterval`, que é de 30 s.

Além disso, o parser `text/plain` vem registrado por padrão.

JWT (F1-API-02) e rate limit (F1-API-03) estão **fora** deste ADR. Eles entram no mesmo `onRequest`, depois do CORS.

## 2. Decisões

### D1. Um só parser, JSON
- O parser `text/plain` é removido. Fica só o `application/json` padrão do Fastify (`secure-json-parse`), com `onProtoPoisoning` e `onConstructorPoisoning` em `'error'` **declarados de forma explícita** (T17).
- **Refinamento do ADR-001:** a checagem de tipo de mídia sobe para o `onRequest`, antes de ler o corpo, porque é mais barata. Ela vale para POST, PUT e PATCH e para qualquer requisição que carregue corpo (`Transfer-Encoding` ou `Content-Length` diferente de 0). Regras:
  - a essência precisa ser exatamente `application/json`; senão, 415;
  - o `charset` só pode faltar ou ser `utf-8` (RFC 8259); senão, 415.
- O 415 do próprio parser do Fastify continua como segunda camada.

### D2. `Content-Encoding`
- Ausente ou `identity` (ignorando caixa e espaços). Qualquer outro valor dá 415, inclusive a lista `gzip, identity` e o valor vazio.
- Nenhum plugin de descompressão é registrado (T18.6).

### D3. `bodyLimit = HTTP_BODY_MAX_BYTES` (65.536 bytes)
- Vem de `@trampo/contracts/limits` e vale para a instância inteira.
- O Fastify recusa pelo `Content-Length` antes de ler o corpo e também pela contagem durante o *streaming* (`chunked`).
- Nenhuma rota pode aumentar esse limite.

### D4. Timeouts (constantes da presentation; revisar no S-5 / ADR-003)
| Opção | Valor | Por quê |
|---|---|---|
| `headersTimeout` | 5 s | Anti-*slowloris* nos headers. |
| `requestTimeout` | 10 s | Recepção completa (headers + 64 KiB). Não limita a **resposta**, então o SSE não é afetado. |
| `connectionTimeout` | 30 s | Ociosidade do socket. Fica acima do `ANALYSIS_DEADLINE_MS` (12 s), para não derrubar um SSE sem evento. |
| `keepAliveTimeout` | 5 s | O padrão do Node. O padrão de 72 s do Fastify segura sockets à toa. Atrás de um balanceador, ele precisa ser **maior** que a ociosidade do LB: revisar no S-5. |
| `connectionsCheckingInterval` | 1 s | Sem isso, os dois prazos acima só valem com até 30 s de atraso. |

- Os valores ficam em código, sem variável de ambiente: um botão a menos para configurar errado.
- Os testes trocam os valores só pela opção `timeouts` do `buildApp`, e um teste trava os padrões.
- **`clientErrorHandler` próprio:** o 408 (timeout), o 431 (headers grandes demais) e o 400 (HTTP malformado) saem como `ApiError` com `requestId: null`, porque ainda não há requisição, e `Connection: close`. O padrão do Fastify devolvia um JSON fora do contrato.

### D5. `trustProxy`
- O padrão é `false`: o `X-Forwarded-For` é ignorado.
- Para configurar, use `TRUST_PROXY` com uma lista de IPs ou CIDRs dos saltos de proxy reais, validada com Zod no `main.ts`.
- São **recusados**:
  - `true` e `*`;
  - CIDR `/0`;
  - contagem de saltos. Ela confia em qualquer coisa que esteja na frente, e só entra no ADR-003, se a hospedagem tiver IPs de proxy dinâmicos.

### D6. CORS por hook próprio (sem `@fastify/cors`)
- **Por que não o plugin:** o hook próprio tem cerca de 60 linhas, sem dependência nova. O plugin traria superfície (curingas, `RegExp`, função de origem) e mais um item de cadeia de suprimentos (T26), sem ganho para uma lista fixa de origens.
- **Origens:** `CORS_ALLOWED_ORIGINS`, lista exata, validada no `main.ts`. Aceita só:
  - `chrome-extension://<32 letras a–p>`;
  - `https://host[:porta]` sem caminho;
  - `http://localhost` e `http://127.0.0.1` (portal em dev).
- São recusados: curinga, `null`, caminho, barra final e maiúsculas. Lista vazia é o padrão e nega todas as origens de navegador (falha fechado).
- **Requisição com `Origin` fora da lista:** 403 `PROIBIDO`, **sem** cabeçalhos de CORS. A rejeição acontece na borda, não só no navegador.
- **Sem `Origin`** (cliente que não é navegador ou sonda da hospedagem): segue em frente, sem cabeçalhos de CORS. A proteção é o JWT.
- **Origem permitida:** a resposta, **inclusive a de erro**, traz `Access-Control-Allow-Origin: <origem exata>` e `Vary: Origin`. Sem `Allow-Credentials`, porque a autenticação é por `Bearer` e não por cookie.
- **Preflight** (`OPTIONS` com `Access-Control-Request-Method`):
  - os métodos são só `GET`, `POST` e `PUT`, e os headers só `authorization` e `content-type`;
  - qualquer outro dá 403;
  - a resposta é 204 com `Max-Age` de 600 s.
- **Emenda do [ADR-021-criteria-routes](ADR-021-criteria-routes.md) D8.3 (2026-10-24, F1-API-05 commit 4): CORS por rota.** A lista de origens continua única, mas só a origem de web (a que começa com `https://`, ou com `http://` no loopback do portal em dev) alcança qualquer rota. A origem da extensão (`chrome-extension://<32 letras a–p>`) só alcança as rotas de `EXTENSION_ROUTES`. O mesmo vale para qualquer outra origem que chegue ao `buildApp` sem passar pelo `edge-env`. `EXTENSION_ROUTES` é uma lista positiva e congelada de método e caminho exatos, e hoje só tem `POST /v1/analyze`:
  - o *preflight* confere o `Access-Control-Request-Method`, e a requisição real confere o método;
  - o caminho é o **cru** antes do primeiro `?`, sem decodificar nem normalizar. No Fastify, o `request.url` é o `raw.url`;
  - `%61`, barra dupla, barra final, `..`, `.`, fragmento, maiúsculas e a forma absoluta dão **403 `PROIBIDO`**, sem cabeçalhos de CORS. O 403 sai antes do JWT, do rate limit e do corpo;
  - o roteador decodifica o `%61` e chegaria à rota. Por isso, quem recusa é a comparação crua;
  - **motivo:** os critérios, com a pretensão em claro, nunca vão para a extensão, e ela já tem o token do usuário. A recusa é do servidor, como o resto deste D6;
  - os cabeçalhos do *preflight* aceito não mudam (`GET, POST, PUT` e os dois headers). Quem decide é o servidor, por rota.
- **Emenda do [ADR-004-extension-auth](ADR-004-extension-auth.md) D8 item 2 (F1-API-07 07g, 2026-11-07, `b516fd0`): rotas do BFF de autenticação.**
  - `EXTENSION_ROUTES` ganhou `POST /v1/auth/exchange`, `POST /v1/auth/refresh` e `POST /v1/auth/logout`;
  - `EXTENSION_ONLY_ROUTES` (as 3): a origem de web leva 403, no *preflight* e na requisição real. O portal terá login próprio no servidor (F1-PORTAL-01);
  - `ORIGIN_REQUIRED_ROUTES` (troca e renovação): **sem `Origin`, 403**. É exceção ao "sem `Origin` segue", porque essas duas rotas não têm JWT. É higiene, não controle;
  - as duas listas novas comparam o caminho cru **e** o padrão que o roteador casou. O `%61uth` chega à rota pelo roteador, e só a comparação crua o deixaria passar sem `Origin` ou vindo de web. A `EXTENSION_ROUTES` continua só pelo caminho cru;
  - o logout sem `Origin` segue: o Bearer o protege.

### D7. Mapeamento para `ApiError` (catálogo do contrato v1, sem código novo)
| Situação | Status | Código |
|---|---|---|
| Corpo > 64 KiB | 413 | `PAYLOAD_GRANDE_DEMAIS` |
| Tipo de mídia ou encoding recusado | 415 | `PAYLOAD_INVALIDO` |
| Timeout de recepção | 408 | `PAYLOAD_INVALIDO` |
| Headers grandes demais | 431 | `PAYLOAD_GRANDE_DEMAIS` |
| Origem ou preflight negados | 403 | `PROIBIDO` |
| JSON malformado e *proto poisoning* | 400 | `PAYLOAD_INVALIDO` |

O contrato não tem códigos específicos para 415 e 408. O `status` HTTP diferencia os casos, e a mensagem continua a do catálogo.

## 3. Consequências
- O `.env.example` ganha `CORS_ALLOWED_ORIGINS` e `TRUST_PROXY`, só com nomes e sem valores reais.
- O ID fixo da extensão de dev (chave `key`, S-3) e a origem do portal entram no `.env` quando existirem. Até lá, a lista vazia nega tudo.
- **Revisar no S-5 / ADR-003:** `keepAliveTimeout` diante do balanceador e o `TRUST_PROXY` real da hospedagem.
