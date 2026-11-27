---
tipo: adr
id: ADR-030
titulo: "Hospedagem do portal e da API (S-5): a API num processo longo no Koyeb (Washington, D.C.) atrás da Cloudflare com um segredo de borda, o portal no Vercel (iad1), tudo perto do Supabase e do Upstash em us-east-1; o IP do cliente pelo CF-Connecting-IP só com a borda provada; implantação só do master; anéis de chave disjuntos por plataforma"
status: proposto
aprovacao: "Desenho técnico interno ([ARCHITECT] + [APPSEC], sem veto, 14 condições). A escolha de provedor, o domínio e as contas são do humano (HITL-047, com a sonda de medição antes do aceite). Nenhum código de infraestrutura nesta sessão."
data: 2026-11-16
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "apps/api (borda: origem do IP do cliente, segredo de borda, keepAliveTimeout; Dockerfile futuro), apps/web-portal (configuração de produção), DNS e Cloudflare, painéis do Koyeb e do Vercel, painel do Supabase (Redirect URLs), threat-model, runbooks"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[ADR-004-extension-auth](ADR-004-extension-auth.md)", "[ADR-007-api-edge](ADR-007-api-edge.md)", "[ADR-010-log-allowlist-and-telemetry](ADR-010-log-allowlist-and-telemetry.md)", "[ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md)", "[ADR-017-analyze-job-and-stream](ADR-017-analyze-job-and-stream.md)", "[ADR-019-ci-github-actions](ADR-019-ci-github-actions.md)", "[ADR-027-portal-login](ADR-027-portal-login.md)", "[ADR-028-portal-criteria](ADR-028-portal-criteria.md)", "[ADR-029-account-export-and-delete](ADR-029-account-export-and-delete.md)", "[threat-model](../threat-model.md)", "*spike-metrics*", "*BACKLOG §S-5*", "*HITL-QUEUE §HITL-047*", "*hospedagem-s5*", "*spike-s3*"]
---

# ADR-030: Hospedagem do portal e da API (S-5)

> **Nome:** o [ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md) §10.6, o [ADR-007-api-edge](ADR-007-api-edge.md) (D5 e §3) e o *BACKLOG §S-5* reservavam o número **ADR-003** para esta decisão. O número 003 fica sem uso, e toda menção a "ADR-003 (hospedagem)" passa a valer como este ADR-030.

## 1. Contexto

O portal (Next.js 16.4.2) e a API (Fastify 5) só rodaram em `127.0.0.1` até aqui. Três coisas dependem de hospedá-los:
- o build real da extensão só aceita a API em `https://` (*auth-extensao* §1.7), então o bloco E do spike S-3 (*spike-s3*) espera esta decisão;
- a lentidão relatada no *HITL-QUEUE §HITL-044* e no *HITL-QUEUE §HITL-045* tinha o portal e a API no Brasil, pagando, em série, a viagem de ida e volta até `us-east-1` a cada chamada ao GoTrue e ao PostgREST ([ADR-027-portal-login](ADR-027-portal-login.md) §12, [ADR-029-account-export-and-delete](ADR-029-account-export-and-delete.md) §6.2);
- os residuais "até o S-5" do [threat-model](../threat-model.md) §9: o balde por IP do portal na API, a renovação do portal sem limitador, o `keepAliveTimeout`, o `TRUST_PROXY` real, o exportador de métricas, a retenção dos *logs* da plataforma e o tamanho do cookie.

### 1.1 Fatos conferidos antes do desenho (documentação oficial, lida em 2026-11-16 por um agente de leitura; cada item tem a URL no SESSION-LOG da sessão 33)

**Requisitos do código (lidos no repositório):**
- **R1.** A API é um processo longo com estado local por instância: o limitador pré-JWT, o orçamento e o *bulkhead* do GoTrue, o *single-flight* e a `InMemoryTelemetry` ([ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md) D10, [ADR-010-log-allowlist-and-telemetry](ADR-010-log-allowlist-and-telemetry.md) D6). Funções efêmeras multiplicariam esse estado.
- **R2.** O stream de análise dura até cerca de 12,5 s no servidor (prazo do router de 12 s), e o cliente dá 10 s até o status, 20 s entre pedaços e 45 s no total ([ADR-017-analyze-job-and-stream](ADR-017-analyze-job-and-stream.md) D2 e D6; [ADR-025-side-panel-ui](ADR-025-side-panel-ui.md)). Um *cold start* longo estoura os 10 s do status.
- **R3.** O `TRUST_PROXY` aceita só IPs e CIDRs exatos; `true`, `*`, `/0` e contagem de saltos são recusados ([ADR-007-api-edge](ADR-007-api-edge.md) D5). O `API_BEHIND_PROXY` precisa concordar com ele ([ADR-014-rate-limit-and-quota](ADR-014-rate-limit-and-quota.md) D10).
- **R4.** O portal lê as variáveis só em tempo de execução, sela os cookies com o `PORTAL_ORIGIN` no AAD e manda os cabeçalhos do D8 uma vez cada ([ADR-027-portal-login](ADR-027-portal-login.md) D4, D8 e D9). O `proxy.ts` roda no runtime Node.

