---
tipo: adr
id: ADR-013
titulo: "Verificação do JWT (E0): porta AccessTokenVerifier, adapter jose com JWKS remoto (ES256 fixo) e hook de autenticação que falha fechado"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]), dentro do ADR-001 §5.1 aprovado no HITL-001. Não muda contrato público."
data: 2026-10-21
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "F1-API-02 (apps/api: application/ports, infrastructure/auth, presentation/edge e main.ts)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-007-api-edge](ADR-007-api-edge.md)", "[ADR-010-log-allowlist-and-telemetry](ADR-010-log-allowlist-and-telemetry.md)", "[threat-model](../threat-model.md)", "*supabase-setup*", "*BACKLOG §F1-API-02*"]
---

# ADR-013: Verificação do JWT (E0)

## 1. Contexto

- O ADR-001 §5.1 fixa a verificação **local** do `Authorization: Bearer` com `jose` e o JWKS do Supabase Auth: `ES256` só, `iss`, `aud = authenticated`, `role = authenticated`, `sub` UUID, tolerância de relógio de até 30 s, `is_anonymous` recusado e **falha fechado** com JWKS vazio ou inacessível.
- O **SR-05** pede testes de borda para `alg none`, HS256, `iss`/`aud`/`role` errados, expirado, anônimo e JWKS vazio. O T9 fixa o access token em 900 s; o T30 pede `SERVICO_INDISPONIVEL` (e não 401) quando o Supabase cai ou pausa.
- O HITL-004 está fechado: projeto em `us-east-1`, chave ES256 como *current*, JWT de 900 s e login anônimo desligado.
- O ADR-007 deixou o lugar reservado: o JWT entra no `onRequest`, depois do CORS.

## 2. Decisões

### D1. Porta na aplicação, adapter na infraestrutura, hook na apresentação
```ts
// application/ports/access-token-verifier.ts (só tipos)
type AccessTokenVerification =
  | { ok: true; principal: { userId: string; sessionId: string | null } }
  | { ok: false; reason: "token_invalido" | "chaves_indisponiveis" };
interface AccessTokenVerifier { verify(token: string): Promise<AccessTokenVerification> } // nunca rejeita
```
- O resultado só carrega `userId` (= `sub`) e `sessionId` (= `session_id`, para a idade máxima de sessão do T9 no futuro). Nenhuma outra claim sai do adapter: e-mail, `user_metadata` e `app_metadata` nunca entram na aplicação.
- O motivo é um enum de dois valores. A apresentação não distingue *por que* o token é inválido (sem oráculo).
- `infrastructure/auth/jose-access-token-verifier.ts` é o único lugar que importa `jose`. A regra `application-only-zod-and-contracts` do depcruise continua valendo.
- `presentation/edge/auth.ts` lê o header, chama a porta e grava `request.principal`.
- **O verificador é obrigatório no `buildApp`**: não há padrão "aceita tudo". Os testes injetam um *fake* explícito.
- **Emenda do [ADR-004-extension-auth](ADR-004-extension-auth.md) D6 (F1-API-07, commit 07d, 2026-11-07, `7e6c5d5`):** a porta ganhou `keysReady(): Promise<boolean>`, que nunca rejeita. O BFF pergunta, sem token, se há chave ES256 pronta antes de chamar o GoTrue, para não consumir o refresh com o JWKS fora do ar. O adapter responde pelo próprio `RemoteJWKSet` (`fresh`, `reload()` e `jwks()`), com o mesmo cache e o mesmo cooldown do `verify` (D5). O enum de motivos continua com dois valores.
- **Emenda do [ADR-004-extension-auth](ADR-004-extension-auth.md) D6 (F1-API-07, commit 07f, 2026-11-07, `e1af5d0`):** o resultado `ok` do `verify` ganhou `lifetime: { issuedAt, expiresAt }`, com o `iat` e o `exp` do token, que o `jose` já exige (`maxTokenAge` e `requiredClaims`). Fica fora do `Principal` porque não diz quem é o usuário: serve ao BFF para conferir `exp − iat` e descontar a idade do token no `expiresIn` (ADR-004 D4). As rotas protegidas não leem o campo, e nenhuma outra claim sai do adapter.

