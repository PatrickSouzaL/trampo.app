import { defineConfig, globalIgnores } from "eslint/config";
import { htmlSinkSelectors, security } from "@trampo/config/eslint/security";

// A extensão só vê os subpaths de contrato que não carregam perfil do usuário
// (contratos-zod §2; revisão M1.6, F-02). A raiz reexporta user-criteria e contornaria o bloqueio.
const CONTRACTS_ALLOWED = "limits|primitives|api|analysis-report";
// O subpath de auth só entra no código do Service Worker que fala com o BFF (src/auth e src/api) e nos
// testes: o painel e o extrator nunca veem os contratos da sessão (ADR-004 D10 B3).
const CONTRACTS_ALLOWED_IN_WORKER_AUTH = `${CONTRACTS_ALLOWED}|auth`;
const WORKER_AUTH_FILES = ["src/auth/**/*.ts", "src/api/**/*.ts", "test/**/*.ts"];

function boundaryImports(allowed, extraPatterns = []) {
  return [
    "error",
    {
      patterns: [
        ...extraPatterns,
        {
          regex: `^@trampo/contracts(?!/(${allowed})$)`,
          message: `Este arquivo só importa @trampo/contracts/{${allowed.replaceAll("|", ",")}}: nunca a raiz nem user-criteria (F-02), e auth só em src/auth e src/api (ADR-004 D10).`,
        },
        {
          // Os aliases do WXT (@/, ~/, @@/, ~~/) não são resolvidos pelo dependency-cruiser:
          // o import vira ponto cego das fronteiras (not-to-unresolvable falha fechado).
          regex: "^(@@?|~~?)(/|$)",
          message: "Use import relativo: o dependency-cruiser não resolve os aliases do WXT.",
        },
      ],
    },
  ];
}

// Armazenamento só em storage.session (ADR-001 §5.0.1; threat-model T22).
const NON_SESSION_AREAS = "local|sync|managed";
const SET_ACCESS_LEVEL = "setAccessLevel";
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
  // `setAccessLevel` em qualquer forma de acesso e em qualquer profundidade (F1-EXT-07, E-01): o nome, o acesso computado
  // por string ou por template e a desestruturação, com ou sem outro nome. Montar o nome em tempo de execução
  // (`"set" + "AccessLevel"`) e o alias de `storage` ficam fora do alcance do lint: residual coberto pelo E2E
  // (auth-negative, item 7) e pelo marcador no artefato (manifest.test.ts).
  ...[
    `MemberExpression[property.name="${SET_ACCESS_LEVEL}"]`,
    `MemberExpression[property.value="${SET_ACCESS_LEVEL}"]`,
    `MemberExpression > TemplateLiteral > TemplateElement[value.cooked="${SET_ACCESS_LEVEL}"]`,
    `ObjectPattern > Property[key.name="${SET_ACCESS_LEVEL}"]`,
    `ObjectPattern > Property[key.value="${SET_ACCESS_LEVEL}"]`,
  ].map((selector) => ({
    selector,
    message: "setAccessLevel é proibido: storage.session fica restrito a contextos confiáveis (T22).",
  })),
];

