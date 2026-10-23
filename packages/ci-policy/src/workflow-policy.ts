// Política dos workflows do GitHub Actions (ADR-019 D2 a D5; threat-model T26, T27).
// Função pura: recebe o documento já lido do YAML e devolve as violações. O teste do repositório
// exige zero violação em todo arquivo de .github/workflows, então afrouxar a política derruba o CI.

export type WorkflowRule =
  | "documento"
  | "gatilho"
  | "permissoes"
  | "job"
  | "passo"
  | "runner"
  | "prazo"
  | "action_fora_da_lista"
  | "action_sem_sha"
  | "checkout_com_credencial"
  | "cache"
  | "segredo"
  | "interpolacao_em_run"
  | "instalacao_sem_lockfile"
  | "execucao_remota"
  | "download_sem_hash";

export interface WorkflowViolation {
  readonly rule: WorkflowRule;
  /** Caminho no documento, como `jobs.test.steps[2]`. Nunca carrega valor. */
  readonly where: string;
}

export const WORKFLOW_POLICY = Object.freeze({
  /** Gatilhos que não rodam código de PR com permissão de escrita (D2). */
  allowedEvents: Object.freeze(["push", "pull_request"]),
  /** Lista fechada de actions (D3). Action nova exige mudar a política. */
  allowedActions: Object.freeze(["actions/checkout", "actions/setup-node", "pnpm/action-setup"]),
  /** Runner fixo: nunca `*-latest` nem `self-hosted` (D5). */
  allowedRunners: Object.freeze(["ubuntu-24.04"]),
  maxTimeoutMinutes: 30,
});

type Doc = Readonly<Record<string, unknown>>;

