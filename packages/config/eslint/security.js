// Preset ESLint de segurança (threat-model SR-03; ADR-001 §10.3, "Regras de segurança de lint").
// Uso: `export default defineConfig([...outrosPresets, ...security])`. Deve vir por ÚLTIMO, para que
// nenhum preset de framework rebaixe estas regras.
import noUnsanitized from "eslint-plugin-no-unsanitized";
import react from "eslint-plugin-react";
import regexp from "eslint-plugin-regexp";
import tseslint from "typescript-eslint";

// APIs que interpretam string como HTML ou documento. Proibidas por completo, mesmo com valor
// literal (o no-unsanitized só barra o valor dinâmico). Também barra o acesso computado com chave
// montada (el["inner" + "HTML"], el[`inner${x}`]). Risco residual: chave vinda de variável (el[k])
// não é detectável estaticamente; a defesa em runtime é CSP/Trusted Types (fora do escopo do lint).
const HTML_SINKS = "innerHTML|outerHTML|insertAdjacentHTML|srcdoc|createContextualFragment";
const DOC_WRITE = "write|writeln";

/**
 * Seletores de `no-restricted-syntax`. Exportados porque essa regra NÃO se acumula entre configs: quem
 * precisar acrescentar seletores (ex.: o preset de pureza do domínio) deve reaproveitar esta lista.
 * @type {Array<{ selector: string, message: string }>}
 */
export const htmlSinkSelectors = [
  {
    selector: `MemberExpression[computed=false][property.name=/^(${HTML_SINKS})$/]`,
    message: "API que interpreta HTML é proibida (XSS, AGENTS §1.3). Renderize texto via React.",
  },
  {
    selector: `MemberExpression[computed=true][property.value=/^(${HTML_SINKS})$/]`,
    message: "Acesso computado a API que interpreta HTML é proibido (XSS, AGENTS §1.3).",
  },
  {
    selector: `MemberExpression[computed=true][property.type="TemplateLiteral"]`,
    message: "Chave computada por template literal é proibida: pode montar o nome de um sink de HTML.",
  },
  {
    selector: `MemberExpression[computed=true][property.type="BinaryExpression"][property.operator="+"]`,
    message: "Chave computada por concatenação é proibida: pode montar o nome de um sink de HTML.",
  },
  {
    selector: `MemberExpression[object.name="document"][property.name=/^(${DOC_WRITE})$/]`,
    message: "document.write/writeln é proibido (XSS).",
  },
  {
    selector: `CallExpression[callee.property.name="setAttribute"][arguments.0.value=/^srcdoc$/i]`,
    message: "setAttribute('srcdoc') é proibido (XSS em iframe).",
  },
  {
    selector: `JSXAttribute[name.name=/^(srcDoc|srcdoc)$/]`,
    message: "srcDoc é proibido (XSS em iframe).",
  },
];

/** @type {import("eslint").Linter.Config[]} */
export const security = [
  {
    name: "@trampo/config/security",
    plugins: {
      "no-unsanitized": noUnsanitized,
      react,
      regexp,
    },
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
      "no-restricted-syntax": ["error", ...htmlSinkSelectors],

      "no-unsanitized/method": "error",
      "no-unsanitized/property": "error",

      // Fora do preset recomendado do eslint-plugin-react: ligado à mão (ADR-001 §10.2).
      "react/no-danger": "error",
      "react/no-danger-with-children": "error",

      // Anti-ReDoS.
      "regexp/no-super-linear-backtracking": "error",
      "regexp/no-super-linear-move": "error",
    },
  },
  {
    name: "@trampo/config/security/typescript",
    files: ["**/*.{ts,tsx,mts,cts}"],
    // Parser explícito: apps sem eslint-config-next (api, extensão) também precisam ler TS.
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      // Zero `any` (AGENTS §1.4). Sem fixToUnknown automático: a correção é decidir o tipo.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
];

export default security;
