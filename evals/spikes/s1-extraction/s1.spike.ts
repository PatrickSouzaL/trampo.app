// S-1: extração com provedores reais (BACKLOG S-1; plano estratificado de 2026-10-24).
// S1_MODE=plan|smoke|run|report|diag; S1_PROVIDERS=groq,cloudflare_workers_ai; S1_MAX_ITEMS limita as chamadas por provedor.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlan, differs, loadSpikeCases, sweepCases } from "./cases.js";
import { readSpikeEnv, requireVar } from "./env.js";
import { createGroqProvider, createWorkersAiProvider, type SpikeProvider } from "./providers.js";
import { diagnose } from "./diag.js";
import { buildReport } from "./report.js";
import { NAME_RULE_VOCABULARY, aliasKey, scoreCase, stackKey } from "./score.js";
import { fold } from "../../../apps/api/src/domain/prefilter/folding.js";
import { runProvider } from "./runner.js";
import { OUT_DIR, readAllRows, readRows, resultsPath, type ResultRow } from "./store.js";
import { WORKERS_AI_DEFAULT_MODEL } from "../../../apps/api/src/infrastructure/llm/cloudflare-workers-ai-extractor.js";

const mode = process.env["S1_MODE"] ?? "plan";
const wanted = (process.env["S1_PROVIDERS"] ?? "groq,cloudflare_workers_ai").split(",");
const groqVariant = process.env["S1_GROQ_VARIANT"] === "nao_estrito" ? "nao_estrito" : "estrito";
/** S1_ONLY=json_validate_failed: só os itens que o Groq estrito recusou (para a variante `nao_estrito`). */
const only = process.env["S1_ONLY"];
const maxItems = Number(process.env["S1_MAX_ITEMS"] ?? (mode === "smoke" ? "1" : "1000"));
/** S1_BUDGETS=6000: só esses orçamentos (a rodada de aceite do p2 não refaz a varredura de 4k/8k). */
const budgets = process.env["S1_BUDGETS"]?.split(",").map(Number);

