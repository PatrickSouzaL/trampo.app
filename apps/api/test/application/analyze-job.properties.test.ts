// F1-API-04 (ADR-017 §3, SR-11 e SR-12): para qualquer perfil válido, em qualquer caminho do funil, o AnalyzeJob
// entrega um relatório que passa no AnalysisReportSchema, não ecoa texto livre do perfil, não manda nada do
// perfil ao LLM e grava telemetria válida. Motor, composer, resolver e Camada 1 reais.
import { AnalysisReportSchema, type UserCriteria } from "@trampo/contracts";
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { TelemetryEventSchema } from "../../src/application/index.js";
import { criteriaArb } from "../domain/fakes/scoring-fixtures.js";
import { CLEAN_RAW, CLEAN_TEXT, INJECTION_TEXT, JobHarness, PRESENTIAL_TEXT, request } from "./fakes/analyze-job-harness.js";

/** Texto livre do perfil que nunca aparece nas vagas abaixo: notas, cidades e a pretensão salarial. */
const NOTE_CANARY = "nota-canaria-do-perfil-7731";
const CITY_CANARY = "Cidadecanaria";
const SALARY_CANARY = 31_337;

function withCanaries(criteria: UserCriteria): UserCriteria {
  return {
    ...criteria,
    notes: NOTE_CANARY,
    salary: criteria.salary === null ? null : { ...criteria.salary, minimum: SALARY_CANARY },
    location: criteria.location === null ? null : { ...criteria.location, acceptedCities: [CITY_CANARY] },
  };
}

const scenario = fc.record({
  criteria: criteriaArb.map(withCanaries),
  text: fc.constantFrom(CLEAN_TEXT, PRESENTIAL_TEXT, INJECTION_TEXT),
  mode: fc.constantFrom("auto" as const, "aprofundada" as const),
  llm: fc.constantFrom("ok" as const, "falha" as const, "ausente" as const),
  shortCircuitAccept: fc.boolean(),
  title: fc.constantFrom("Desenvolvedor Backend Pleno", null),
});

describe("propriedade: relatório válido e sem eco do perfil em todos os caminhos", () => {
  test("SR-11, PII fora do LLM e telemetria válida (1.000 execuções)", async () => {
    const paths = new Set<string>();
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const groq = s.llm === "ausente" ? null : [s.llm === "ok" ? { kind: "ok" as const, raw: CLEAN_RAW } : { kind: "erro_permanente" as const }];
        const h = new JobHarness({ groq, shortCircuitAccept: s.shortCircuitAccept });
        const { report } = await h.analyze(request({ text: s.text, mode: s.mode, title: s.title }), s.criteria);
        paths.add(report.decisionPath);

        expect(AnalysisReportSchema.safeParse(report).success).toBe(true);
        const serialized = JSON.stringify(report).toLowerCase();
        expect(serialized).not.toContain(NOTE_CANARY.toLowerCase());
        expect(serialized).not.toContain(CITY_CANARY.toLowerCase());
        expect(JSON.stringify(h.payloads)).not.toContain(String(SALARY_CANARY));
        expect(serialized).not.toContain(String(SALARY_CANARY));
        expect(JSON.stringify(h.payloads).toLowerCase()).not.toContain(NOTE_CANARY.toLowerCase());
        expect(JSON.stringify(h.payloads).toLowerCase()).not.toContain(CITY_CANARY.toLowerCase());
        // Caminhos sem IA nunca chamam o LLM (Denial of Wallet).
        if (report.decisionPath === "triagem_deterministica" || (report.decisionPath === "fallback_deterministico" && s.text === INJECTION_TEXT)) {
          expect(h.payloads).toEqual([]);
        }
        for (const event of h.telemetry.events) expect(TelemetryEventSchema.safeParse(event).success).toBe(true);
      }),
      { numRuns: 1_000 },
    );
    // A propriedade percorreu os quatro caminhos do contrato... menos o hit, que exige duas análises (teste de unidade).
    expect([...paths].sort()).toEqual(["extracao_llm", "fallback_deterministico", "triagem_deterministica"]);
  });
});