const USES_PATTERN = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{40})$/;
const SECRET_EXPRESSION = /\$\{\{[^}]*\b(?:secrets|github\.token)\b/;
const PNPM_INSTALL = /\bpnpm\s+(?:install|i)\b/;
const OTHER_INSTALL = /\b(?:npm|yarn)\s+(?:install|i|add|ci)\b|\bpnpm\s+add\b/;
const REMOTE_EXECUTION = /\bnpx\b|\bpnpx\b|\bpnpm\s+dlx\b|\b(?:curl|wget)\b[^\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/;
const DOWNLOAD = /\b(?:curl|wget)\b/;
const HASH_CHECK = /\bsha256sum\s+(?:--check|-c)\b/;

function isRecord(value: unknown): value is Doc {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Toda string do documento, para a regra de segredo valer em `env`, `with` e `run`. */
function collectStrings(value: unknown, out: string[]): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (isRecord(value)) for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

function eventNames(on: unknown): readonly string[] | null {
  if (typeof on === "string") return [on];
  if (Array.isArray(on) && on.every((item) => typeof item === "string")) return on;
  if (isRecord(on)) return Object.keys(on);
  return null;
}

function auditEvents(on: unknown, out: WorkflowViolation[]): void {
  const events = eventNames(on);
  if (events === null || events.length === 0) {
    out.push({ rule: "gatilho", where: "on" });
    return;
  }
  for (const event of events) {
    if (!WORKFLOW_POLICY.allowedEvents.includes(event)) out.push({ rule: "gatilho", where: `on.${event}` });
  }
}

/** Topo: exatamente `{ contents: read }`. */
function auditTopPermissions(permissions: unknown, out: WorkflowViolation[]): void {
  const exact = isRecord(permissions) && Object.keys(permissions).length === 1 && permissions["contents"] === "read";
  if (!exact) out.push({ rule: "permissoes", where: "permissions" });
}

/** Job: pode só restringir, nunca pedir escrita. */
function auditJobPermissions(permissions: unknown, where: string, out: WorkflowViolation[]): void {
  if (permissions === undefined) return;
  const readOnly =
    isRecord(permissions) && Object.values(permissions).every((level) => level === "read" || level === "none");
  if (!readOnly) out.push({ rule: "permissoes", where: `${where}.permissions` });
}

function auditUses(uses: string, step: Doc, where: string, out: WorkflowViolation[]): void {
  const match = USES_PATTERN.exec(uses);
  if (match === null) {
    out.push({ rule: "action_sem_sha", where });
    return;
  }
  const action = match[1] as string;
  if (!WORKFLOW_POLICY.allowedActions.includes(action)) out.push({ rule: "action_fora_da_lista", where });
  const inputs = isRecord(step["with"]) ? step["with"] : {};
  if (action === "actions/checkout" && inputs["persist-credentials"] !== false) {
    out.push({ rule: "checkout_com_credencial", where });
  }
  if (action === "actions/setup-node" && (inputs["package-manager-cache"] !== false || "cache" in inputs)) {
    out.push({ rule: "cache", where });
  }
  if (action === "pnpm/action-setup") {
    if (inputs["cache"] !== undefined && inputs["cache"] !== false) out.push({ rule: "cache", where });
    if ("run_install" in inputs) out.push({ rule: "instalacao_sem_lockfile", where });
  }
}

function auditRun(run: string, where: string, out: WorkflowViolation[]): void {
  if (run.includes("${{")) out.push({ rule: "interpolacao_em_run", where });
  const lines = run.split("\n");
  const unfrozen = lines.some(
    (line) => OTHER_INSTALL.test(line) || (PNPM_INSTALL.test(line) && !line.includes("--frozen-lockfile")),
  );
  if (unfrozen) out.push({ rule: "instalacao_sem_lockfile", where });
  if (REMOTE_EXECUTION.test(run)) out.push({ rule: "execucao_remota", where });
  if (DOWNLOAD.test(run) && !HASH_CHECK.test(run)) out.push({ rule: "download_sem_hash", where });
}

function auditStep(step: unknown, where: string, out: WorkflowViolation[]): void {
  if (!isRecord(step)) {
    out.push({ rule: "passo", where });
    return;
  }
  const uses = step["uses"];
  const run = step["run"];
  if (typeof uses === "string" && run === undefined) auditUses(uses, step, where, out);
  else if (typeof run === "string" && uses === undefined) auditRun(run, where, out);
  else out.push({ rule: "passo", where });
}

function auditJob(job: unknown, where: string, out: WorkflowViolation[]): void {
  if (!isRecord(job) || job["uses"] !== undefined) {
    out.push({ rule: "job", where });
    return;
  }
  const runner = job["runs-on"];
  if (typeof runner !== "string" || !WORKFLOW_POLICY.allowedRunners.includes(runner)) {
    out.push({ rule: "runner", where: `${where}.runs-on` });
  }
  const timeout = job["timeout-minutes"];
  const validTimeout =
    typeof timeout === "number" &&
    Number.isInteger(timeout) &&
    timeout >= 1 &&
    timeout <= WORKFLOW_POLICY.maxTimeoutMinutes;
  if (!validTimeout) out.push({ rule: "prazo", where: `${where}.timeout-minutes` });
  auditJobPermissions(job["permissions"], where, out);
  const steps = job["steps"];
  if (!Array.isArray(steps) || steps.length === 0) {
    out.push({ rule: "job", where: `${where}.steps` });
    return;
  }
  steps.forEach((step, index) => auditStep(step, `${where}.steps[${index}]`, out));
}

export function auditWorkflow(document: unknown): readonly WorkflowViolation[] {
  if (!isRecord(document)) return [{ rule: "documento", where: "" }];
  const out: WorkflowViolation[] = [];
  auditEvents(document["on"], out);
  auditTopPermissions(document["permissions"], out);
  const jobs = document["jobs"];
  if (!isRecord(jobs) || Object.keys(jobs).length === 0) out.push({ rule: "job", where: "jobs" });
  else for (const [name, job] of Object.entries(jobs)) auditJob(job, `jobs.${name}`, out);
  if (collectStrings(document, []).some((text) => SECRET_EXPRESSION.test(text))) {
    out.push({ rule: "segredo", where: "" });
  }
  return out;
}
