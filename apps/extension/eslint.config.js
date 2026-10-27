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

// O painel não tem link nem recurso externo (ADR-025 D5; AnalysisReport D8): o texto do servidor nunca
// vira navegação, e a CSP não precisa abrir nada além de 'self'.
const NAVIGATING_ELEMENTS = "a|area|base|link|iframe|frame|embed|object|img|image|video|audio|source|track|portal";
const NAVIGATING_ATTRIBUTES = "href|src|srcSet|action|formAction|xlinkHref|poster|data|ping|background|cite";
const noLinkSelectors = [
  {
    selector: `JSXOpeningElement[name.name=/^(${NAVIGATING_ELEMENTS})$/]`,
    message: "O painel não tem links nem recursos externos: renderize texto (ADR-025 D5).",
  },
  {
    selector: `JSXAttribute[name.name=/^(${NAVIGATING_ATTRIBUTES})$/]`,
    message: "Atributo que navega ou carrega recurso é proibido no painel (ADR-025 D5).",
  },
  {
    selector: `JSXAttribute[name.namespace.name="xlink"]`,
    message: "xlink:* é proibido no painel (ADR-025 D5).",
  },
];

// Extrator de DOM só-leitura e autocontido (ADR-023 D3, D5 e D8; threat-model T2).
const EXTRACTION_READS = "innerText|outerText|textContent|getAttribute|getAttributeNS|getAttributeNode|getAttributeNames|attributes|dataset";
const DOM_WRITES =
  "appendChild|append|prepend|insertBefore|removeChild|replaceChild|replaceWith|remove|setAttribute|setAttributeNS|removeAttribute|toggleAttribute|click|focus|dispatchEvent|scrollTo|scrollIntoView";
const FORBIDDEN_IN_EXTRACTOR =
  "atob|btoa|TextDecoder|decodeURI|decodeURIComponent|unescape|eval|Function|fetch|XMLHttpRequest|WebSocket|EventSource|postMessage|chrome|browser|localStorage|sessionStorage|indexedDB";
const extractionSelectors = [
  {
    selector: `MemberExpression[property.name=/^(${EXTRACTION_READS})$/]`,
    message: "O extrator lê só o `data` de nós de texto que passam no descarte: nada de atributo nem de API que ignora a visibilidade (T2).",
  },
  {
    selector: `MemberExpression[property.name=/^(${DOM_WRITES})$/]`,
    message: "O extrator é só-leitura: nunca muda nem aciona a página (ADR-023 D8).",
  },
  {
    selector: `Identifier[name=/^(${FORBIDDEN_IN_EXTRACTOR})$/]`,
    message: "Proibido no extrator: decodificar, executar, falar com a rede ou com a extensão (ADR-023 D5 e D8).",
  },
  {
    selector: `ImportDeclaration[importKind!="type"]`,
    message: "O extrator é serializado pelo executeScript: só `import type`, nada do escopo do módulo em tempo de execução.",
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
      "no-restricted-syntax": ["error", ...htmlSinkSelectors, ...storageSelectors, ...noLinkSelectors],
    },
  },
  {
    name: "@trampo/extension/extraction",
    files: ["src/extraction/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...htmlSinkSelectors, ...storageSelectors, ...extractionSelectors],
    },
  },
]);