**Fatos dos provedores (só documentação oficial):**
- **F1. Render Free:** 0,1 CPU e 512 MB; o serviço dorme depois de 15 min sem tráfego, e o retorno leva "about one minute"; "Do not use them for production applications"; o Render pode suspender um serviço Free com tráfego incomum, e o exemplo dado é "Accessing an external database". Regiões com Virginia. Timeout, *buffering* de SSE e o cabeçalho do IP do cliente: não documentados. Faixas de IP de entrada: não publicadas.
- **F2. Koyeb Free:** 512 MB e 0,1 vCPU; **uma instância Free por organização**, só como Web Service, só em **Frankfurt ou Washington, D.C.**; dorme depois de 1 h sem tráfego, com retorno de 1 a 5 s; cartão obrigatório (pré-autorização); timeout de conexão HTTP de 100 s; o Koyeb **anexa** ao `X-Forwarded-For` o IP que se conectou a ele ("the last IP … is the only IP we can certify as valid"); faixas da borda não publicadas; TLS termina na borda, sem redirecionar HTTP para HTTPS; *health check* HTTP configurável; *secrets* cifrados, e um membro da organização pode revelá-los pela CLI.
- **F3. Vercel Hobby:** uso **só pessoal ou não comercial** (termos, seção 4); funções de até 300 s, com o Fastify virando **uma função**, não um processo longo; região padrão `iad1` (Washington, D.C.); o Vercel **sobrescreve** o `X-Forwarded-For` (o `x-real-ip` é igual) e não publica faixas; HSTS padrão `max-age=63072000` sem `includeSubDomains`; variáveis do tipo *sensitive* só de escrita; logs de execução por **1 hora**, sem *drains* no Hobby; *rollback* só para o deploy anterior; *preview deployments* para os outros branches.
- **F4. Cloudflare Free (proxy reverso):** o `CF-Connecting-IP` traz um único IP; um `X-Forwarded-For` que já vem do cliente é **anexado**, não trocado; as faixas da Cloudflare são publicadas (listas e API com `etag`); o tempo de leitura da origem é de **125 s** (erro 524), configurável só no Enterprise; o corpo da resposta segue sem *buffer* quando nenhuma função ativa precisa dele, e o "Response Body Buffering" aceita `none` por Configuration Rule; **1 regra** de rate limiting (por IP, período de 10 s) e 5 regras de WAF no Free; HSTS configurável no painel; o modo Full (strict) dá 526 com certificado inválido na origem.
- **F5. Cloudflare Workers + OpenNext:** Next.js 16 suportado, o `proxy.ts` (Node) só como **experimental**, e **10 ms de CPU** por requisição no Free.
- **F6. Cloud Run:** exige conta de faturamento para o Free Tier; streaming sem configuração; timeout de até 3.600 s; `us-east4` (N. Virginia) no Tier 1; domínio próprio em *Preview* ("not production-ready"); como a URL `run.app` trata o `X-Forwarded-For`: não documentado.
- **F7. Fly.io:** "New organizations don't have a free tier".
- **F8. Next.js (self-hosting):** recomenda um proxy reverso na frente; o streaming exige que o balanceador não faça *buffer*; o `ip` saiu do `NextRequest` ("provided by your hosting provider").
- **F9. Fastify 5.12.8:** a contagem de saltos ficou proibida ("cannot validate the immediate peer"), e o `request.ips` deve ser tratado como entrada não confiável.
- **F10. hstspreload.org:** HTTPS em todos os subdomínios, `max-age` ≥ 31.536.000 com `includeSubDomains` e `preload`, e a remoção da lista leva meses.

## 2. Decisões

### D1. Topologia (decisão do `[ARCHITECT]`, a escolha final de provedor é do humano no HITL-047)
- **API:** um processo Node (o `main.ts` de hoje) num contêiner do **Koyeb Free, em Washington, D.C.**, uma instância só. Atrás dele, a **Cloudflare Free** em modo proxy, no subdomínio `api.<domínio>`.
- **Portal:** o **Vercel Hobby, região `iad1`**, no domínio `<domínio>` (ou `app.<domínio>`), com o DNS na Cloudflare **sem proxy** (nuvem cinza): o Vercel termina o TLS e sobrescreve o `X-Forwarded-For` (F3).
- **Banco e Redis:** sem mudança (Supabase e Upstash em AWS `us-east-1`).
- **Por que essa combinação:**
  - o Render cai pelo R2 (o retorno de cerca de 1 min estoura o prazo de 10 s do status) e pela cláusula de suspensão por banco externo (F1);
  - o Vercel cai para a API pelo R1 (função, não processo) e o Workers cai para o portal pelo F5 (10 ms de CPU e o `proxy.ts` experimental);
  - o Koyeb é o único processo longo gratuito com retorno de segundos e uma região a poucos milissegundos do `us-east-1`;
  - Washington, D.C. (Koyeb), `iad1` (Vercel) e `us-east-1` (AWS) ficam na mesma área: as chamadas da API ao GoTrue, ao PostgREST e ao Upstash, e as do portal ao GoTrue e à API, deixam de cruzar o equador. **Só a primeira perna (navegador ou extensão até a borda) paga a viagem do Brasil.**
- **Alternativa B (se a sonda reprovar o Koyeb):** a API no Cloud Run em `us-east4`, com o mesmo desenho de borda (D2). Exige conta de faturamento.
- **Limites aceitos para a Fase 1 (projeto pessoal, um usuário):** o Vercel Hobby é não comercial e o Koyeb Free "não é para produção". Na Fase 2 (beta público, cobrança), os dois saem do plano gratuito ou de provedor, por ADR.

