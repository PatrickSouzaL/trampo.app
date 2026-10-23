// Os workflows reais do repositório (ADR-019 §3, critério 2). Roda no pnpm test, então o próprio CI
// derruba um workflow que afrouxe a política.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseWorkflow } from "../src/parse-workflow.js";
import { auditWorkflow } from "../src/workflow-policy.js";

const WORKFLOWS_DIR = fileURLToPath(new URL("../../../.github/workflows/", import.meta.url));
const ROOT_DIR = fileURLToPath(new URL("../../../", import.meta.url));

const files = readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/.test(name));

function load(name: string): Record<string, unknown> {
  return parseWorkflow(readFileSync(WORKFLOWS_DIR + name, "utf8"), name) as Record<string, unknown>;
}

function runs(job: unknown): string {
  const steps = (job as { steps: Array<{ run?: string }> }).steps;
  return steps.map((step) => step.run ?? "").join("\n");
}

describe("workflows do repositório", () => {
  it("existe pelo menos o ci.yml, e todo arquivo da pasta é YAML", () => {
    expect(files).toContain("ci.yml");
    expect(readdirSync(WORKFLOWS_DIR).every((name) => /\.ya?ml$/.test(name))).toBe(true);
  });

  it.each(files)("%s não viola a política", (name) => {
    expect(auditWorkflow(load(name))).toEqual([]);
  });
});

describe("ci.yml: o que o ADR-019 D5 exige", () => {
  const ci = load("ci.yml");
  const jobs = ci["jobs"] as Record<string, unknown>;
  const env = ci["env"] as Record<string, string>;

  it("tem exatamente os jobs secrets, quality, test e db", () => {
    expect(Object.keys(jobs).sort()).toEqual(["db", "quality", "secrets", "test"]);
  });

  it("db: CLI fixa e conferida por sha256 antes de qualquer comando, só a pilha local e o test:db (ADR-019 D8)", () => {
    const steps = (jobs["db"] as { steps: Array<{ uses?: string; with?: Record<string, unknown>; run?: string }> }).steps;
    const setup = steps.findIndex((step) => step.uses?.startsWith("supabase/setup-cli@"));
    expect(steps[setup]?.with).toEqual({ version: "2.120.0" });
    expect(env["SUPABASE_CLI_SHA256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(env["SUPABASE_GO_SHA256"]).toMatch(/^[0-9a-f]{64}$/);
    // O primeiro passo depois da action confere os dois binários e só então roda a CLI.
    const check = steps.at(setup + 1)?.run ?? "";
    expect(check.indexOf("sha256sum --check --strict")).toBeGreaterThan(-1);
    expect(check.lastIndexOf("sha256sum")).toBeLessThan(check.indexOf("supabase telemetry disable"));
    const script = runs(jobs["db"]);
    expect(script).toContain("supabase start -x ");
    expect(script).toContain("pnpm --filter @trampo/api test:db");
    // Só as três variáveis do teste saem do status: a secret e a service_role locais ficam de fora.
    expect(script).toContain("grep -E '^(API_URL|DB_URL|PUBLISHABLE_KEY)='");
  });

  it("db: o start deixa de fora tudo que o test:db não usa", () => {
    const start = /supabase start -x (\S+)/.exec(runs(jobs["db"]))?.[1]?.split(",") ?? [];
    expect(start.sort()).toEqual(
      ["edge-runtime", "imgproxy", "logflare", "mailpit", "postgres-meta", "realtime", "storage-api", "studio", "supavisor", "vector"],
    );
    expect(start).not.toContain("gotrue");
    expect(start).not.toContain("postgrest");
    expect(start).not.toContain("kong");
  });

  it("secrets: histórico completo, gitleaks fixo e conferido, configuração do repositório", () => {
    const checkout = (jobs["secrets"] as { steps: Array<{ with?: Record<string, unknown> }> }).steps[0];
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(env["GITLEAKS_VERSION"]).toBe("8.30.1");
    expect(env["GITLEAKS_SHA256"]).toMatch(/^[0-9a-f]{64}$/);
    const script = runs(jobs["secrets"]);
    expect(script).toContain("sha256sum --check --strict");
    expect(script).toContain("--config .gitleaks.toml --redact");
    expect(script).toContain("--exit-code 1");
    expect(script.indexOf("sha256sum")).toBeLessThan(script.indexOf("tar -xzf"));
  });

  it("quality: build, lint, typecheck e depcruise", () => {
    const script = runs(jobs["quality"]);
    expect(script).toContain("pnpm exec turbo run build lint typecheck");
    expect(script).toContain("pnpm lint:deps");
  });

  it("test: em série, num job próprio (QA-01)", () => {
    const script = runs(jobs["test"]);
    expect(script).toContain("pnpm exec turbo run test --concurrency=1");
    expect(runs(jobs["quality"])).not.toContain("turbo run test");
  });

  it("Node 24.22.1, o piso do engines (hotfix de CVE)", () => {
    for (const name of ["quality", "test", "db"]) {
      const steps = (jobs[name] as { steps: Array<{ uses?: string; with?: Record<string, unknown> }> }).steps;
      const node = steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
      expect(node?.with?.["node-version"]).toBe("24.22.1");
    }
  });

  it("a configuração do gitleaks estende o padrão e não libera caminho", () => {
    const config = readFileSync(`${ROOT_DIR}.gitleaks.toml`, "utf8").replaceAll("\r\n", "\n");
    expect(config).toContain("[extend]\nuseDefault = true\n");
    const lines = config.split("\n").map((text) => text.trim());
    expect(lines.filter((text) => text.startsWith("paths"))).toEqual([]);
    for (const line of lines.filter((text) => text.startsWith("'''"))) {
      expect(line).toMatch(/^'''\^.+\$''',$/);
    }
  });
});

describe("parseWorkflow", () => {
  it("usa o YAML 1.2: `on` continua string", () => {
    expect(parseWorkflow("on: push\n", "x.yml")).toEqual({ on: "push" });
    expect(parseWorkflow("d: 2026-10-22\ny: yes\n", "x.yml")).toEqual({ d: "2026-10-22", y: "yes" });
  });

  it("recusa chave duplicada e tag customizada", () => {
    expect(() => parseWorkflow("a: 1\na: 2\n", "x.yml")).toThrow(/x\.yml/);
    expect(() => parseWorkflow("a: !!js/function 'function(){}'\n", "x.yml")).toThrow();
  });
});