const cases = loadSpikeCases();
const byId = new Map(cases.map((c) => [c.golden.id, c] as const));
const fullPlan = buildPlan(cases);
const failedKeys = new Set(
  readRows(resultsPath("p1", "g2"))
    .filter((r) => r.provider === "groq" && r.variant === "estrito" && r.errorCode === only)
    .map((r) => `${r.caseId}|${String(r.budget)}`),
);
const plan = (only === undefined ? fullPlan : fullPlan.filter((p) => failedKeys.has(`${p.caseId}|${String(p.budget)}`))).filter(
  (p) => budgets === undefined || budgets.includes(p.budget),
);

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

  it("a equivalência de nome junta o mesmo produto e separa os distintos (HITL-031 3A, nomes fictícios)", () => {
    const same: [string, string][] = [
      ["AWS Zorblet", "Amazon Zorblet"],
      ["Amazon Zorblet", "Zorblet"],
      ["Microsoft Quillon", "Quillon"],
      ["Google Cloud Quillon", "quillon"],
      ["Apache-Quillon", "Quillon"],
      ["Microsoft Azure Quillon", "Azure Quillon"],
      ["Quillon 17", "Quillon"],
      ["Quillon 3.x", "Quillon"],
      ["Quillon v2.1+", "Quillon"],
      ["Quillon On-Premises", "Quillon"],
      ["Quillon Self-Hosted", "Quillon Cloud"],
      ["Quillon Online", "QUILLON"],
      ["AWS Zrb", "Amazon Zrb"],
    ];
    for (const [a, b] of same) expect([a, stackKey(a)]).toEqual([a, stackKey(b)]);
    const distinct: [string, string][] = [
      ["AWS Zrb", "Azure Zrb"], // sigla curta: o fornecedor fica
      ["Azure Zrb", "Zrb"],
      ["Oracle Database", "Database"], // o que sobra não nomeia produto
      ["Azure DevOps", "DevOps"],
      ["Google Cloud Platform", "Platform"],
      ["Quillon 27001", "Quillon"], // número de norma não é versão
      ["Oracle", "SAP"],
    ];
    for (const [a, b] of distinct) expect([a, stackKey(a)]).not.toEqual([a, stackKey(b)]);
    expect(stackKey("Oracle")).toBe("oracle"); // o fornecedor sozinho fica
  });

  it("a equivalência não funde dois termos que o gabarito separa no mesmo caso", () => {
    for (const c of cases) {
      for (const field of ["stackRequired", "stackNiceToHave"] as const) {
        const options = [c.golden.expected[field], ...((c.golden.alternatives[field] ?? []) as string[][])];
        for (const list of options) {
          const before = new Set(list.map(aliasKey));
          expect([c.golden.id, field, new Set(list.map(stackKey)).size]).toEqual([c.golden.id, field, before.size]);
        }
      }
    }
  });

  it("[APPSEC] o vocabulário da regra não traz termo do gd1 além dos fornecedores do HITL-031", () => {
    const goldTerms = new Set(
      cases.flatMap((c) => [...c.golden.expected.stackRequired, ...c.golden.expected.stackNiceToHave].map((t) => fold(t).text.trim().split(/\s+/u).join(" "))),
    );
    const outsideVendors = [...NAME_RULE_VOCABULARY.deployments, ...NAME_RULE_VOCABULARY.genericRemainders].filter((w) => goldTerms.has(w));
    console.log(`vocabulário fora dos fornecedores que também é termo do gd1: ${String(outsideVendors.length)}`);
    expect(outsideVendors).toEqual([]);
  });

  it.runIf(mode === "smoke" || mode === "run")("chama os provedores", async () => {
    const summaries = await Promise.all(providers().map((p) => runProvider(p, plan, byId, maxItems, (l) => console.log(l))));
    for (const s of summaries) console.log(`[${s.provider}] feitos=${String(s.done)} restantes=${String(s.remaining)} parada=${s.stoppedBy}`);
  });

  it.runIf(mode === "diag")("diagnostica em memória as saídas que o guard recusou", async () => {
    const report: Record<string, unknown>[] = [];
    for (const p of providers()) {
      const latest = new Map<string, ResultRow>();
      for (const r of readRows()) {
        if (r.provider === p.key && r.model === p.model && r.variant === p.variant && r.outcome !== "limite_de_taxa") latest.set(`${r.caseId}|${String(r.budget)}`, r);
      }
      const targets = [...latest.values()].filter((r) => r.guardOk === false).slice(0, maxItems);
      console.log(`[${p.key}/${p.variant}] ${String(targets.length)} saídas recusadas pelo guard`);
      for (const t of targets) {
        const payload = byId.get(t.caseId)?.payloads.get(t.budget);
        if (payload === undefined) throw new Error(`linha sem caso: ${t.caseId}`);
        const call = await p.call(payload, 30_000);
        const raw = call.raw ?? call.failedGeneration;
        const d = raw === null ? null : diagnose(raw);
        const entry = { provider: p.key, variant: p.variant, caseId: t.caseId, budget: t.budget, outcome: call.outcome, status: call.status, errorCode: call.errorCode, ...d };
        report.push(entry);
        console.log(
          `[${p.key}] ${t.caseId} ${String(t.budget)} → ${call.outcome} guard=${String(d?.guardOk)} semForaDoEnum=${String(d?.guardOkWithoutOffEnum)}` +
            ` removidos=${String(d?.offEnumDropped)} ${(d?.issues ?? []).map((i) => `${i.path}:${i.code}:${i.message ?? "-"}:${i.value}`).join(" ")}`,
        );
        await new Promise((r) => setTimeout(r, p.key === "groq" ? 20_000 : 1_000));
      }
    }
    const serialized = JSON.stringify({ spike: "S-1", diag: true, generatedAt: new Date().toISOString(), entries: report }, null, 2);
    assertClean(serialized);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, "s1-diag.json"), `${serialized}
`, "utf8");
  });

  it.runIf(mode === "report" || mode === "run" || mode === "smoke")("grava o relatório agregado", () => {
    const serialized = JSON.stringify(buildReport(readAllRows(), cases), null, 2);
    assertClean(serialized);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, "s1-metrics.json"), `${serialized}\n`, "utf8");
  });
});
