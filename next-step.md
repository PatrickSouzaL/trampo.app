# Próximo passo: F1-API-00 (esqueleto de `apps/api`)

## O que acabou de ser entregue (F1-EXT-02, 2026-10-19)
- **Mensageria da extensão (SR-10):** uma porta única, `trampo/sidepanel/v1`. O Service Worker só aceita a própria página do painel, conferindo o nome da porta, o id e a origem e o caminho do remetente. Content scripts e páginas web que imitam o caminho são recusados.
- **Contrato interno:** Zod estrito nos dois sentidos. Mensagem inválida derruba a porta. Não existe canal avulso nem externo.
- **Armazenamento (T22):** só `storage.session`, revalidado na leitura. O lint barra `local`, `sync`, `managed` e `setAccessLevel`.
- **Testes:** 28 de unidade novos (a extensão tem 38) e 5 e2e no Edge real, inclusive o handshake verdadeiro do painel (e2e total de 10). A mutação na checagem de origem derruba 4 testes.
- **Achado:** o alias `@/` do WXT ficava invisível ao dependency-cruiser e foi pego pelo `not-to-unresolvable` (fail closed). Agora a extensão usa imports relativos, e o lint proíbe os aliases.
- **HITL-013 fechado:** Chrome 155.0.8059.85.
- **F1-LLM-02 ajustada ao HITL-012:** o adapter do Gemini fica adiado para a Fase 2.
- Branch `feat/monorepo-workspace`, só local (sem push).

## Ação manual (HITL) antes do próximo comando
- Nenhuma ação manual obrigatória.
- Em background: HITL-003 (30 vagas), com o guia na HITL-QUEUE.

## Prompt para enviar ao agente

```text
Equipe, vamos executar a F1-API-00. Atuem de forma estritamente SEQUENCIAL E ATÔMICA. Proibido instanciar sub-agentes paralelos.

[Opcional] HITL-003: [concluído: N vagas / ainda não].

1. [ORCHESTRATOR]: Leia STATE.md, BACKLOG.md (F1-API-00 e F1-API-01), HITL-QUEUE.md e o ADR-001 (§5.1 borda, §7 camadas, §10.2 Fastify e §10.4 pacotes). Confirme pnpm 11.4.0, Node ≥ 24 e o branch limpo.
2. [APPSEC]: Antes do `pnpm install`, audite as dependências novas (fastify 5, @fastify/type-provider-zod e o que mais o esqueleto exigir): idade, proveniência, scripts e mantenedor. Fixe no `catalog:` com versão exata. NÃO abra exceção de minimumReleaseAge, trustPolicy ou allowBuilds sem a análise registrada.
3. [DEV]: Execute somente a F1-API-00 do BACKLOG:
   - crie `apps/api` (`@trampo/api`): Fastify 5 com `@fastify/type-provider-zod`, inclusive o serializer compiler (a resposta é validada na saída); ESM compilado com `tsc` para `dist/`, rodando JS compilado;
   - estenda o `@trampo/config` (tsconfig strict, preset de segurança e o preset `domainPurity()` em `src/domain/**`);
   - crie as camadas da §7 (`src/{domain,application,infrastructure,presentation}`), só com o esqueleto: nenhuma regra de negócio;
   - um mapeador de erro que sempre responde `ApiErrorSchema` (sem stack trace, sem detalhes do Zod, sem nomes internos) e a rota `GET /health`;
   - um `.env.example` com os NOMES das variáveis (sem valores; `GEMINI_API_KEY` NÃO entra, conforme o HITL-012);
   - os limites da borda (bodyLimit, timeouts, CORS) são a F1-API-01: NÃO execute agora, a não ser o que o Fastify exigir para subir.
4. [QA_EVALS]: Valide:
   - testes com `fastify.inject`: o `/health` responde e passa pelo serializer; uma rota inexistente e um erro forçado respondem no formato `ApiError` sem vazar detalhes;
   - um teste negativo do preset de pureza num arquivo temporário em `src/domain` (import de `node:fs`, `Date.now` e `fetch`) FALHA no lint e no depcruise e depois é removido;
   - `pnpm install --frozen-lockfile` limpo; `pnpm turbo run build typecheck lint test` verde; `pnpm lint:deps` verde; `test:e2e` da extensão verde;
   - o `node dist/...` sobe e responde ao `/health`, e depois é encerrado.
5. [SCRIBE]: Marque a F1-API-00 como [x] no STATE.md (checkpoint imediato), registre no SESSION-LOG, faça o commit local no feat/monorepo-workspace (push NÃO autorizado) e gere o novo ./next-step.md.

Pare a execução e aguarde minha aprovação após o passo 5.
```
