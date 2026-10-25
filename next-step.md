# Próximo passo: rodada de aceite do S-1 com `p2` e `g3`

> **Sessão extensa detectada.** Para evitar corte por limite de tokens, encerre esta sessão do terminal (Ctrl+C), abra uma nova e envie este next-step.md.

## O que acabou de ser entregue (2026-10-25)

### Prompt `p2` (commit `22ecc9c`, local, sem push)
- O `p2` está no ADR-020 §7.5. Ele mantém as 6 linhas do `p1` e soma uma regra por campo:
  - benefícios conforme o §5.1 da spec, com a tabela montada de `BENEFIT_PROMPT_TERMS`, exaustiva pelo tipo e por teste;
  - jornada não é contrato;
  - recall de stack;
  - nunca `salario_omitido`;
  - ausência como `[]` e `null`.
- Schema enviado:
  - o enum de `redFlagSignals` saiu sem `salario_omitido` (`maxItems` 6);
  - o contrato não mudou;
  - o hash e o *snapshot* estão fixados.
- Tamanho:
  - o sistema tem 1.199 caracteres a mais que o do `p1`;
  - isso dá 400 tokens a 3 caracteres por token, no teto do §7;
  - **a medição real é nesta rodada**, pelo `usage` do provedor.
- Um teste confere que nenhuma linha dos 83 casos do `gd1` aparece no prompt.
- Emenda registrada: a regra de stack foi escrita pelo lado do desejável ("diferencial, desejável ou plus → `stackNiceToHave`, o resto → `stackRequired`"), com o mesmo alcance.

### Verificação
- 11 testes novos. A API tem 2.659 testes e cobertura de 100%.
- Mutação: 31 mutantes, 30 mortos e 1 equivalente.
- Depcruise sem violações.
- `[APPSEC]` sem veto.
- O turbo inteiro não rodou nesta sessão. Rode `pnpm turbo run typecheck lint test --concurrency=1` no começo da próxima.
- **QA-02:** em cada rodada da suíte inteira, 4 testes de relógio caíram, sempre um conjunto diferente. Isolados, passam. Se um deles aparecer vermelho, rode de novo antes de investigar.

### Pendências do humano
- Nenhuma bloqueante. O push continua não autorizado.
- **A rodada gasta a cota do Groq de um dia inteiro (~180K de 200K tokens).** Comece a sessão com a cota zerada.

## Prompt para enviar ao agente

```text
Equipe, sigam em ciclo estrito.

1. [ORCHESTRATOR]: Leiam STATE.md, spike-metrics §2, ADR-020 §7.5 (p2), ADR-008 §5 (g3), a golden-dataset-spec §8.2 (gate do gd2) e o README do evals/spikes/s1-extraction. Confirmem pnpm 11.4.0, o Node conforme o engines e o branch spike/s1-extraction. Rodem o turbo em série (typecheck, lint e test) antes de gastar cota.
2. [DEV] + [QA_EVALS]: preparem o S-1 para a rodada de aceite:
   - ATENÇÃO: o out/s1-results.jsonl tem as linhas do p1/g2, e o runner retoma de onde parou. Sem separar a saída por versão de prompt e guard (registrar promptVersion e guardVersion em cada linha, ou um arquivo por versão), a rodada pularia todos os itens. Não apaguem os resultados do p1: arquivem para comparar;
   - confiram que o runner usa EXTRACTION_PROMPT_VERSION "p2" e o guard "g3";
   - implementem o avaliador do gate do gd2 (golden-dataset-spec §8.2), se ainda não existir.
3. [QA_EVALS]: rodem o S-1 nos 83 casos, na Workers AI e no Groq (variante nao_estrito, conforme o HITL-028). Meçam:
   - o gate do gd2;
   - os tokens de entrada reais do sistema do p2 contra o p1 (teto de +400);
   - contractTypes, recall de stack, benefits e salario_omitido contra a rodada do p1.
   Se a cota do Groq acabar, parem e registrem onde pararam.
4. [APPSEC]: confiram que nenhuma linha guardada tem texto de vaga nem saída bruta, e que nenhum pedido leva tools (SR-01).
5. [SCRIBE]: atualizem spike-metrics, STATE.md, SESSION-LOG.md e o ADR-020 §7 com o resultado do aceite, façam o commit local e gerem o novo ./next-step.md. Se o gate passar, o próximo é o adapter do Groq (F1-LLM-01 parte 2) com o teto de 3 s do ADR-009 §5. Se não passar, abram um HITL com os números e as opções.
```