### D2. Ordem no `onRequest` e rotas públicas
- Ordem: CORS → tipo de mídia → **JWT** → (rate limit, F1-API-03). Tudo antes de ler o corpo: um corpo de 64 KiB sem token dá 401 sem parse.
- **Lista fechada de rotas públicas:** só `GET /health`. Qualquer outra rota, inclusive inexistente, exige token: uma sonda sem token recebe 401, não 404 (anti-enumeração). Rota nova nasce protegida.
- O *preflight* continua respondido pelo CORS antes do JWT (o navegador não manda `Authorization` no preflight).
- **Emenda do [ADR-004-extension-auth](ADR-004-extension-auth.md) D8 item 1 (F1-API-07 07g, 2026-11-07, `b516fd0`):** a lista pública passou a ser `GET /health`, `POST /v1/auth/exchange` e `POST /v1/auth/refresh`, comparada pelo padrão registrado.
  - As duas do BFF nunca leem `Authorization`: o hook sai antes do header, e o rate limit no Redis também não conta. A proteção delas é o `Origin` obrigatório, o limitador local em memória, o PKCE e o AEAD.
  - O `POST /v1/auth/logout` continua protegido.
  - Ordem efetiva nas públicas: CORS → tipo de mídia → JWT e rate limit sem efeito → limitador local (hook da rota) → `bodyLimit` → Zod.

### D3. Formato do header (antes de tocar no `jose`)
- `Authorization: Bearer <token>`; o esquema ignora caixa (RFC 7235), com **um** espaço e um token só.
- O token precisa ter a forma compacta `base64url.base64url.base64url` e no máximo **8.192** caracteres. Fora disso, 401 sem chamar o verificador. A regex é linear (sem alternância aninhada).
  - **Emenda do [ADR-004-extension-auth](ADR-004-extension-auth.md) §6.1 (F1-API-07, commit 07a, 2026-11-07):** o teto tem fonte única, o `ACCESS_TOKEN_MAX_CHARS` de `@trampo/contracts/limits` (F1-AUTH-00). A borda (`presentation/edge/auth.ts`), o `CriteriaGuard` e o cliente do PostgREST importam esse valor, e a constante local da borda saiu. O `test/access-token-ceiling.test.ts` varre o `src/` da API e prova que nenhum literal 8192 (em decimal, hexadecimal, `8 * 1024` ou `2 ** 13`) sobra fora dos dois limites alheios, o `LLM_OUTPUT_MAX_BYTES` e o `TELEMETRY_GUARD_NORMALIZATION_MAX`. O regex do Bearer segue sem a flag `u` (com `i` e `u`, a classe de palavra aceitaria U+017F e U+212A).

### D4. Parâmetros do `jwtVerify`
| Parâmetro | Valor | Por quê |
|---|---|---|
| `algorithms` | `["ES256"]` | Recusa `none`, HS256 (inclusive com a chave pública como segredo: *key confusion*) e qualquer outro algoritmo **antes** de buscar chave. |
| `typ` | `JWT` | O Supabase emite `typ: JWT`; outro tipo de token assinado pela mesma chave não serve como access token. Revisar no E2E do S-3. |
| `issuer` | `${SUPABASE_URL}/auth/v1` | Token de outro projeto é recusado. |
| `requiredClaims` | `exp` | Token sem `exp` é recusado. As outras ausências já falham por outra camada: `iss` pelo `issuer`, `iat` pelo `maxTokenAge`, e `aud`, `sub` e `role` pelo schema abaixo. A mutação provou que listar essas claims, ou passar `audience` ao `jose`, era código equivalente, e por isso esse código saiu. |
| `clockTolerance` | **10 s** | A verificação é servidor contra servidor (NTP dos dois lados). Fica dentro do teto de 30 s do ADR-001. |
| `maxTokenAge` | **900 s** | O mesmo prazo do HITL-004. Se alguém aumentar a validade no painel do Supabase, a API continua recusando token mais velho que 15 min (defesa em profundidade do T9). |
| `kid` | obrigatório | Token sem `kid` é recusado antes de consultar o JWKS. |
| `crit` | padrão do `jose` | Extensão crítica desconhecida é recusada. |

