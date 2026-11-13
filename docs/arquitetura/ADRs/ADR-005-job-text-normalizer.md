---
tipo: adr
id: ADR-005
titulo: "JobTextNormalizer: hash por porta, exceção de pureza só para os limites e ordem do pipeline"
status: aceito
aprovacao: "Decisão técnica interna ([ARCHITECT] + [APPSEC]), dentro do ADR-001 aprovado no HITL-001. Não muda contrato público nem o funil."
data: 2026-10-19
decisores: ["[ARCHITECT]", "[APPSEC] (poder de veto)"]
escopo: "F1-DOM-01, parte 1 (apps/api/src/domain/normalization)"
substitui: null
relacionados: ["[ADR-001-hybrid-engine-and-monorepo](ADR-001-hybrid-engine-and-monorepo.md)", "[threat-model](../threat-model.md)", "[revisao-adversarial-M1](../revisao-adversarial-M1.md)", "[contratos-zod](../contratos-zod.md)", "*BACKLOG*"]
---

# ADR-005: `JobTextNormalizer`

## 1. Contexto

O ADR-001 §5.2 define o estágio E1. O §7 e o §10.3 exigem um domínio puro: **só `import type` de `@trampo/contracts`**, sem `node:*` e **sem zod em runtime**. O normalizador, porém, precisa de três **valores**:

- `sha256`, para o `textHash` da chave de cache;
- `truncateCodePoints`, para re-truncar depois do NFKC (revisão M1.6, F-01);
- `JOB_TEXT_MAX_CHARS` (e `JOB_TITLE_MAX_CHARS`, por causa do `titleHint`, F-05).

Este ADR decide como esses valores entram no domínio e fixa a ordem exata do pipeline.

## 2. Decisões

### D1. `sha256` entra por uma porta `TextHasher` injetada

