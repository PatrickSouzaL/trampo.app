// Fronteiras de import do monorepo (ADR-001 §10.3; threat-model SR-13). Caminhos relativos à raiz.
// Consumido por /.dependency-cruiser.cjs via `extends`. Vale mesmo para apps que ainda não existem:
// a regra entra em vigor quando o primeiro arquivo do app aparecer.

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    // Fail closed: import que não resolve pode ser um alias contornando as regras abaixo.
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "Import não resolvido: as fronteiras não podem ser verificadas.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "clients-not-to-api",
      severity: "error",
      comment: "Extensão e portal falam com a API só por HTTP, nunca por import.",
      from: { path: "^apps/(extension|web-portal)/" },
      to: { path: "^apps/api/" },
    },
    {
      name: "no-cross-app-internals",
      severity: "error",
      comment: "Nenhum app importa os internos de outro app.",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/", pathNot: "^apps/$1/" },
    },
    {
      name: "packages-not-to-apps",
      severity: "error",
      comment: "Pacotes compartilhados não dependem de apps.",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "evals-only-api-evals-subpath",
      severity: "error",
      comment: "evals só usa @trampo/api pelo subpath ./evals.",
      from: { path: "^evals/" },
      to: { path: "^apps/", pathNot: "^apps/api/(src|dist)/evals(/|\\.)" },
    },
    {
      name: "extension-no-user-criteria",
      severity: "error",
      comment: "A extensão não vê critérios do usuário nem a raiz do pacote, que os reexporta (revisão M1.6, F-02).",
      from: { path: "^apps/extension/" },
      to: { path: "^packages/contracts/(src|dist)/(user-criteria|index)(/|\\.)" },
    },
    {
      name: "ui-kit-presentation-only",
      severity: "error",
      comment: "ui-kit só depende de React e dos contratos.",
      from: { path: "^packages/ui-kit/" },
      to: {
        path: "^(apps|evals|packages)/",
        pathNot: "^packages/(ui-kit|contracts)/",
      },
    },
    {
      name: "contracts-only-zod",
      severity: "error",
      comment: "@trampo/contracts tem dependência única: zod (só o código publicado; os testes usam vitest).",
      from: { path: "^packages/contracts/src/" },
      to: {
        dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg", "npm-unknown", "core"],
        pathNot: "node_modules/zod/",
      },
    },
    {
      name: "domain-pure",
      severity: "error",
      comment: "Domínio puro: só o próprio domínio e tipos de @trampo/contracts.",
      from: { path: "^apps/api/src/domain/" },
      to: { pathNot: "^(apps/api/src/domain/|packages/contracts/)" },
    },
    {
      name: "domain-contracts-type-only",
      severity: "error",
      comment:
        "No domínio, @trampo/contracts só entra como `import type` (zod não roda no domínio). " +
        "Única exceção de valor: limits, que só tem constantes (ADR-005 D2).",
      from: { path: "^apps/api/src/domain/" },
      to: {
        path: "^packages/contracts/",
        pathNot: "^packages/contracts/(src|dist)/limits\\.(ts|js|d\\.ts)$",
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "application-inward-only",
      severity: "error",
      comment: "A aplicação não depende das camadas de fora: infrastructure, presentation e main.ts (ADR-008 D1).",
      from: { path: "^apps/api/src/application/" },
      to: { path: "^apps/api/src/(infrastructure/|presentation/|main\\.ts$)" },
    },
    {
      name: "application-only-zod-and-contracts",
      severity: "error",
      comment: "Na aplicação, os únicos pacotes são zod e @trampo/contracts: sem módulos do Node nem SDKs (ADR-008 D1).",
      from: { path: "^apps/api/src/application/" },
      to: {
        dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg", "npm-unknown", "core"],
        pathNot: "(node_modules/zod/|^packages/contracts/)",
      },
    },
    {
      name: "contracts-limits-leaf",
      severity: "error",
      comment: "limits não importa nada: é o que torna segura a exceção de valor do domínio (ADR-005 D2).",
      from: { path: "^packages/contracts/src/limits\\.ts$" },
      to: {},
    },
  ],
  options: {
    // node_modules entra no grafo (as regras de pacote npm dependem disso), mas não é percorrido.
    doNotFollow: { path: "node_modules" },
    // Ancorado no workspace e SEM dist/: um módulo excluído some do grafo junto com as arestas que
    // chegam nele, e @trampo/contracts resolve para dist/ (a regra da extensão seria contornada).
    exclude: { path: "^(apps|packages|evals)/[^/]+/(\\.next|\\.turbo|\\.output|\\.wxt|coverage)/" },
    // Enxerga `import type` (que o TS apaga) para aplicar as regras de tipo.
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    preserveSymlinks: false,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".d.ts"],
    },
  },
};