// Lint por módulo do Service Worker (ADR-004 D10 B2), em todo o src/. Cada capacidade sensível mora num arquivo só:
// o `fetch` em src/api/api-client.ts (origem, caminhos e Bearer fixos), o `browser.identity` no adapter do login,
// o `storage.onChanged` em src/auth, o `executeScript` na captura e o `tabs.create` no background.ts. As regras
// `no-restricted-*` não se acumulam entre configs: cada bloco abaixo repete a lista inteira, com a sua exceção.
const API_CLIENT_FILE = "src/api/api-client.ts";
const IDENTITY_FILE = "src/auth/web-auth-flow-source.ts";
const CAPTURE_FILE = "src/capture/capture.ts";
const BACKGROUND_FILE = "src/entrypoints/background.ts";
const EGRESS = "Canal de rede proibido na extensão: tudo sai pelo api-client (ADR-004 D10 B2).";
const NO_SIDE_CHANNEL = "Canal proibido em toda a extensão: o único canal é a porta do painel (ADR-004 D10 B2; SR-10).";
const FORBIDDEN_GLOBALS = [
  ...["XMLHttpRequest", "WebSocket", "EventSource"].map((name) => ({ name, message: EGRESS })),
  ...["BroadcastChannel", "MessageChannel", "clients"].map((name) => ({ name, message: NO_SIDE_CHANNEL })),
];
// Por propriedade, para pegar também `self.X`, `globalThis["X"]` e a desestruturação, que a regra de globais não vê.
const FORBIDDEN_PROPERTIES = [
  { property: "sendBeacon", message: EGRESS },
  // Segunda barreira do E-01, só em src/: pega `x.setAccessLevel`, `x["setAccessLevel"]` e a desestruturação.
  { property: SET_ACCESS_LEVEL, message: "setAccessLevel é proibido: storage.session fica restrito a contextos confiáveis (T22)." },
  ...[
    "onMessageExternal",
    "onConnectExternal",
    "sendMessage",
    "BroadcastChannel",
    "MessageChannel",
    "clients",
    "serviceWorker",
    "registerContentScripts",
    "insertCSS",
  ].map((property) => ({ property, message: NO_SIDE_CHANNEL })),
];
const FETCH_ONLY_IN_CLIENT = "fetch só em src/api/api-client.ts, que fixa a origem, os caminhos e o Bearer (ADR-004 D10 B2).";
const SCOPED_PROPERTIES = {
  fetch: FETCH_ONLY_IN_CLIENT,
  identity: "browser.identity só em src/auth/web-auth-flow-source.ts, o adapter do login (ADR-004 D3 e D10 B2).",
  // Pega storage.onChanged e storage.session.onChanged: a mudança da sessão só é ouvida em src/auth.
  onChanged: "storage.onChanged só em src/auth: quem ouve a mudança da sessão vê o token (ADR-004 D10 B2).",
  executeScript: "executeScript só em src/capture/capture.ts, com o extrator e os args travados (ADR-004 D10 B2 e B7).",
};
/** `allow` lista as propriedades de SCOPED_PROPERTIES liberadas no arquivo. */
const workerRules = (...allow) => ({
  "no-restricted-globals": ["error", ...FORBIDDEN_GLOBALS, ...(allow.includes("fetch") ? [] : [{ name: "fetch", message: FETCH_ONLY_IN_CLIENT }])],
  "no-restricted-properties": [
    "error",
    ...FORBIDDEN_PROPERTIES,
    ...Object.entries(SCOPED_PROPERTIES)
      .filter(([property]) => !allow.includes(property))
      .map(([property, message]) => ({ property, message })),
  ],
});
// `tabs.create` e `tabs.connect` precisam do objeto (`runtime.connect` é o canal do painel), e a regra de
// propriedades só casa objeto que seja identificador: vão como seletores. A opção `files:` injetaria um arquivo
// inteiro na página, fora do extrator travado.
const tabsSelectors = (method, message) => [
  { selector: `MemberExpression[object.property.name="tabs"][property.name="${method}"]`, message },
  { selector: `MemberExpression[object.name="tabs"][property.name="${method}"]`, message },
  { selector: `VariableDeclarator[init.property.name="tabs"] > ObjectPattern > Property[key.name="${method}"]`, message },
];
const workerSelectors = (allowTabsCreate) => [
  ...tabsSelectors("connect", NO_SIDE_CHANNEL),
  ...(allowTabsCreate ? [] : tabsSelectors("create", "tabs.create só no background.ts (ADR-004 D10 B2).")),
  {
    selector: `CallExpression[callee.property.name="executeScript"] Property[key.name="files"]`,
    message: "A opção files: do executeScript é proibida: só o extrator autocontido roda na página (ADR-004 D10 B2).",
  },
];