### D2. O IP do cliente na API: a borda provada por um segredo, e só então o `CF-Connecting-IP`
O Koyeb não publica as faixas da borda (F2), então o `TRUST_PROXY` com CIDR exato não tem base (R3). E a Cloudflare na frente de um PaaS não basta sozinha: a origem continua alcançável pela URL própria do Koyeb, sem passar pela Cloudflare.
- **Segredo de borda:** uma Transform Rule da Cloudflare põe em todo pedido para `api.<domínio>` o cabeçalho `X-Trampo-Borda: <kid>.<valor>`. A API confere o cabeçalho contra um anel novo, `EDGE_AUTH_KEYS` (1 a 2 chaves, para a rotação), em tempo constante, **antes** de tudo (CORS, JWT, corpo e rate limit). Sem o cabeçalho, ou com valor errado: 403 `PROIBIDO`, e o pedido não chega a nada mais.
- **A exceção é o `GET /health`**, que o *health check* do Koyeb chama direto na instância. Ele não tem token nem versão e não muda.
- **IP do cliente:** com a borda provada, o `request.ip` vem do `CF-Connecting-IP` (um IP, conferido por `net.isIP`; fora da forma, o balde único do D4 do ADR-014). O `X-Forwarded-For` é ignorado nesse modo.
- **Configuração nova:** `API_CLIENT_IP_SOURCE=cloudflare` (o outro valor é `socket`, o de hoje com `TRUST_PROXY`). O boot recusa a combinação incoerente: `cloudflare` sem `EDGE_AUTH_KEYS`, `cloudflare` com `TRUST_PROXY`, ou `EDGE_AUTH_KEYS` sem `cloudflare`. O `API_BEHIND_PROXY=true` continua obrigatório em produção.
- **O que um segredo de borda vazado permite:** forjar o `CF-Connecting-IP` e espalhar o balde por IP. Não permite passar do JWT, do balde por usuário nem da cota. O anel tem duas posições para trocar sem parada.

### D3. Portal, API e o balde por IP ([ADR-028-portal-criteria](ADR-028-portal-criteria.md) D9)
- O portal chama `https://api.<domínio>` pela Cloudflare como qualquer cliente. O `CF-Connecting-IP` desses pedidos é o IP de saída do Vercel, que não é publicado nem fixo (F3).
- **A opção (a) do ADR-028 D9 cai:** não há faixa do Vercel para confiar, e confiar num `X-Forwarded-For` que o portal mandasse deixaria um portal comprometido escolher o IP de qualquer pedido.
- **Fase 1: o residual fica aceito.** Com um usuário, os usuários do portal dividirem o balde por IP da API (`padrao` 120, `criterios` 30, `conta` 10 por minuto) não tem efeito. O portal **continua sem mandar** `X-Forwarded-For`.
- **Fase 2 (antes do beta):** a opção (b), uma credencial de servidor a servidor (anel próprio do portal, nunca o da borda) que leva o pedido do portal a uma classe sem a dimensão de IP, só com a de usuário. O `[APPSEC]` revê isso com o T51 antes do código.

### D4. Domínio, origens, Site URL e HSTS
- **Um domínio comprado pelo humano** (HITL-047), com o DNS na Cloudflare. `PORTAL_ORIGIN=https://<domínio>` e `API_ORIGIN=https://api.<domínio>`; a extensão é construída com `TRAMPO_API_ORIGIN=https://api.<domínio>`.
- **Redirect URLs (allow-list exata):** a da extensão (`https://<id>.chromiumapp.org/auth`) e a do portal (`https://<domínio>/auth/retorno`). Nenhuma loopback.
- **O Site URL continua na opção A** (`https://<id>.chromiumapp.org/`, NXDOMAIN). **Emenda ao [ADR-004-extension-auth](ADR-004-extension-auth.md) D15:** o plano de trocar o Site URL por uma página estática no S-5 sai. A opção A não tem servidor, página nem log; a página estática teria (no Vercel, os logs guardam o caminho com a query por 1 hora). O Site URL só muda quando o ID muda (PRE-LOJA-01). **A entrada nova do portal na allow-list obriga a refazer os casos E e F** (o bloco E2 do *spike-s3*), para provar que ela não alarga a lista.
- **HSTS:** quem manda é o portal (`max-age=63072000; includeSubDomains`, D8 do ADR-027), uma vez. O HSTS da Cloudflare fica **desligado** e o do Vercel é medido na sonda: se ele somar um segundo cabeçalho, o portal passa a depender do do Vercel ou a sonda define a configuração que deixa um só (condição 6). **`preload` só na Fase 2, por HITL**, com a rampa do hstspreload.org (300 s, uma semana, um mês) e todos os subdomínios em HTTPS, porque sair da lista leva meses.
- **`CORS_ALLOWED_ORIGINS`:** só o `chrome-extension://<id>` (hoje o de desenvolvimento; o de produção com a PRE-LOJA-01). O portal não entra (ele não manda `Origin`, ADR-028 D1).

