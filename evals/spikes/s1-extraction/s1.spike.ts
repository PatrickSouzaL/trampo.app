// S-1: extração com provedores reais (BACKLOG S-1; plano estratificado de 2026-10-24).
// S1_MODE=plan|smoke|run|report; S1_PROVIDERS=groq,cloudflare_workers_ai; S1_MAX_ITEMS limita as chamadas por provedor.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlan, differs, loadSpikeCases, sweepCases } from "./cases.js";
import { readSpikeEnv, requireVar } from "./env.js";
import { createGroqProvider, createWorkersAiProvider, type SpikeProvider } from "./providers.js";
import { buildReport } from "./report.js";
import { scoreCase } from "./score.js";
import { runProvider } from "./runner.js";
import { OUT_DIR, readRows } from "./store.js";
import { WORKERS_AI_DEFAULT_MODEL } from "../../../apps/api/src/infrastructure/llm/cloudflare-workers-ai-extractor.js";

const mode = process.env["S1_MODE"] ?? "plan";
const wanted = (process.env["S1_PROVIDERS"] ?? "groq,cloudflare_workers_ai").split(",");
const groqVariant = process.env["S1_GROQ_VARIANT"] === "nao_estrito" ? "nao_estrito" : "estrito";
/** S1_ONLY=json_validate_failed: só os itens que o Groq estrito recusou (para a variante `nao_estrito`). */
const only = process.env["S1_ONLY"];
const maxItems = Number(process.env["S1_MAX_ITEMS"] ?? (mode === "smoke" ? "1" : "1000"));

const cases = loadSpikeCases();
const byId = new Map(cases.map((c) => [c.golden.id, c] as const));
const fullPlan = buildPlan(cases);
const failedKeys = new Set(
  readRows()
    .filter((r) => r.provider === "groq" && r.variant === "estrito" && r.errorCode === only)
    .map((r) => `${r.caseId}|${String(r.budget)}`),
);
const plan = only === undefined ? fullPlan : fullPlan.filter((p) => failedKeys.has(`${p.caseId}|${String(p.budget)}`));

function providers(): SpikeProvider[] {
  const env = readSpikeEnv();
  const out: SpikeProvider[] = [];
  if (wanted.includes("groq")) out.push(createGroqProvider(requireVar(env, "GROQ_API_KEY"), groqVariant));
  if (wanted.includes("cloudflare_workers_ai")) {
    out.push(
      createWorkersAiProvider({
        accountId: requireVar(env, "CLOUDFLARE_ACCOUNT_ID"),
        apiToken: requireVar(env, "CLOUDFLARE_API_TOKEN"),
        model: env.get("CLOUDFLARE_WORKERS_AI_MODEL") ?? WORKERS_AI_DEFAULT_MODEL,
      }),
    );
  }
  return out;
}

/** [APPSEC]: nada do texto das vagas (linha ≥ 25 chars) nem canário no que é gravado como relatório. */
function assertClean(serialized: string): void {
  expect(serialized).not.toMatch(/TRAMPO-CANARY/u);
  for (const c of cases) {
    for (const [, payload] of c.payloads) {
      for (const line of payload.split("\n")) {
        const t = line.trim();
        if (t.length >= 25) expect(serialized.includes(t)).toBe(false);
      }
    }
  }
}

describe(`S-1 (${mode})`, () => {
  it("monta o plano estratificado sobre os 83 casos", () => {
    expect(cases).toHaveLength(83);
    const sweep = sweepCases(cases);
    const maxChars = Math.max(...cases.map((c) => c.normalizedChars));
    console.log(`plano: ${String(plan.length)} itens por provedor (83 em 6k + ${String(plan.length - 83)} em 4k/8k); maior texto normalizado: ${String(maxChars)}`);
    console.log(`8k difere de 6k em ${String(cases.filter((c) => differs(c, 8_000)).length)} casos; 4k difere em ${String(cases.filter((c) => differs(c, 4_000)).length)}`);
    console.log(`subconjunto 4k/8k: ${sweep.map((c) => `${c.golden.id}(${c.golden.category},${String(c.normalizedChars)})`).join(" ")}`);
  });

  it("o avaliador dá 100% ao próprio gabarito (prova do [QA_EVALS])", () => {
    for (const c of cases) {
      const s = scoreCase(c.golden, c.golden.expected);
      expect(s.seniorityLevels && s.workModels && s.contractTypes && s.location && s.yearsExperienceMin).toBe(true);
      expect(s.languageRequirements && s.injectionFactsIntact).toBe(true);
      expect(s.salary === null || s.salary).toBe(true);
      expect([s.salaryInvented, s.currencyGap, s.stackExtraTerms]).toEqual([false, false, 0]);
      expect([s.stack.fp, s.stack.fn, s.benefits.fp, s.benefits.fn, s.redFlags.fp, s.redFlags.fn]).toEqual([0, 0, 0, 0, 0, 0]);
      expect(s.stackRightList.right).toBe(s.stackRightList.total);
    }
  });

  it.runIf(mode === "smoke" || mode === "run")("chama os provedores", async () => {
    const summaries = await Promise.all(providers().map((p) => runProvider(p, plan, byId, maxItems, (l) => console.log(l))));
    for (const s of summaries) console.log(`[${s.provider}] feitos=${String(s.done)} restantes=${String(s.remaining)} parada=${s.stoppedBy}`);
  });

  it.runIf(mode === "report" || mode === "run" || mode === "smoke")("grava o relatório agregado", () => {
    const serialized = JSON.stringify(buildReport(readRows(), cases), null, 2);
    assertClean(serialized);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, "s1-metrics.json"), `${serialized}\n`, "utf8");
  });
});