// Lint do painel (ADR-004 D10 B1). O painel é página da extensão e CONSEGUE ler storage.session: o navegador não
// impõe o "só o Service Worker". A barreira é de código (este bloco e o depcruise B3), de build (o grep B5) e de rede
// (a meta CSP B4). O painel só fala pela porta (runtime.connect) e só vê a SessaoView, nunca token nem storage.
const PANEL_FILES = ["src/entrypoints/sidepanel/**/*.{ts,tsx}", "src/panel/**/*.{ts,tsx}"];
const PANEL_NO_STORAGE = "O painel nunca lê armazenamento: sessão e consentimento chegam só pela porta (ADR-004 D10 B1 e B6).";
const PANEL_NO_NAVIGATION = "O painel não navega, não abre janela nem aba e não tem canal fora da porta (ADR-004 D10 B1).";
const PANEL_NO_WORKER_MODULES = "O painel nunca importa src/auth, src/api nem o session-store: só a SessaoView, pela porta (ADR-004 D10 B1 e B3).";
const PANEL_STORAGE = ["indexedDB", "caches", "localStorage", "sessionStorage"];
const PANEL_NAVIGATION = ["location", "RTCPeerConnection", "webkitRTCPeerConnection"];
const panelRules = () => {
  const worker = workerRules();
  return {
    // Só importação relativa (os aliases já são proibidos): um segmento auth ou api, ou o session-store. O subpath
    // @trampo/contracts/api segue liberado, e o /auth já cai na regra dos contratos.
    "no-restricted-imports": boundaryImports(CONTRACTS_ALLOWED, [
      { regex: "^(\\.\\.?/)+([^/]+/)*(auth|api)(/|$)", message: PANEL_NO_WORKER_MODULES },
      { regex: "^(\\.\\.?/)+([^/]+/)*messaging/session-store(\\.[cm]?[jt]sx?)?$", message: PANEL_NO_WORKER_MODULES },
    ]),
    "no-restricted-globals": [
      ...worker["no-restricted-globals"],
      ...PANEL_STORAGE.map((name) => ({ name, message: PANEL_NO_STORAGE })),
      ...[...PANEL_NAVIGATION, "open"].map((name) => ({ name, message: PANEL_NO_NAVIGATION })),
    ],
    "no-restricted-properties": [
      ...worker["no-restricted-properties"],
      // `storage` pega browser.storage, chrome.storage, o acesso computado e a desestruturação, em qualquer área.
      ...["storage", ...PANEL_STORAGE].map((property) => ({ property, message: PANEL_NO_STORAGE })),
      ...["tabs", "setUninstallURL", "submit", "requestSubmit", ...PANEL_NAVIGATION].map((property) => ({ property, message: PANEL_NO_NAVIGATION })),
      ...["window", "self", "globalThis", "document"].map((object) => ({ object, property: "open", message: PANEL_NO_NAVIGATION })),
    ],
  };
};
const panelSelectors = [
  {
    selector: "ImportExpression",
    message: "O painel não carrega módulo em tempo de execução: o import() dinâmico escaparia do no-restricted-imports (ADR-004 D10 B1).",
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
      "no-restricted-imports": boundaryImports(CONTRACTS_ALLOWED),
      // A regra não se acumula entre configs: os seletores de HTML do preset são repetidos aqui.
      "no-restricted-syntax": ["error", ...htmlSinkSelectors, ...storageSelectors, ...noLinkSelectors],
    },
  },
  {
    name: "@trampo/extension/worker-modules",
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      ...workerRules(),
      "no-restricted-syntax": ["error", ...htmlSinkSelectors, ...storageSelectors, ...noLinkSelectors, ...workerSelectors(false)],
    },
  },
  {
    name: "@trampo/extension/panel",
    files: PANEL_FILES,
    rules: {
      ...panelRules(),
      "no-restricted-syntax": ["error", ...htmlSinkSelectors, ...storageSelectors, ...noLinkSelectors, ...workerSelectors(false), ...panelSelectors],
    },
  },
  {
    name: "@trampo/extension/worker-modules-auth",
    files: ["src/auth/**/*.ts"],
    rules: workerRules("onChanged"),
  },
  {
    name: "@trampo/extension/worker-modules-identity",
    files: [IDENTITY_FILE],
    rules: workerRules("onChanged", "identity"),
  },
  {
    name: "@trampo/extension/worker-modules-api-client",
    files: [API_CLIENT_FILE],
    rules: workerRules("fetch"),
  },
  {
    name: "@trampo/extension/worker-modules-capture",
    files: [CAPTURE_FILE],
    rules: workerRules("executeScript"),
  },
  {
    name: "@trampo/extension/worker-modules-background",
    files: [BACKGROUND_FILE],
    rules: {
      "no-restricted-syntax": ["error", ...htmlSinkSelectors, ...storageSelectors, ...noLinkSelectors, ...workerSelectors(true)],
    },
  },
  {
    name: "@trampo/extension/worker-auth",
    files: WORKER_AUTH_FILES,
    rules: {
      "no-restricted-imports": boundaryImports(CONTRACTS_ALLOWED_IN_WORKER_AUTH),
    },
  },
  {
    name: "@trampo/extension/extraction",
    files: ["src/extraction/**/*.ts"],
    rules: {
      "no-restricted-syntax": ["error", ...htmlSinkSelectors, ...storageSelectors, ...extractionSelectors, ...workerSelectors(false)],
    },
  },
]);
