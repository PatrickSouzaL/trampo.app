---
tipo: revisao
id: M1.6
data: 2026-10-18
revisores: ["[APPSEC]", "[ARCHITECT]"]
escopo: "Cruzamento threat model × contratos; limites duplos de payload; isolamento de PII (LGPD)"
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADRs/ADR-001-hybrid-engine-and-monorepo.md)", "[contratos-zod](contratos-zod.md)", "[threat-model](threat-model.md)", "*STATE*"]
---

# Revisão adversarial do Marco 1 (M1.6)

> [!info] Método
> Execução **sequencial**, sem sub-agentes. Leitura integral do [ADR-001-hybrid-engine-and-monorepo](ADRs/ADR-001-hybrid-engine-and-monorepo.md), do [contratos-zod](contratos-zod.md) e do [threat-model](threat-model.md). Cada mitigação do threat model foi confrontada com o schema ou o estágio que a implementa. As suspeitas numéricas foram **medidas** em Node (2026-10-18), não estimadas.

## Veredito

**Aprovado com correções aplicadas.** Uma falha crítica (F-01) furava o limite duplo de payload. Ela e as três falhas médias foram corrigidas nos documentos. O **código** do `contratos-zod` (seção 4, testado 21/21) **não mudou**: todas as correções são de domínio, borda ou fronteira de import.

## Achados

| ID | Severidade | Achado | Prova | Correção |
|---|---|---|---|---|
| F-01 | 🔴 crítica | O corte em 15.000 code points acontece **antes** do NFKC, que expande até 18× (U+FDFA). O domínio processaria até 270.000 code points, o que fura o limite duplo e o SR-09. | Medido: 15.000 × U+FDFA = 45.008 bytes de JSON (passa nos 64 KiB e nos 15.000) e vira 270.000 code points após o NFKC. | ADR §5.2: re-truncamento após o NFKC, expansão > 1,5× vira sinal de injection, ponto fixo com no máximo 4 passadas. T18 itens 5 e 6; SR-09 ampliado. |
| F-01b | 🟠 média | Nada impedia registrar descompressão de requisição. 64 KiB de gzip podem virar centenas de MB. | Análise | ADR §5.1: `Content-Encoding` ≠ `identity` dá 415. SR-07 ampliado. |
| F-02 | 🟠 média | A extensão precisa de `truncateCodePoints` e `JOB_TEXT_MAX_CHARS`, mas só podia importar `api` e `analysis-report`, e esses módulos não os reexportam. Isso levaria a duplicar o limite (deriva). E o import da raiz `.` contornava o bloqueio de `user-criteria`. | Leitura de `api.ts` e da lista de subpaths | Subpaths `./limits` e `./primitives`; raiz proibida na extensão (contratos §2, ADR §10.4, BACKLOG M2.2 e M3). |
| F-03 | 🟠 média (LGPD) | As chaves de rate limit e de cota no Upstash (`quota:req:{user}:…`, limite por IP) guardavam **IP e `sub` em claro** num operador externo. Isso contradizia "nunca IP em claro" (T23). | Leitura do ADR §5.1 | HMAC-SHA256 com *pepper* de servidor nas chaves e na pseudonimização da telemetria. T23 itens 6 e 7; novo **SR-17**. |
| F-04 | 🟠 média (LGPD) | **Nomes de pessoas** (recrutador, "equipe de contratação" do LinkedIn) não são mascarados, mas o D-H4 e o C7 afirmam "PII mascarada" para o Gemini, que treina com os dados. | Leitura do ADR §5.2, item 4 | O extrator exclui blocos de pessoas; o seletor descarta blocos de contato; resíduo declarado em T12; medição no S-2. |
| F-05 | 🟢 baixa | `titleHint` (`z.string().max(200)`, sem `safeText`) não tinha normalização explícita. | Leitura do `api.ts` | ADR §5.2, item 5: passa pelo mesmo normalizador. |
| F-06 | 🟢 baixa | O adapter `cloudflare-workers-ai` faltava na camada `infrastructure/` (ADR §7). | Leitura | Incluído. |

## Verificações que passaram (sem achado)

- **Limite duplo, ordem:** 64 KiB em bytes antes do parse (`bodyLimit`, pelo `Content-Length` e no *streaming*), depois Zod com truncamento. O pior caso legítimo (15.000 × 4 bytes + envelope + `titleHint`) é ~61 KB < 65.536. Correto.
- **`truncatedAtEdge`:** o `toWellFormed` preserva o `length` (medido), então a comparação `text.length < raw.length` é válida.
- **Perfil fora do LLM:** `UserCriteria` não entra no `LlmJobPayload`, não vai ao cache, não é importável pela extensão e não tem `userId` (strict). O feedback é só enum, sem texto livre. `notes` não vai ao LLM nem ao log.
- **URL da página** não trafega; **`ApiError`** sem detalhe interno; **saída do LLM** fechada, com guarda de 8 KB antes do parse.
- **Cache de `JobFacts`** sem dado de usuário, chave versionada, `SET NX` e revalidação na leitura.

## Pendências registradas (não bloqueiam a M2)

- O teste do S-2 mede o vazamento de nomes nas 30 vagas reais (F-04).
- O SR-17 entra na F1-API-03, e o *pepper* (`RATE_KEY_PEPPER`) entra no `.env.example` da API (sem valor).

> 🛡️ **Análise de Segurança (AppSec):** a revisão fechou um *bypass* real do limite duplo por amplificação Unicode (API4:2023, LLM06:2026), fechou a bomba de descompressão, removeu IP e identificador de usuário em claro de um operador externo (LGPD, minimização) e corrigiu a afirmação excessiva de "PII mascarada" antes da decisão D-H4. Nenhum segredo foi lido ou gravado.