### D5. Segredos: onde cada anel mora
| Onde | Variáveis (só os nomes) | Quem vê |
|---|---|---|
| **Koyeb (API), *secrets*** | `SUPABASE_PUBLISHABLE_KEY`, `UPSTASH_REDIS_REST_TOKEN`, `RATE_KEY_PEPPER`, `CRITERIA_SALARY_KEYS` e `_ACTIVE_KEY`, `AUTH_REFRESH_SEAL_KEYS` e `_ACTIVE_KEY`, `GROQ_API_KEY`, `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` (Workers AI), `EDGE_AUTH_KEYS` | só o humano (organização de um membro, 2FA) |
| **Vercel (portal), *sensitive*** | `PORTAL_SEAL_KEYS` e `_ACTIVE_KEY`, `SUPABASE_PUBLISHABLE_KEY` | só o humano (2FA); só de escrita depois de salvar |
| **Cloudflare (a Transform Rule)** | o valor ativo do `EDGE_AUTH_KEYS` | só o humano (2FA) |
| **Variáveis comuns (não secretas)** | `NODE_ENV=production`, `SUPABASE_URL`, `SUPABASE_JWKS_URL`, `UPSTASH_REDIS_REST_URL`, `API_BEHIND_PROXY=true`, `API_CLIENT_IP_SOURCE=cloudflare`, `CORS_ALLOWED_ORIGINS`, `LLM_PROVIDER_CHAIN`, `AUTH_SESSION_*`, `AUTH_ALLOWED_AMR`; no portal, `PORTAL_ORIGIN`, `API_ORIGIN`, `NEXT_TELEMETRY_DISABLED=1` | — |

- **Anéis disjuntos por plataforma:** o Vercel nunca recebe um anel da API, e o Koyeb nunca recebe o do portal. Um portal comprometido não abre a pretensão nem o envelope do refresh.
- **Nenhuma chave *secret* do Supabase nem `service_role`** em lugar nenhum (ADR-029 D1). **O boot da API passa a recusar** a variável `SUPABASE_SECRET_KEY` presente (condição 5), e ela sai do `.env.example`.
- **Geração e guarda:** cada anel é gerado na estação do humano (o mesmo procedimento do *auth-extensao* §1.3), colado direto no painel e guardado no gerenciador de senhas. Nada no cofre, no git ou no chat.
- **Rotação:** acrescentar a chave nova ao anel, trocar a ativa e manter a antiga pelo tempo de vida do que ela selou: 24 h para o refresh e para o cookie do portal, e **para sempre** para a pretensão salarial (ela só sai do anel depois de um recifrar, que não existe hoje: item novo no *BACKLOG*).

### D6. Observabilidade
- **Logs:** o `stdout` em JSON com a lista fechada do [ADR-010-log-allowlist-and-telemetry](ADR-010-log-allowlist-and-telemetry.md), lido pelo painel de cada plataforma. Retenção: Vercel 1 h (F3); Koyeb Free não documentada (a sonda anota); Supabase, a do plano (a sonda anota, linha da §9 do [threat-model](../threat-model.md)). Nenhum *log drain* na Fase 1.
- **Métricas:** a `InMemoryTelemetry` ganha um exportador mínimo: **uma linha de log `telemetria_resumo` a cada 15 minutos**, com os contadores do catálogo do ADR-010 D6 e nenhum rótulo com identificador. Isso cumpre o "exportador externo depende da hospedagem" sem provedor novo. O evento `account` da *BACKLOG §F1-PORTAL-05* entra no mesmo resumo. OTLP para um serviço gerenciado fica para a Fase 2, por HITL (é mais um terceiro vendo dados).
- **Health check:** o Koyeb chama `GET /health` (HTTP, intervalo padrão). **Nenhum *keep-alive* artificial** contra o sono de 1 h sem confirmar nos termos que é permitido (T30). O primeiro pedido depois do sono paga de 1 a 5 s (F2), dentro dos 10 s do status.

### D7. Implantação
- **Só do `master`:** o Koyeb faz o deploy a cada push no `master`, e o `master` só recebe merge de PR com os 4 checks obrigatórios (a proteção do HITL-025, opção B). O deploy depois do CI vem da proteção do branch, sem token no GitHub Actions. **O `ci.yml` continua sem segredo** e o `@trampo/ci-policy` não muda.
- **Vercel:** o branch de produção é o `master`, e **os *preview deployments* ficam desligados** (uma URL de preview com as variáveis de produção seria um portal paralelo). Se o painel do Hobby não permitir desligar, o `vercel.json` ignora todo branch que não seja o `master`.
- **Imagem da API:** um `Dockerfile` no repositório (fatia própria): a imagem `node` com a mesma versão do CI, `pnpm deploy --prod` da API, usuário sem privilégio, `.dockerignore` sem `.env*`, nada de segredo na imagem, e uma varredura do sistema de arquivos da imagem no CI (o molde do B5 da extensão).
- **Rollback:** no Koyeb, o deploy antigo serve até o novo ficar saudável; voltar é um *revert* no `master` por PR, ou o redeploy do anterior pelo painel. No Vercel, o *instant rollback* para o anterior. O runbook descreve os dois.

### D8. Prazos da borda da API ([ADR-007-api-edge](ADR-007-api-edge.md) D4)
- O `keepAliveTimeout` de 5 s fica abaixo da ociosidade dos balanceadores na frente (a Cloudflare reusa a conexão com a origem), o que dá 502 esporádico quando a origem fecha um *socket* que o balanceador ainda usa. **A sonda mede** a taxa de 502 com pedidos espaçados; a emenda do D4 (um valor acima da ociosidade do Koyeb, com o `headersTimeout` acompanhando) entra na fatia do código, com o número medido.
- O stream de até 12,5 s cabe nos 100 s do Koyeb (F2) e nos 125 s da Cloudflare (F4). Uma Configuration Rule põe o "Response Body Buffering" em `none` para `/v1/analyze`.