- Depois da assinatura, um schema Zod confere as claims: `sub` UUID, `role === "authenticated"`, `aud === "authenticated"` **como string** (o `jose` aceitaria um array que a contivesse), **`is_anonymous === false`** (ausente também é recusado: falha fechado) e `session_id` UUID opcional.
  - **Emenda do [ADR-004-extension-auth](ADR-004-extension-auth.md) D6 (F1-API-07, commit 07d, 2026-11-07, `7e6c5d5`):** o schema também exige o `amr` no formato do GoTrue (lista não vazia de `{ method, ... }`), com **todo** método na lista de `AUTH_ALLOWED_AMR`. O padrão é `oauth`; `password` só passa com `NODE_ENV=test`, e o boot recusa fora disso. Fora da lista, o resultado é `token_invalido` (401). A forma de strings do RFC 8176 fica recusada até o P9. A lista é parâmetro obrigatório do adapter, lida no `composeApp`.

### D5. JWKS remoto: cache, rotação e timeout
- `createRemoteJWKSet(SUPABASE_JWKS_URL)` com:
  - `timeoutDuration` **3 s** (o padrão é 5 s; o prazo de recepção da borda é 10 s);
  - `cacheMaxAge` **10 min** (o mesmo cache de borda do Supabase, *supabase-setup* §2);
  - `cooldownDuration` **30 s**: um `kid` desconhecido força no máximo **uma** nova busca a cada 30 s. Inundar a API com `kid` aleatório não vira inundação no Supabase;
  - **teto de 64 KiB na resposta**, por um `customFetch` que conta os bytes durante a leitura, sem confiar no `Content-Length`. O `signal` de timeout do `jose` também interrompe a leitura.
- **Rotação:** a chave em *standby* já aparece no JWKS antes de assinar; se o `kid` novo ainda não estiver no cache, o `jose` recarrega uma vez e aceita.
- **Falha fechado, com dois resultados:**
  - JWKS inacessível, com timeout, com status ≠ 200 (inclusive redirecionamento), com JSON inválido, acima do teto, **vazio** ou **sem nenhuma chave EC P-256** (projeto ainda no segredo HS256) → `chaves_indisponiveis` → **503 `SERVICO_INDISPONIVEL`** (T30). O cliente não deve refazer login por causa disso. Cache expirado com o JWKS fora do ar também dá 503, mesmo com a chave antiga na memória.
  - Chave existe mas nenhuma casa com o `kid`, assinatura errada ou claim errada → `token_invalido` → **401 `NAO_AUTENTICADO`** com `WWW-Authenticate: Bearer`.
- A classificação não depende do texto das mensagens do `jose`: o resolvedor de chave envolve o JWKS remoto e marca as próprias falhas.
- A busca é preguiçosa (na primeira requisição autenticada). Buscas simultâneas são deduplicadas pelo `jose`.

### D6. Ambiente
- `SUPABASE_URL` (origem exata, `https`; `http` só em loopback, para o Supabase local) e `SUPABASE_JWKS_URL`, **obrigatórios** e validados no `main.ts`. O JWKS precisa ser exatamente `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`: um erro de digitação que aponte para outro projeto derruba a subida. Sem as duas, o processo não sobe.
- Os nomes já estavam no `.env.example`; nenhum valor entra no repositório nem no cofre.

