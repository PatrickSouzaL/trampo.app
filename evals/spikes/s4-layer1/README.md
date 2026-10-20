# S-4: protótipo descartável da Camada 1 (`DeterministicPreFilter`)

Mede, no golden dataset `gd1` (83 casos), o que a Camada 1 resolve sem LLM e com que erro. **Não é código de produção.** A versão de produção é o F1-DOM-04, em `apps/api/src/domain`, e os resultados estão em `base/04-qualidade-evals/spike-metrics.md` §5.

## Rodar

```powershell
pnpm --filter @trampo/evals spike:s4
```

O comando grava `out/s4-metrics.json` e roda duas provas:
- a saída não contém nenhuma linha de vaga com 25 caracteres ou mais, nem canário;
- SR-09: 8 entradas patológicas de 64 KiB, cada uma processada em menos de 200 ms (melhor de 3).

O `typecheck` e o `lint` do pacote já cobrem esta pasta. O `pnpm test` não roda a medição.

## Peças

| Arquivo | O quê |
|---|---|
| `prefilter.ts` | Monta a porta `DeterministicSignals` (ADR-011 D1) sobre o texto do **normalizador real** `n1` |
| `text-tools.ts` | Dobra (minúsculas, sem acento, confundíveis cirílicos e gregos → latim), `findAll` com fronteira e linhas |
| `sections.ts` | Contexto por linha: título de seção, item de lista e diferencial em prosa |
| `tech-dictionary.ts` | ~230 termos com aliases e 13 ambíguos com qualificador. Foi escrito **sem olhar o gabarito**; a §5 do spike-metrics lista os aliases acrescentados depois |
| `stack.ts` | Menções com negação (4 tokens antes, na mesma oração, por idioma), negação depois do termo, contexto e mistura de scripts |
| `sets.ts` | Modelo de trabalho, contrato (PJ só com pista de contratação) e senioridade (explícita só no título) |
| `salary.ts` | Varredura manual, sem regex. `R$` com fronteira à esquerda (`AR$` ≠ `R$`), herança de moeda em faixa e período mais próximo |
| `injection.ts` | Três famílias que se dirigem ao modelo (vocativo, sobreposição e manipulação) no mesmo parágrafo e fora de aspas, mais as classes de invisíveis |
| `routing.ts` | R1 e R3 sobre os sinais e o mesmo julgamento sobre o gabarito (oráculo), com 8 personas fixas |
| `measure.ts` | As métricas e a varredura exaustiva de critérios eliminatórios isolados |

## Limites conhecidos
- **`titleHint`:** vem do `title` do gabarito, no papel do título que o extrator do DOM vai entregar (S-2). Sem ele, a senioridade nunca é explícita.
- **Injection:** as heurísticas foram ajustadas conhecendo os 7 sintéticos. Por isso a detecção é otimista. O número que vale é o falso positivo nos controles e nas 63 vagas reais.
- **Personas:** o painel é sintético. A taxa sem LLM depende de quem usa e de quais vagas a pessoa abre.