### D9. Região e LGPD
- Tudo nos EUA, como o banco já está. O portão LGPD da Fase 2 (art. 33, [threat-model](../threat-model.md) §8) continua valendo e agora inclui o Koyeb, o Vercel e a Cloudflare como operadores.

### D10. O que NÃO entra
- Nenhum código de infraestrutura nesta sessão (o `Dockerfile`, o modo `cloudflare` da borda e o resumo de telemetria são fatias futuras).
- Nenhuma conta criada pela equipe; nenhum painel tocado.
- O build de loja da extensão (PRE-LOJA-01) e a credencial de servidor a servidor do D3 (Fase 2).

## 3. Auditoria do `[APPSEC]` (sem veto, 14 condições)

**Fronteiras novas:** **TB14** (Cloudflare → origem da API: o segredo de borda) e **TB15** (as plataformas de hospedagem: Koyeb, Vercel e Cloudflare terminam o TLS e veem o tráfego em claro).

**O que cada provedor vê (tabela nova da §3 do [threat-model](../threat-model.md)):**
| Provedor | Vê em claro | Guarda |
|---|---|---|
| Cloudflare (proxy da API) | o corpo de cada pedido à API (o texto da vaga), o Bearer, o IP do usuário | sem logs de pedido no Free para o cliente; a Cloudflare processa |
| Koyeb (API) | tudo o que a API vê, e os segredos dela | os logs do `stdout` (lista fechada) |
| Vercel (portal) | o cookie selado (não o abre sem o anel), o IP, o `code` do retorno do OAuth na URL | os logs de execução por 1 h, com o caminho e a query |
| Supabase, Upstash | sem mudança | sem mudança |

**Ameaças:**
- **T53 (nova): a origem alcançada sem a borda.** Quem acha a URL própria do Koyeb pula a Cloudflare (rate limit e WAF) e forja o `CF-Connecting-IP`. Mitigação: o segredo de borda antes de tudo (D2).
- **T54 (nova): a plataforma como ponto de leitura.** Um operador ou uma conta comprometida do Koyeb ou do Vercel lê os segredos e o tráfego. Mitigação: anéis disjuntos, nenhuma chave de alto privilégio (sem `service_role`), 2FA, organizações de um membro e o *rollback* documentado. Residual aceito para a Fase 1.
- **T48 revista:** o `code` do retorno do portal fica 1 h nos logs do Vercel. Ele é de uso único, vale 5 min e não serve sem o verifier, que mora só no cookie selado. Residual baixo.
- **T7, T30, T43:** o sono do Koyeb não pode virar "serviço fora" (1 a 5 s cabe no prazo); o limitador por instância continua valendo com uma instância.
- **§9, linha do JSON alheio (P21):** o WAF e o rate limiting da Cloudflare respondem com página HTML, nunca com JSON com `error_code`; o adapter lê `nao_recebido`, e a sessão não é apagada. A sonda confere.

**Condições (cada uma com teste ou medida):**
1. **A borda vem antes de tudo:** sem o `X-Trampo-Borda` válido, 403 antes do CORS, do JWT, do corpo e do rate limit; nenhum *log* com o valor; comparação em tempo constante; a exceção é só o `GET /health` (teste de unidade e de socket real).
2. **O IP só do `CF-Connecting-IP` com a borda provada;** o `X-Forwarded-For` ignorado nesse modo; valor fora da forma cai no balde único (teste).
3. **O boot recusa a configuração incoerente** (o modo sem o anel, o anel sem o modo, o modo com `TRUST_PROXY`), sem ecoar valor.
4. **Nenhum *preview* com as variáveis de produção** (Vercel) e **deploy só do `master`** (Koyeb); a sonda confere.
5. **Nenhuma chave de alto privilégio:** o boot da API recusa `SUPABASE_SECRET_KEY` presente; o `.env.example` perde a linha.
6. **Cabeçalhos uma vez cada no ambiente hospedado** (HSTS, CSP, `X-Content-Type-Options`), medidos pela sonda; se o Vercel somar um HSTS, a configuração muda antes do aceite.
7. **SSE sem *buffer* de ponta a ponta:** a sonda mede o instante de chegada de cada pedaço de um stream sintético de 45 s pela Cloudflare e pelo Koyeb.
8. **A imagem sem segredo:** `.dockerignore`, usuário sem privilégio e a varredura do sistema de arquivos da imagem no CI.
9. **O WAF e o rate limiting da Cloudflare nunca respondem JSON com `error_code`** nas rotas de auth (a sonda confere o corpo do 429 dela).
10. **O HSTS com `preload` só por HITL**, depois da rampa e com todos os subdomínios em HTTPS.
11. **Os anéis disjuntos:** a lista do D5 vira teste do boot do portal (nenhuma variável da API é lida) e da API (nenhuma do portal).
12. **Nenhum *keep-alive* artificial** sem a confirmação dos termos.
13. **O resumo de telemetria sem identificador:** só os rótulos do catálogo do ADR-010 D6 (teste com canário de `sub`, IP e texto).
14. **Aceite só depois da sonda** do *hospedagem-s5* (HITL-047) com os números no *spike-metrics* §6.

