// Preset de pureza do domínio da API (ADR-001 §1.2 e §10.3; threat-model SR-13).
// O domínio (ScoringEngine, DeterministicPreFilter) é TypeScript puro: sem rede, sem I/O, sem relógio
// e sem aleatoriedade. Clock e IdGenerator chegam por injeção.
// Uso em apps/api/eslint.config.js: `...security, ...domainPurity()` (nesta ordem).
import tseslint from "typescript-eslint";

import { htmlSinkSelectors } from "./security.js";

/**
 * Seletores de `no-restricted-syntax` do preset. A regra não se acumula entre blocos: um bloco mais
 * restrito (ex.: `src/domain/scoring` na API) precisa repeti-los antes de acrescentar os seus.
 */
export const domainPuritySyntax = [
  ...htmlSinkSelectors,
  { selector: "ImportExpression", message: "Sem import() dinâmico no domínio." },
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: "new Date() sem argumento lê o relógio: injete um Clock." },
];

/**
 * @param {{ files?: string[] }} [options] globs relativos ao eslint.config do consumidor.
 * @returns {import("eslint").Linter.Config[]}
 */
export function domainPurity({ files = ["src/domain/**/*.{ts,mts,cts}"] } = {}) {
  return [
    {
      name: "@trampo/config/domain-purity",
      files,
      plugins: { "@typescript-eslint": tseslint.plugin },
      rules: {
        "no-restricted-imports": "off",
        "@typescript-eslint/no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                // Contratos só como tipo: zod não roda no domínio. Única exceção de valor: ./limits,
                // que só tem constantes e não importa nada (ADR-005 D2; regra contracts-limits-leaf).
                // Regex, e não `group` com "!": no gitignore a negação não reinclui o filho de um pai excluído.
                regex: "^@trampo/contracts(?!/limits$)(/|$)",
                allowTypeImports: true,
                message: "No domínio, @trampo/contracts só entra como `import type`.",
              },
              {
                // Qualquer especificador não relativo além dos contratos: node:*, builtins sem
                // prefixo, SDKs de LLM, zod, Redis, Fastify...
                regex: "^(?!\\.|@trampo/contracts(/|$))",
                message: "O domínio não importa pacotes nem módulos do Node. Injete uma porta.",
              },
              {
                group: ["**/infrastructure", "**/infrastructure/**", "**/presentation", "**/presentation/**"],
                message: "O domínio não depende de infrastructure/ nem de presentation/.",
              },
            ],
          },
        ],
        "no-restricted-globals": [
          "error",
          { name: "fetch", message: "Sem rede no domínio." },
          { name: "process", message: "Sem ambiente no domínio: receba a configuração por parâmetro." },
          { name: "require", message: "Sem carregamento dinâmico no domínio." },
          { name: "setTimeout", message: "Sem tempo real no domínio: injete um Clock." },
          { name: "setInterval", message: "Sem tempo real no domínio: injete um Clock." },
          { name: "crypto", message: "Sem aleatoriedade no domínio: injete um IdGenerator." },
        ],
        "no-restricted-properties": [
          "error",
          { object: "Date", property: "now", message: "Injete um Clock." },
          { object: "Math", property: "random", message: "Injete um IdGenerator." },
          { object: "globalThis", property: "fetch", message: "Sem rede no domínio." },
          { object: "globalThis", property: "process", message: "Sem ambiente no domínio." },
          { object: "globalThis", property: "crypto", message: "Sem aleatoriedade no domínio." },
        ],
        // A regra não se acumula: os seletores de HTML do preset de segurança são repetidos aqui.
        "no-restricted-syntax": ["error", ...domainPuritySyntax],
      },
    },
  ];
}

export default domainPurity;
