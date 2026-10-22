import { defineConfig, globalIgnores } from "eslint/config";
import { domainPurity, domainPuritySyntax } from "@trampo/config/eslint/domain-purity";
import { security } from "@trampo/config/eslint/security";

// ADR-002 §5.1: no motor da nota, string vinda dos fatos só entra por igualdade exata (Set.has, ===) contra
// lista fechada do usuário. Nenhum método de busca em string ou array e nenhuma regex, nem por referência
// (`const f = s.includes`) nem por chave computada literal (`s["includes"]`). Fixture: test/domain/scoring-lint.test.ts.
const SEARCH_METHODS =
  "includes|startsWith|endsWith|indexOf|lastIndexOf|search|match|matchAll|replace|replaceAll|split|localeCompare|test|exec";
const SCORING_SEARCH_MESSAGE = "Em domain/scoring, compare só por igualdade contra lista fechada (Set.has ou ===), ADR-002 §5.1.";
export const scoringEqualityOnlySyntax = [
  { selector: `MemberExpression[computed=false][property.name=/^(${SEARCH_METHODS})$/]`, message: SCORING_SEARCH_MESSAGE },
  { selector: `MemberExpression[computed=true][property.value=/^(${SEARCH_METHODS})$/]`, message: SCORING_SEARCH_MESSAGE },
  { selector: "Literal[regex]", message: "Sem regex em domain/scoring (ADR-002 §5.1)." },
  { selector: "NewExpression[callee.name='RegExp'], CallExpression[callee.name='RegExp']", message: "Sem RegExp em domain/scoring (ADR-002 §5.1)." },
];

// ADR-012 D7: o ReportComposer não lê texto livre dos fatos (título, cidade, país, tags de stack) nem campo do
// perfil, e não importa UserCriteria. Ele repassa `facts` inteiro, mas nenhum texto do relatório sai desses campos.
// Fixture: test/domain/report-lint.test.ts.
const FREE_TEXT_FIELDS =
  "title|city|countryIso2|stackRequired|stackNiceToHave|notes|minimum|acceptedCities|acceptedUfs|mustHave|niceToHave|dealBreakers";
const REPORT_FREE_TEXT_MESSAGE = "Em domain/report, nenhum texto sai de campo livre dos fatos nem do perfil (ADR-012 D7, SR-11).";
export const reportNoFreeTextSyntax = [
  { selector: `MemberExpression[property.name=/^(${FREE_TEXT_FIELDS})$/]`, message: REPORT_FREE_TEXT_MESSAGE },
  { selector: `MemberExpression[computed=true][property.value=/^(${FREE_TEXT_FIELDS})$/]`, message: REPORT_FREE_TEXT_MESSAGE },
  { selector: `Property[key.name=/^(${FREE_TEXT_FIELDS})$/], Property[key.value=/^(${FREE_TEXT_FIELDS})$/]`, message: REPORT_FREE_TEXT_MESSAGE },
  { selector: "ImportSpecifier[imported.name=/^UserCriteria/]", message: "O ReportComposer não recebe os critérios do usuário (ADR-012 D1, SR-11)." },
];

// O preset de pureza vem depois do de segurança: em src/domain ele acrescenta as proibições de rede,
// relógio, aleatoriedade e imports de runtime (ADR-001 §7 e §10.3; SR-13).
export default defineConfig([
  globalIgnores(["dist/**", "coverage/**"]),
  ...security,
  ...domainPurity({ files: ["src/domain/**/*.ts"] }),
  {
    name: "@trampo/api/scoring-equality-only",
    files: ["src/domain/scoring/**/*.ts"],
    rules: {
      // O motor não tem logger (ADR-002 §5.4): os critérios do usuário nunca vão para log.
      "no-console": "error",
      "no-restricted-syntax": ["error", ...domainPuritySyntax, ...scoringEqualityOnlySyntax],
    },
  },
  {
    name: "@trampo/api/report-no-free-text",
    files: ["src/domain/report/**/*.ts"],
    rules: {
      "no-console": "error",
      "no-restricted-syntax": ["error", ...domainPuritySyntax, ...scoringEqualityOnlySyntax, ...reportNoFreeTextSyntax],
    },
  },
  {
    // Os testes do normalizador carregam payloads de ataque de propósito ('javascript:alert(1)'), para
    // provar que viram [link]. Exceção restrita a esta regra e a test/; src/ continua com ela em error.
    name: "@trampo/api/test-payloads",
    files: ["test/**/*.ts"],
    rules: { "no-script-url": "off" },
  },
]);
