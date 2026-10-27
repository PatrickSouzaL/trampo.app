// Eventos de stream e relatórios de fixture, no formato do contrato público (AnalysisStreamEvent).
// Compartilhados pela unidade e pelo E2E do painel (ADR-025 D6). Os hostis são a forma que um
// servidor comprometido (ou um bug) mandaria: o painel precisa recusá-los inteiros.
import type { AnalysisReport } from "@trampo/contracts/analysis-report";

export const REQUEST_ID = "6f1c2a52-3b7e-4c1d-9a55-0d6b3f4e8a11";

/** Relatório válido. Nomes de tecnologia com ponto ("Node.js", "ASP.NET") não podem virar link. */
export const REPORT: AnalysisReport = {
  schemaVersion: 1,
  analysisId: "0b7d4b1e-5c3a-4f2e-8d6c-1a2b3c4d5e6f",
  requestId: REQUEST_ID,
  createdAt: "2026-10-27T12:00:00.000Z",
  platform: "generico",
  score: 78,
  verdict: "recomendado",
  summary: "Recomendada. Puxou para cima: Tecnologias e Modelo de trabalho. Puxou para baixo: Salário não informado.",
  dealBreakerHit: false,
  strengths: [
    { dimension: "stack", text: "A vaga pede Node.js, TypeScript e ASP.NET." },
    { dimension: "modelo_trabalho", text: "Trabalho remoto, como você aceita." },
  ],
  redFlags: [{ dimension: "red_flags", text: "Sobreaviso sem remuneração citado na vaga." }],
  missingInfo: [{ dimension: "salario", text: "A vaga não informa a faixa salarial." }],
  breakdown: [
    { dimension: "stack", outcome: "atende", importance: "obrigatorio", points: 30, dealBreakerHit: false, explanation: "Tecnologias: atende. Na vaga: Node.js, TypeScript." },
    { dimension: "modelo_trabalho", outcome: "atende", importance: "eliminatorio", points: 25, dealBreakerHit: false, explanation: "Modelo de trabalho: atende. Na vaga: remoto." },
    { dimension: "salario", outcome: "nao_informado", importance: "ponderado", points: 0, dealBreakerHit: false, explanation: "Salário: não informado na vaga." },
    { dimension: "red_flags", outcome: "nao_atende", importance: "ponderado", points: -7, dealBreakerHit: false, explanation: "Sinais de alerta: sobreaviso não remunerado." },
  ],
  warnings: ["texto_truncado", "possivel_prompt_injection"],
  decisionPath: "extracao_llm",
  facts: {
    title: "Pessoa Desenvolvedora Node.js Pleno",
    seniorityLevels: ["pleno"],
    yearsExperienceMin: 3,
    workModels: ["remoto"],
    location: null,
    salary: null,
    contractTypes: ["clt"],
    stackRequired: ["Node.js", "TypeScript", "ASP.NET"],
    stackNiceToHave: [],
    benefits: ["plano_saude"],
    languageRequirements: [],
    redFlagSignals: ["sobreaviso_nao_remunerado"],
  },
  provenance: {
    title: "llm",
    seniorityLevels: "deterministico_e_llm",
    yearsExperienceMin: "llm",
    workModels: "deterministico",
    location: "ausente",
    salary: "ausente",
    contractTypes: "llm",
    stackRequired: "deterministico_e_llm",
    stackNiceToHave: "ausente",
    benefits: "llm",
    languageRequirements: "ausente",
    redFlagSignals: "llm",
  },
  effectiveConfidence: 0.82,
  meta: { engineVersion: "engine-1.0.0", reportCatalogVersion: "rc-1", extractorVersion: "jf-p3-s1", provider: "groq", durationMs: 2400 },
};

export const stage = (s: string, elapsedMs: number) => ({ kind: "stream", event: { type: "stage", stage: s, elapsedMs } });
export const result = (report: unknown) => ({ kind: "stream", event: { type: "result", report } });
export const apiError = (code: string, retryAfterSeconds: number | null = null, message = "Mensagem do servidor que o painel não exibe") => ({
  kind: "stream",
  event: { type: "error", error: { code, message, requestId: REQUEST_ID, retryAfterSeconds } },
});

/** Canário: se aparecer na tela, o painel renderizou algo que devia ter recusado. */
export const HOSTILE_CANARY = "CANARIO-HOSTIL";

/** Relatórios que o contrato recusa: HTML, URL, link markdown, invisível, texto longo, chave extra, link no fato. */
export const HOSTILE_REPORTS: ReadonlyArray<readonly [string, unknown]> = [
  ["HTML no resumo", { ...REPORT, summary: `<img src=x onerror=alert(1)> ${HOSTILE_CANARY}` }],
  ["URL num ponto forte", { ...REPORT, strengths: [{ dimension: "stack", text: `Candidate-se em https://evil.example/ ${HOSTILE_CANARY}` }] }],
  ["link markdown numa red flag", { ...REPORT, redFlags: [{ dimension: "red_flags", text: `[clique](evil) ${HOSTILE_CANARY}` }] }],
  ["domínio nu na explicação", { ...REPORT, breakdown: [{ ...REPORT.breakdown[0]!, explanation: `Veja vagas.top ${HOSTILE_CANARY}` }] }],
  ["e-mail no resumo", { ...REPORT, summary: `Mande o CV para rh@evil.com ${HOSTILE_CANARY}` }],
  ["Unicode Tag escondido", { ...REPORT, summary: `Recomendada.\u{E0049}\u{E0047} ${HOSTILE_CANARY}` }],
  ["resumo acima de 200 caracteres", { ...REPORT, summary: `${HOSTILE_CANARY} ${"a".repeat(200)}` }],
  ["chave extra no relatório", { ...REPORT, html: `<b>${HOSTILE_CANARY}</b>` }],
  ["URL no título do fato", { ...REPORT, facts: { ...REPORT.facts, title: `javascript:alert(1) ${HOSTILE_CANARY}` } }],
  ["nota fora da faixa", { ...REPORT, score: 101, summary: `${HOSTILE_CANARY} nota inflada.` }],
];
