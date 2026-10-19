import { defineConfig, globalIgnores } from "eslint/config";
import { htmlSinkSelectors, security } from "@trampo/config/eslint/security";

// A extensão só vê os subpaths de contrato que não carregam perfil do usuário
// (contratos-zod §2; revisão M1.6, F-02). A raiz reexporta user-criteria e contornaria o bloqueio.
const CONTRACTS_ALLOWED = "limits|primitives|api|analysis-report";

// Armazenamento só em storage.session (ADR-001 §5.0.1; threat-model T22).
const NON_SESSION_AREAS = "local|sync|managed";
const storageSelectors = [
  {
    selector: `MemberExpression[object.property.name="storage"][property.name=/^(${NON_SESSION_AREAS})$/]`,
    message: "Só storage.session: storage.local/sync/managed ficam ao alcance de content scripts ou persistem em disco (T22).",
  },
  {
    selector: `MemberExpression[object.property.name="storage"][computed=true]`,
    message: "Acesso computado a browser.storage é proibido: escolha a área de forma explícita (só session).",
  },
  {
    selector: `VariableDeclarator[init.property.name="storage"] > ObjectPattern > Property[key.name=/^(${NON_SESSION_AREAS})$/]`,
    message: "Só storage.session: storage.local/sync/managed são proibidos (T22).",
  },
  {
    selector: `MemberExpression[property.name="setAccessLevel"]`,
    message: "setAccessLevel é proibido: storage.session fica restrito a contextos confiáveis (T22).",
  },
];

export default defineConfig([
  globalIgnores([".output/**", ".wxt/**"]),
  ...security,
  {
    name: "@trampo/extension/boundaries",
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: `^@trampo/contracts(?!/(${CONTRACTS_ALLOWED})$)`,
              message: `A extensão só importa @trampo/contracts/{${CONTRACTS_ALLOWED.replaceAll("|", ",")}}: nunca a raiz nem user-criteria (F-02).`,
            },
            {
              // Os aliases do WXT (@/, ~/, @@/, ~~/) não são resolvidos pelo dependency-cruiser:
              // o import vira ponto cego das fronteiras (not-to-unresolvable falha fechado).
              regex: "^(@@?|~~?)(/|$)",
              message: "Use import relativo: o dependency-cruiser não resolve os aliases do WXT.",
            },
          ],
        },
      ],
      // A regra não se acumula entre configs: os seletores de HTML do preset são repetidos aqui.
      "no-restricted-syntax": ["error", ...htmlSinkSelectors, ...storageSelectors],
    },
  },
]);