**Residuais (§9 do [threat-model](../threat-model.md)):** o balde por IP dividido pelo portal (D3, até a Fase 2); o `code` do OAuth nos logs do Vercel por 1 h; a plataforma como ponto de leitura (T54); o Koyeb e o Vercel gratuitos sem compromisso de disponibilidade (T30); a retenção dos logs do Koyeb e do Supabase (a medir).

## 4. Plano de testes

**O que se prova antes da hospedagem (fatias de código, sem conta nenhuma):**
- unidade e socket real da borda nova (condições 1 a 3 e 5): pedido sem o cabeçalho, com o valor errado, com o `kid` desconhecido, com dois cabeçalhos, com o `CF-Connecting-IP` forjado sem a borda, com o `X-Forwarded-For` hostil no modo `cloudflare`, o `/health` sem cabeçalho;
- **um proxy reverso local em Node** (`test/support`) com TLS de teste na frente da API e do portal: os cabeçalhos uma vez cada, os cookies `__Host-` com `Secure` atrás de proxy, o `X-Forwarded-Proto`, e o SSE chegando em pedaços (instante de cada um), com o mesmo arnês;
- a imagem: build, usuário, `.dockerignore` e a varredura;
- o resumo de telemetria com canários.

**O que só o ambiente real prova (HITL com runbook):** o retorno depois do sono, o p50 e o p95 a partir do Brasil, o SSE pela Cloudflare e pelo Koyeb, o cabeçalho de IP que chega, o HSTS do Vercel, o corpo do 429 da Cloudflare, a retenção dos logs e os 502 do *keep-alive*. A sonda do *hospedagem-s5* usa uma imagem de demonstração **sem segredo real** (o guardrail do *BACKLOG §S-5*): um Fastify mínimo com `/health`, um eco dos cabeçalhos de origem (só os nomes e o IP que a API veria) e um SSE sintético de 45 s.

## 5. Partição (trilhas futuras, uma por vez)
1. **S-5a (código):** o modo `cloudflare` da borda, o anel `EDGE_AUTH_KEYS`, a recusa da `SUPABASE_SECRET_KEY` e o proxy local de teste; emendas do ADR-007 D5 e do ADR-014 D10.
2. **S-5b (código):** o `Dockerfile`, o `.dockerignore`, a varredura da imagem no CI (com a política do `@trampo/ci-policy`), a imagem da sonda e o resumo de telemetria (F1-OBS-03).
3. **HITL-047 (o humano):** contas (2FA), domínio, zona da Cloudflare e a sonda; os números no *spike-metrics* §6; o aceite deste ADR.
4. **HITL seguinte (o humano):** o deploy real da API e do portal, a allow-list com o portal, a extensão construída com a API real, e então o bloco E do *spike-s3*.

## 6. Alternativas consideradas
- **Render para a API:** recusada (R2 e a cláusula de suspensão, F1).
- **Vercel para a API:** recusada (R1: função, não processo; o estado local se multiplicaria).
- **Workers + OpenNext para o portal:** recusada (10 ms de CPU e o `proxy.ts` experimental, F5).
- **Cloud Run:** alternativa B da API (exige faturamento; domínio próprio em *Preview*).
- **Fly.io:** sem plano gratuito (F7).
- **Confiar no último salto do `X-Forwarded-For` do Koyeb** (uma função que confia no par imediato): recusada. A origem também é alcançável pela URL própria do Koyeb, então o par imediato não prova nada sobre a Cloudflare, e o Fastify 5.12.8 proibiu a contagem de saltos (F9).
- **Cloudflare Tunnel:** exigiria o `cloudflared` ao lado da API no mesmo contêiner; mais peças para um ganho que o segredo de borda já dá.

## 7. Emendas a outros documentos
- [ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md) §10.6 e *BACKLOG §S-5*: o "ADR-003 (hospedagem)" é este ADR-030; os candidatos Render e Koyeb foram avaliados, e o Render saiu.
- [ADR-004-extension-auth](ADR-004-extension-auth.md) D15: o Site URL fica na opção A; a troca por página estática no S-5 sai do plano (D4).
- [ADR-007-api-edge](ADR-007-api-edge.md) D4 e D5: o `keepAliveTimeout` muda pela medida (D8), e o modo `cloudflare` entra ao lado do `TRUST_PROXY` (D2), na fatia S-5a.
- [ADR-028-portal-criteria](ADR-028-portal-criteria.md) D9: a opção (a) cai; Fase 1 com o residual; Fase 2 com a (b) (D3).
- [ADR-010-log-allowlist-and-telemetry](ADR-010-log-allowlist-and-telemetry.md) D6: o exportador da Fase 1 é o resumo no log (D6).
- [threat-model](../threat-model.md): TB14, TB15, T53, T54, a tabela do que cada provedor vê e as linhas da §9.

## 8. Emenda da sessão 34 (2026-11-27): Cloud Run em `us-east4`, sem domínio próprio e sem Cloudflare (HITL-047 partes 1 e 2)

**Decisões do humano (*HITL-QUEUE §HITL-047*):** a API no **Google Cloud Run, região `us-east4`** (o Koyeb bloqueou contas novas na fusão com a Mistral; o projeto `trampo-app-api` fica numa conta Google dedicada, separada da conta de identidade do login, com 2FA, só o humano e um alerta de orçamento de R$ 1,00); o portal no **Vercel Hobby** (aceito como uso pessoal na Fase 1); **sem domínio próprio** (custo zero estrito: as URLs nativas `*.run.app` e `*.vercel.app`); **sem Cloudflare**. O status do ADR continua `proposto` até a sonda (condição 14).

