# Próximo passo: implementar o prompt `p2` (S-1, depois do `g3`)

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (2026-10-25)

### Desenho aceito, sem veto do `[APPSEC]`
- **`g3`** (ADR-008 §5, emenda ao D5), com 10 critérios de aceite:
  - a string fora do enum sai do array, com comparação exata e sem virar outro valor;
  - `null` num campo de array vira `[]`;
  - `location` com exatamente as três chaves nulas vira `null`;
  - tudo contado no `sanitization` e fora do `injectionSignal`.
  - **Achado:** no `g2`, a chave extra dentro de uma `location` esvaziada sumia sem o Zod ver. O `g3` exige as três chaves exatas.
- **`p2`** (ADR-020 §7, emenda ao D1, só desenho):
  - mapeamento de benefícios do §5.1 da spec;
  - "tempo integral" e "full-time" são jornada, não contrato;
  - recall de stack (requisitos, responsabilidades e diferenciais);
  - nunca `salario_omitido`, que sai também do schema enviado ao modelo (o contrato não muda);
  - `[]` e `null` corretos;
  - nenhum exemplo do `gd1` no prompt, e o sistema cresce no máximo 400 tokens.
- **Teto por provedor** (ADR-009 §5, emenda ao D4, só desenho): `Record<LlmProviderId, number>` no `ROUTER_POLICY`, com Groq em 3 s e os demais em 10 s. Entra com o adapter do Groq.

### `g3` implementado (commit `742ecab`, local, sem push)
- 39 testes novos, com 3 propriedades novas (subsequência, contagem exata e o sinal igual à fórmula).
- API com 2.648 testes e 100%; mutação com 33 mutantes, 30 mortos e 3 equivalentes; depcruise sem violações; turbo 19/19 em série.
- **QA-02 (novo, no BACKLOG):** os testes de socket com prazo real de 150 a 250 ms (`limits-stack`, `upstash-cache-stack`, `postgrest-*`, `upstash-rest-client`) falham às vezes na suíte inteira com a CPU disputada, também sem o `g3`. Isolados, passam. Se aparecer um desses vermelho, rode de novo antes de investigar.

### Pendências do humano
- Nenhuma bloqueante. O push continua não autorizado.
- O `git stash` no `master` pode ser descartado com `git stash drop`, se não servir mais.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leiam STATE.md, ADR-020 §7 (desenho do p2), ADR-008 §5 (g3), a golden-dataset-spec §5.1, o extraction-prompt.ts e os testes dele. Confirmem pnpm 11.4.0, o Node conforme o engines e o branch spike/s1-extraction.
2. [DEV] + [QA_EVALS]: implementem SÓ o p2, num commit atômico, conforme o ADR-020 §7:
   - EXTRACTION_PROMPT_VERSION = "p2", com as 6 linhas do p1 e uma regra curta por campo (benefícios, contrato, stack, red flags e ausência);
   - a tabela de benefícios montada no código, com um teste que confere que todo valor do BenefitCategorySchema aparece nela;
   - o schema enviado sem salario_omitido em redFlagSignals (snapshot novo) e o hash do p2 fixado;
   - os testes do p1 (nonce, envelope, TOCTOU, recusa de marcador) continuam valendo;
   - medir o tamanho do sistema do p2 contra o p1 (teto de +400 tokens);
   - cobertura de 100% e mutação.
3. [APPSEC]: auditem o p2 (T29 sem rubrica de nota, T1/T2 com o envelope intacto, LGPD sem perfil, nenhum texto do gd1 no prompt, SR-01 sem tools).
4. [SCRIBE]: atualizem STATE.md, SESSION-LOG.md e o ADR-020 §7 com a implementação, façam o commit local e gerem o novo ./next-step.md. O próximo é a rodada de aceite do S-1 com p2 e g3 e o avaliador do gd2, numa sessão própria, com a cota do Groq do dia inteira.
```