### D7. Logs (SR-12)
- O hook não loga token, header, claim, `sub` nem motivo da recusa. A lista fechada do ADR-010 já impede isso na escrita final.
- A única linha nova é `autenticacao_indisponivel` (nível `warn`, sem campos), quando o JWKS falha: é sinal operacional do T30 (Supabase pausado).

## 3. Auditoria `[APPSEC]` (antes do código)
- **Sem veto.** Restrições que viraram critério de aceite:
  1. Teste para cada recusa: `alg none`, HS256 com segredo qualquer, **HS256 com a chave pública como segredo**, ES384/RS256, `kid` desconhecido, sem `kid`, sem `exp`, expirado além da tolerância, `iat` no futuro, token mais velho que 900 s, `iss` e `aud` errados, `aud` em array, `role` ≠ `authenticated`, `is_anonymous` `true` e ausente, `sub` fora de UUID, `typ` errado, `crit` desconhecido e assinatura de outra chave com o mesmo `kid`.
  2. `alg none` e HS256 **não** podem causar busca no JWKS (contador do servidor falso em zero).
  3. JWKS vazio, só RSA, 500, JSON inválido, lento e porta fechada → 503, nunca 200.
  4. Nenhum teste toca o projeto Supabase real: JWKS servido em `127.0.0.1` com chaves geradas no teste.
  5. Canário de token e de `sub` ausente de todas as linhas de log (SR-12).
  6. O verificador nunca rejeita (propriedade com entrada arbitrária).
- **Dependência nova:** `jose` **6.2.12** (MIT, zero dependências, sem script de instalação, proveniência SLSA v1). A 6.2.13 saiu em 2026-10-20 e cai na quarentena de 3 dias (T26); o changelog dela só tem refatoração, sem correção de segurança.
- **Resíduo fechado na implementação:** o `jose` não limita o tamanho da resposta do JWKS. O adapter passa um `customFetch` com teto de 64 KiB (D5).
- **Residual:** antes da autenticação, o custo de um token forjado é uma verificação ES256 (sem rede). O limite por IP do F1-API-03 cobre a inundação. **Corrigido pelo [ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md) §3 (2026-10-21):** o limite por IP roda depois do JWT, para proteger o orçamento de comandos do Redis. A inundação sem token fica para a borda da hospedagem (S-5).

## 4. Verificação (2026-10-21)
- 122 testes novos na API (68 do adapter contra o JWKS local, 34 do hook e 20 do ambiente; total 965). Cobertura de 100% em linhas e ramos (904/904), incluindo o adapter, o hook e a validação do ambiente.
- Mutação 55/55 (script fora do repositório). Na primeira rodada sobraram 5 mutantes: 2 eram código equivalente (`audience` e `iat` em `requiredClaims`) e foram removidos; os outros 3 viraram testes (JWKS fora do ar com cache expirado, `kty` incoerente e prefixo antes de `Bearer`).
- *Smoke* do JS compilado: sem `SUPABASE_*`, sai com código 1 antes de abrir a porta; com o Supabase em loopback sem JWKS, `/health` dá 200, rota sem token dá 401 e com token dá 503 (`autenticacao_indisponivel` no log, sem token).

- Turbo 18/18 em série (`--concurrency=1`) e depcruise verde (231 módulos). **Em paralelo, o SR-09 do seletor (200 ms de relógio de parede) falhou em 7 de 8 rodadas, contra 1 de 3 na base (`f63e0ef`, medida numa worktree).** O domínio não mudou e o SR-09 passa isolado. A causa é a ordem do turbo: com hashes novos, o `api:test` passou a rodar ao mesmo tempo que o `next build` do portal. O orçamento não foi afrouxado; a decisão ficou no *BACKLOG §QA-01*.

## 5. Consequências
- `BuildAppOptions.accessTokenVerifier` é obrigatório; `request.principal` existe em toda rota protegida.
- O F1-API-03 encaixa o rate limit por usuário logo depois deste hook, com o `userId` já verificado.
- **Revisar no S-3 (E2E):** `typ` e `session_id` reais do token do Supabase.