- **Porta** em `domain/ports/text-hasher.ts`: `sha256Hex(text: string): string`.
- **Adapter** em `infrastructure/crypto/node-text-hasher.ts`, usando `node:crypto` (`createHash('sha256')` sobre UTF-8). Ele é provado com os vetores oficiais do NIST (FIPS 180-2: `""`, `"abc"`, a mensagem de 448 bits e 1.000.000 × `"a"`).
- **O domínio desconfia da porta:** se a saída não casar com `^[a-f0-9]{64}$`, ele lança um erro (falha fechado). Uma chave de cache malformada nunca chega ao Redis (SR-08).
- **Alternativa rejeitada:** escrever um sha256 em TypeScript puro. **Veto do `[APPSEC]`**, por ser criptografia artesanal. Um bug que gere colisão vira envenenamento de cache entre vagas diferentes ([threat-model §T11](../threat-model.md#t11)). O `node:crypto` usa o OpenSSL, auditado e já presente no runtime. O custo da porta é uma linha na composição, e esse é o mesmo padrão de `Clock` e `IdGenerator`.

### D2. Exceção estreita de pureza só para `@trampo/contracts/limits`

- O domínio **pode importar valores** de `@trampo/contracts/limits`, e **só** desse subpath.
- **Por quê:** `limits.ts` não importa nada; são apenas constantes numéricas. O teto de 15.000 é um **invariante de segurança** (SR-09) e não deve ser configurável por injeção. Fixar no próprio domínio a mesma constante da borda e da extensão elimina a deriva.
- **Como a exceção se mantém estreita:**
  1. Negação `!@trampo/contracts/limits` no grupo do ESLint (`domain-purity`).
  2. `pathNot` com `limits` na regra `domain-contracts-type-only` do depcruise.
  3. **Regra nova `contracts-limits-leaf`:** `packages/contracts/src/limits.ts` não pode importar **nada**. Se um dia alguém puser `zod` ali, a exceção deixa de ser segura, e o depcruise quebra.
- **Teste:** um negativo no pacote real. O valor de `limits` passa; o valor de `primitives` e o import de qualquer coisa dentro de `limits.ts` falham (resultados no *SESSION-LOG*).

### D3. `truncateCodePoints` entra por injeção (exceção para `primitives` **vetada**)

- **Veto do `[APPSEC]`:** `primitives.ts` importa `zod`. Abrir uma exceção para esse subpath carregaria o zod em runtime no domínio, o que o ADR-001 §10.3 proíbe.
- **Decisão:** a função é injetada (`JobTextNormalizerDeps.truncateCodePoints`), com o tipo vindo de `import type { truncateCodePoints }`. A composição passa a função **do contrato**, a mesma da borda e da extensão. Assim não há cópia, e a unidade (code points) é a mesma.
- **O domínio desconfia da função injetada:** se ela devolver mais do que `max` code points, o normalizador lança um erro (falha fechado). Uma composição errada não consegue furar o SR-09.
- **Alternativa adiada:** mover `truncateCodePoints` para um módulo sem zod nos contratos. Isso mudaria a superfície pública do pacote e a §4 do [contratos-zod](../contratos-zod.md) por um ganho pequeno.
- **O mesmo vale para `INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE`** (decidido na execução, porque a regex também mora em `primitives.ts`). O domínio guarda uma **cópia** do conjunto, com escapes explícitos, em `domain/normalization/invisible-characters.ts`. Um **teste exaustivo** compara os dois conjuntos em todos os code points de U+0000 a U+10FFFF: se o contrato mudar, o teste quebra. Se o mesmo padrão aparecer pela terceira vez, a alternativa adiada (um módulo de texto sem zod nos contratos) volta à mesa.

### D4. Ordem do pipeline

O pipeline roda **uma vez** sobre a entrada `toWellFormed()`. Depois, um **passo** (itens 2 a 9) **repete até o ponto fixo**, com no máximo 4 passadas.

| # | Etapa | Ameaça mitigada e porquê da posição |
|---|---|---|
| 1 | `toWellFormed()` (fora do laço) | **T2 e T15:** surrogates órfãos viram U+FFFD **antes** de qualquer remoção. Assim, metades soltas separadas por um zero-width não se recombinam num Tag character depois da remoção (ASCII smuggling). |
| 2 | NFKC | **T15:** desfaz homóglifos de compatibilidade ("ＰＨＰ" → "PHP") e leva `＜`/`﹤` a `<`, que a etapa 8 neutraliza. Vem antes da remoção, porque o NFKC pode **produzir** caracteres da lista (U+3164 e U+FFA0 → U+1160). |
| 3 | Fins de linha canônicos (`\r\n`, `\r`, VT, FF, NEL, U+2028 e U+2029 → `\n`; TAB → espaço) | Esses caracteres estão na lista de controle. Se fossem removidos sem conversão, "a\rb" e "React\tNode" grudariam palavras. U+2028 também é fim de linha para o `^` do JavaScript: sem a conversão, `system:` em início de "linha" escaparia da etapa 8. |
| 4 | Remoção de `INVISIBLE_OR_CONTROL_EXCEPT_NEWLINE` (mesmo conjunto do contrato) | **T2 e T15:** Tag characters, *variation selectors*, zero-width e bidi. **Conta** os removidos (sinal de injection para o F1-DOM-04). |
| 5 | **Re-truncamento** `truncateCodePoints(…, JOB_TEXT_MAX_CHARS)` | **F-01 e T18:** o NFKC expande até 18× (U+FDFA). Cortar aqui limita todo o trabalho seguinte a 15.000 code points. Vem **depois** da remoção para que caracteres invisíveis não gastem o orçamento do conteúdo visível. |
| 6 | Espaços: colapsa espaços, apara as linhas, no máximo 2 quebras seguidas e `trim` | ADR-001 §5.2, item 3. Deixa o espaçamento canônico para as máscaras e a etapa 8. |
| 7 | Máscaras: URL com esquema → e-mail → `www.`/host com caminho/host nu com TLD de risco → CNPJ (inclusive o **alfanumérico** de 2026) → CPF → telefone BR | **LGPD (T12) e canal de link:** contato e documento não chegam ao LLM. As URLs vêm primeiro porque contêm `@` e dígitos. CNPJ vem antes de CPF porque é mais longo. 11 dígitos crus viram `[documento]` (os dois casos são PII, e mascarar vence rotular). Nomes de pessoas **não** (F-04, resíduo em T12). |
| 8 | Neutralização de delimitadores: todo `<`/`>` vira `‹`/`›`; cercas de 3 ou mais crases ou tis viram `'''`; marcador de papel em início de linha (`system`, `assistant`, `user`, `developer`, `tool`, `human`, `model`, `sistema`, `assistente`, `usuário`) perde o `:` | **T1 e T2 (fechamento do envelope):** o texto não fecha `<<<…>>>`, `</vaga>` nem um bloco de código, e não forja uma troca de papéis. Trocar **todo** `<>` (e não só `<<<`) deixa o normalizador independente do formato de envelope que o F1-LLM-01 escolher. `‹›` são estáveis no NFKC (medido): não voltam a `<>`. |
| 9 | **Guarda final de tamanho:** `truncateCodePoints` mais `trimEnd` | As máscaras e as trocas podem **crescer** o texto ("a@b" → `[email]`). Sem esta guarda, a saída passaria de 15.000 (SR-09). O `trimEnd` remove um espaço que o corte deixe no fim. |
| 10 | `textHash = TextHasher.sha256Hex(text)` (fora do laço) | **T11 e SR-08:** o hash é calculado sobre o texto **final**, já re-truncado e mascarado. Textos iguais dão a mesma chave, e a chave nunca carrega PII. |

- **Por que o ponto fixo cobre o passo inteiro, e não só a remoção (ADR-001 §5.2, item 2):**
  - a remoção pode juntar uma base e uma marca combinante, e só um novo NFKC compõe as duas;
  - o corte da etapa 9 pode criar um padrão novo no fim do texto (ex.: `foo.combate` cortado em `foo.com`).
  
  Repetir o passo inteiro dá **idempotência por construção**: a saída estável é um ponto fixo do passo. Se não estabilizar em 4 passadas, `fixedPointReached = false`, e a Camada 1 trata isso como sinal de injection (rota só determinística, com o aviso `possivel_prompt_injection`). Mesmo assim, a saída já passou por um passo completo: ela continua sem invisíveis e com no máximo 15.000 code points.
- **Sinais devolvidos (consumidos pelo F1-DOM-04, nunca pelo LLM):**
  - `removedInvisibleCount`;
  - `nfkcExpansionRatio` e `suspiciousNfkcExpansion` (razão > 1,5×, só na primeira passada);
  - `truncatedAfterNfkc`;
  - `fixedPointReached` e `passes`;
  - contagem de máscaras por tipo;
  - `neutralizedDelimiterCount`.
- **`titleHint` (F-05):** o mesmo passo, com o teto `JOB_TITLE_MAX_CHARS`, em **linha única** (quebras viram espaço) e sem hash.
- **Fora deste estágio:** a dobra de confundíveis latinos (cirílico e grego) e o sinal de mistura de scripts (T15, mitigações 3 e 4) pertencem ao *matcher* de termos do F1-DOM-04. O texto que vai ao LLM **não** é dobrado, porque dobrar "РНР" em "PHP" no texto mudaria o conteúdo da vaga.

### D5. Versão do normalizador

- `JOB_TEXT_NORMALIZER_VERSION = "n1"`, que é o componente `n1` do `extractorVersion` (`jf-p1-s1-n1-sel1`, ADR-001 §5.4). O teste prova que ele casa com `VersionTagSchema`.
- **Regra:** qualquer mudança que altere a saída para alguma entrada (regex, ordem, token de máscara, teto) **incrementa** a versão. Com isso, o cache antigo é ignorado em vez de servir `JobFacts` calculados sobre outro texto.

## 3. Consequências

- **Positivas:**
  - o domínio continua sem `node:*` e sem zod em runtime, provado por lint e depcruise;
  - o teto de 15.000 é a mesma constante da borda;
  - o SR-09 vale contra uma composição errada;
  - a idempotência é uma propriedade testada, e não uma esperança.
- **Negativas:**
  - a composição precisa ligar duas dependências (`TextHasher` e `truncateCodePoints`);
  - trocar **todo** `<>` muda textos legítimos como "> 5 anos" para "› 5 anos". O F1-DOM-04 precisa lembrar disso;
  - as máscaras têm falso positivo conhecido: um código de 10 ou 11 dígitos pode virar telefone ou documento. A escolha deliberada é errar mascarando.