### 8.1 Fatos novos (documentação oficial, lida em 2026-11-27 por um agente de leitura; URLs no SESSION-LOG da sessão 34)
- **F11.** O Cloud Run **não documenta** o tratamento do `X-Forwarded-For`, do `Forwarded` e do `X-Real-IP` na URL `run.app`; o formato `EXISTING_VALUE,CLIENT_IP,LOAD_BALANCER_IP` (o valor do cliente preservado à esquerda, só as entradas acrescentadas pelo Google confiáveis) está documentado só para o *external Application Load Balancer*. Uma amostra oficial em Node (`nodejs-docs-samples`, PR #3586) usa `trust proxy = 1` "porque o Cloud Run tem o próprio proxy". **Conclusão: só a sonda decide.**
- **F12.** O Cloud Run decodifica alguns caracteres do caminho antes do contêiner (`%41` vira `A`); `..`, `%2F` e `//` não são documentados; caminhos que começam com `/_ah/` são reservados, e a documentação recomenda evitar caminhos terminados em `z`.
- **F13.** Nível gratuito por conta de faturamento, aplicado também em `us-east4` (Tier 1): no modo de cobrança **por requisição**, 180.000 vCPU-s, 360.000 GiB-s e 2 milhões de requisições por mês; 1 GiB de saída na América do Norte; Artifact Registry com 0,5 GB.
- **F14.** No modo por requisição (o padrão), **a CPU só existe durante a requisição**; instâncias ociosas ficam até 15 min e podem ser desligadas a qualquer momento; um serviço sem pedido não acorda sozinho. Um `setInterval` de 15 min **não é confiável**.
- **F15.** *Timeout* padrão de 300 s (até 3.600 s, depois 504); streaming de resposta sem configuração (`Transfer-Encoding: chunked`); o HTTP/2 vira HTTP/1 até o contêiner; o *buffer* do GFE não é documentado.
- **F16.** Mínimo de instâncias 0 por padrão; máximo 100 por revisão (pode passar por instantes); concorrência 80 (até 1.000).
- **F17.** Contrato do contêiner: escutar em `0.0.0.0` na `PORT` (padrão 8080); o `SIGTERM` dá 10 s antes do `SIGKILL`; pedido de até 32 MiB em HTTP/1.
- **F18.** *Ingress* `all` (a URL `run.app` pública) e o serviço público pela opção que desliga a checagem de IAM do invocador (recomendada pela documentação), ou `allUsers` com `run.invoker`. A URL `run.app` exige HTTPS sempre; o GFE termina o TLS e aplica proteção contra DoS.
- **F19.** Segredos pelo Secret Manager como variável ou volume (resolvidos na partida da instância), com nível gratuito de **6 versões ativas** e 10.000 acessos por mês. O deploy sem chave guardada no GitHub é possível por Workload Identity Federation.
- **F20.** O Vercel Hobby roda as funções numa região só (`iad1` por padrão), com IP de saída dinâmico (IP fixo só no Pro e no Enterprise); o Hobby é "personal or non-commercial use".

### 8.2 Decisões revistas (`[ARCHITECT]`)
- **D1 (topologia):** a API é um contêiner no **Cloud Run `us-east4`** (Ashburn, Virgínia), modo de cobrança por requisição, **mínimo 0 e máximo 1 instância** (o estado local por processo do R1 continua coerente, e o custo fica preso ao nível gratuito), concorrência 80, 1 vCPU, 512 MiB, *timeout* de 60 s (o stream dura até cerca de 12,5 s no servidor e 45 s no cliente), *ingress* `all` e serviço público sem checagem de IAM do invocador (a API tem a própria autenticação). O portal continua no **Vercel Hobby `iad1`**. Banco e Redis sem mudança (`us-east-1`). A latência medida no S-3 (L1 de 148 ms por perna do Brasil, *spike-metrics* §4.2) sustenta pôr os dois ao lado do `us-east-1`: só a perna do navegador paga a viagem.
- **D2 (o IP do cliente), substitui o segredo de borda:** sem Cloudflare, não há borda que ponha cabeçalho, e no Cloud Run **todo pedido passa pelo GFE** (não há URL própria que pule a plataforma, o que era o T53 do Koyeb). O `X-Trampo-Borda` e o anel `EDGE_AUTH_KEYS` **saem do plano**. Modo novo `API_CLIENT_IP_SOURCE=ultimo-xff`: o IP do cliente é a **última** entrada do `X-Forwarded-For` (a que o Google acrescenta; nunca a primeira, que o cliente escolhe), conferida por `net.isIP`; fora da forma, ou sem o cabeçalho, o balde único do D4 do ADR-014. Esse modo exige `API_BEHIND_PROXY=true` e `TRUST_PROXY=false` (o `request.ip` do Fastify não é usado), e o boot recusa as combinações incoerentes sem ecoar valor. **Só vale depois da sonda:** um pedido com `X-Forwarded-For: <IP de documentação>` forjado tem de chegar com o IP real de quem mede na última posição. Se o GFE repassar o valor do cliente sem acrescentar nada, o modo é recusado e a API fica no balde único (o rate limit por usuário e a cota continuam). O modo `socket` (o de hoje) segue para o desenvolvimento.
- **D3:** sem mudança (o portal sai por IP dinâmico do Vercel, F20; o balde dividido segue aceito na Fase 1).
- **D4 (origens):** `PORTAL_ORIGIN=https://<projeto>.vercel.app` e `API_ORIGIN=https://<serviço>-<número>.us-east4.run.app`; a extensão é construída com o `TRAMPO_API_ORIGIN` da URL `run.app`. A Redirect URL do portal hospedado (`https://<projeto>.vercel.app/auth/retorno`) entra na allow-list exata; o Site URL continua na opção A. O HSTS continua do portal (o `vercel.app` é sufixo público, então o `includeSubDomains` só alcança os subdomínios do próprio projeto); o `preload` sai do plano sem domínio próprio (condição 10 sem objeto).
- **D5 (segredos):** com mais de 6 segredos, o Secret Manager sai do nível gratuito (F19). **Fase 1:** as variáveis do serviço do Cloud Run (lidas por quem tem acesso ao projeto, que só tem o humano, com 2FA); **Fase 2:** o Secret Manager. Os anéis continuam disjuntos (o Vercel nunca recebe um anel da API); `EDGE_AUTH_KEYS` sai da lista; o boot da API continua recusando a `SUPABASE_SECRET_KEY`.
- **D6 (observabilidade):** os logs vão do `stdout` para o Cloud Logging (a retenção a sonda anota). **O resumo de telemetria muda de forma:** sem CPU fora do pedido (F14), a linha `telemetria_resumo` sai **no fim de um pedido** quando passaram 15 min desde a última, nunca por *timer*; uma instância que morre antes perde só o intervalo corrente (a *BACKLOG §F1-OBS-03* muda com isto). Nenhum *keep-alive* artificial.
- **D7 (implantação):** **o `ci.yml` continua sem segredo e sem deploy.** Na Fase 1, o humano constrói a imagem na estação (o `Dockerfile` da S-5b), envia ao Artifact Registry (só as 2 últimas imagens, para caber nos 0,5 GB) e roda o `gcloud run deploy --image` a partir de um commit do `master`, pelo runbook do deploy real. Workload Identity Federation só na Fase 2, por ADR. O Vercel continua com o `master` como produção e os *previews* desligados.
- **D8 (prazos):** a ociosidade do GFE não é documentada: a sonda mede a taxa de 502 com pedidos espaçados, e o `keepAliveTimeout` muda pela medida. O `main.ts` encerra em menos de 10 s no `SIGTERM` (F17), fechando os streams abertos.
- **D9:** os operadores da LGPD (Fase 2) passam a ser o Google Cloud e o Vercel (a Cloudflare sai).

### 8.3 `[APPSEC]` (sem veto; as condições revistas)
- **Saem:** a 1 (o segredo de borda antes de tudo), a 9 (o 429 HTML da Cloudflare) e a 10 (o `preload`, sem domínio próprio). **A 2 muda:** o IP só da **última** entrada do `X-Forwarded-For` no modo `ultimo-xff`, nunca de outra posição, e o modo só é ligado com a sonda provando que o valor forjado pelo cliente fica à esquerda. **A 3 muda:** o boot recusa `ultimo-xff` sem `API_BEHIND_PROXY=true`, `ultimo-xff` com `TRUST_PROXY` diferente de `false`, e qualquer `EDGE_AUTH_KEYS` presente (variável morta não fica no ambiente).
- **Novas:** **15.** o serviço com no máximo 1 instância e o alerta de orçamento ligados antes do deploy real (a sonda confere a configuração); **16.** o resumo de telemetria só no fim de um pedido, com o teste do relógio (nenhum *timer* novo no processo); **17.** o `SIGTERM` encerra em menos de 10 s (teste do `main.ts`); **18.** a CORS e a regex do caminho cru continuam valendo depois da decodificação do GFE (F12): a sonda manda `..`, `%2F` e `//` à rota de feedback pela URL `run.app` e confere o 403 ou 404.
- **T53 revista:** não há mais origem escondida; o risco vira o `X-Forwarded-For` forjado. Mitigação: a última posição e a prova da sonda; sem a prova, o balde único. **T54 revista:** os operadores são o Google Cloud e o Vercel; as variáveis do Cloud Run ficam legíveis a quem tem acesso ao projeto (só o humano), linha nova na §9 até o Secret Manager da Fase 2.

### 8.4 Partição revista
- **S-5a (código):** o modo `ultimo-xff` e o seu boot, a recusa da `SUPABASE_SECRET_KEY` e do `EDGE_AUTH_KEYS`, o encerramento no `SIGTERM` e um proxy reverso local em Node (`test/support`) que acrescenta o `X-Forwarded-For` como o GFE, para os testes de socket real; emendas do ADR-007 D5 e do ADR-014 D10.
- **S-5b (código):** o `Dockerfile` (porta pela `PORT`, `0.0.0.0`), o `.dockerignore`, a varredura da imagem no CI, a imagem da sonda (com o eco da última entrada do `X-Forwarded-For` e do valor inteiro, só os IPs) e o resumo de telemetria no fim do pedido (F1-OBS-03).
- **HITL-047 parte 3 (a sonda):** o roteiro revisto no *hospedagem-s5* §6.
- **HITL seguinte:** o deploy real (Cloud Run e Vercel), a allow-list com o portal, a extensão com a URL `run.app` e o bloco E do *spike-s3*.
