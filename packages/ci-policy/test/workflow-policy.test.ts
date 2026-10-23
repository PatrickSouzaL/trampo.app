import { describe, expect, it } from "vitest";

import { auditWorkflow, WORKFLOW_POLICY, type WorkflowViolation } from "../src/workflow-policy.js";

const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1";
const SETUP_PNPM = "pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413";
const OTHER_SHA = "0123456789abcdef0123456789abcdef01234567";

type Step = Record<string, unknown>;

function job(steps: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { "runs-on": "ubuntu-24.04", "timeout-minutes": 10, steps, ...extra };
}

function baseSteps(): Step[] {
  return [
    { uses: CHECKOUT, with: { "persist-credentials": false } },
    { uses: SETUP_PNPM },
    { uses: SETUP_NODE, with: { "node-version": "24", "package-manager-cache": false } },
    { run: "pnpm install --frozen-lockfile" },
  ];
}

function workflow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "ci",
    on: { push: { branches: ["master"] }, pull_request: { branches: ["master"] } },
    permissions: { contents: "read" },
    jobs: { test: job(baseSteps()) },
    ...overrides,
  };
}

function withStep(step: unknown): Record<string, unknown> {
  return workflow({ jobs: { test: job([...baseSteps(), step]) } });
}

const LAST = "jobs.test.steps[4]";

function rules(violations: readonly WorkflowViolation[]): string[] {
  return violations.map((violation) => `${violation.rule}@${violation.where}`);
}

describe("auditWorkflow: documento conforme", () => {
  it("não acusa nada no workflow de referência", () => {
    expect(auditWorkflow(workflow())).toEqual([]);
  });

  it("aceita gatilho como string, como lista e o pnpm/action-setup com cache false", () => {
    expect(auditWorkflow(workflow({ on: "push" }))).toEqual([]);
    expect(auditWorkflow(workflow({ on: ["push", "pull_request"] }))).toEqual([]);
    expect(auditWorkflow(withStep({ uses: SETUP_PNPM, with: { cache: false } }))).toEqual([]);
  });

  it("aceita permissões de job que só restringem", () => {
    const doc = workflow({ jobs: { test: job(baseSteps(), { permissions: { contents: "read", actions: "none" } }) } });
    expect(auditWorkflow(doc)).toEqual([]);
  });

  it("aceita os limites do prazo (1 e o teto)", () => {
    for (const minutes of [1, WORKFLOW_POLICY.maxTimeoutMinutes]) {
      expect(auditWorkflow(workflow({ jobs: { test: job(baseSteps(), { "timeout-minutes": minutes }) } }))).toEqual([]);
    }
  });

  it("aceita download com curl quando o mesmo passo confere o sha256", () => {
    for (const check of ["sha256sum --check --strict", "sha256sum -c"]) {
      const run = `curl --fail -o a.tgz https://example.invalid/a.tgz\necho "x  a.tgz" | ${check}`;
      expect(auditWorkflow(withStep({ run }))).toEqual([]);
    }
  });

  it("expõe a política congelada", () => {
    expect(Object.isFrozen(WORKFLOW_POLICY)).toBe(true);
    expect(Object.isFrozen(WORKFLOW_POLICY.allowedActions)).toBe(true);
    expect(Object.isFrozen(WORKFLOW_POLICY.allowedEvents)).toBe(true);
    expect(Object.isFrozen(WORKFLOW_POLICY.allowedRunners)).toBe(true);
  });
});

describe("auditWorkflow: documento e gatilhos", () => {
  it.each([null, "texto", 42, [], undefined])("recusa documento que não é objeto (%j)", (doc) => {
    expect(rules(auditWorkflow(doc))).toEqual(["documento@"]);
  });

  it.each(["pull_request_target", "workflow_run", "issue_comment", "schedule", "workflow_dispatch"])(
    "recusa o gatilho %s",
    (event) => {
      expect(rules(auditWorkflow(workflow({ on: { push: null, [event]: null } })))).toEqual([`gatilho@on.${event}`]);
    },
  );

  it("recusa gatilho em string ou lista fora da lista", () => {
    expect(rules(auditWorkflow(workflow({ on: "pull_request_target" })))).toEqual(["gatilho@on.pull_request_target"]);
    expect(rules(auditWorkflow(workflow({ on: ["push", "workflow_run"] })))).toEqual(["gatilho@on.workflow_run"]);
  });

  it.each([undefined, null, 1, true, [], {}, ["push", 1]])("recusa gatilho ausente, vazio ou malformado (%j)", (on) => {
    expect(rules(auditWorkflow(workflow({ on })))).toEqual(["gatilho@on"]);
  });
});

describe("auditWorkflow: permissões", () => {
  it.each([
    ["ausente", undefined],
    ["read-all", "read-all"],
    ["write-all", "write-all"],
    ["vazia", {}],
    ["escrita", { contents: "write" }],
    ["chave a mais", { contents: "read", "pull-requests": "read" }],
    ["outra chave", { actions: "read" }],
  ])("recusa a permissão de topo %s", (_label, permissions) => {
    expect(rules(auditWorkflow(workflow({ permissions })))).toEqual(["permissoes@permissions"]);
  });

  it.each([
    ["string", "write-all"],
    ["escrita", { contents: "write" }],
    ["id-token", { "id-token": "write" }],
    ["lista", ["read"]],
  ])("recusa a permissão de job %s", (_label, permissions) => {
    const doc = workflow({ jobs: { test: job(baseSteps(), { permissions }) } });
    expect(rules(auditWorkflow(doc))).toEqual(["permissoes@jobs.test.permissions"]);
  });
});

describe("auditWorkflow: jobs", () => {
  it.each([undefined, null, {}, []])("recusa jobs ausentes ou vazios (%j)", (jobs) => {
    expect(rules(auditWorkflow(workflow({ jobs })))).toEqual(["job@jobs"]);
  });

  it("recusa job que não é objeto e job que chama workflow reutilizável", () => {
    expect(rules(auditWorkflow(workflow({ jobs: { a: "x" } })))).toEqual(["job@jobs.a"]);
    const reusable = { uses: "org/repo/.github/workflows/x.yml@main" };
    expect(rules(auditWorkflow(workflow({ jobs: { a: reusable } })))).toEqual(["job@jobs.a"]);
  });

  it.each(["ubuntu-latest", "self-hosted", "ubuntu-22.04", ["ubuntu-24.04"], undefined])(
    "recusa o runner %j",
    (runner) => {
      const doc = workflow({ jobs: { test: job(baseSteps(), { "runs-on": runner }) } });
      expect(rules(auditWorkflow(doc))).toEqual(["runner@jobs.test.runs-on"]);
    },
  );

  it.each([undefined, 0, 31, 1.5, "10", -1])("recusa o prazo %j", (minutes) => {
    const doc = workflow({ jobs: { test: job(baseSteps(), { "timeout-minutes": minutes }) } });
    expect(rules(auditWorkflow(doc))).toEqual(["prazo@jobs.test.timeout-minutes"]);
  });

  it.each([undefined, [], "pnpm test"])("recusa steps ausentes ou vazios (%j)", (steps) => {
    const doc = workflow({ jobs: { test: { "runs-on": "ubuntu-24.04", "timeout-minutes": 5, steps } } });
    expect(rules(auditWorkflow(doc))).toEqual(["job@jobs.test.steps"]);
  });

  it("audita todos os jobs e acumula as violações", () => {
    const doc = workflow({ jobs: { a: job(baseSteps(), { "runs-on": "ubuntu-latest" }), b: job([{ uses: "x/y@v1" }]) } });
    expect(rules(auditWorkflow(doc))).toEqual(["runner@jobs.a.runs-on", "action_sem_sha@jobs.b.steps[0]"]);
  });
});

describe("auditWorkflow: passos", () => {
  it.each([
    ["não é objeto", "pnpm test"],
    ["nulo", null],
    ["lista", [{ run: "echo" }]],
    ["sem uses nem run", { name: "vazio" }],
    ["uses e run juntos", { uses: CHECKOUT, run: "echo" }],
    ["uses que não é string", { uses: 1 }],
    ["run que não é string", { run: ["echo"] }],
  ])("recusa passo %s", (_label, step) => {
    expect(rules(auditWorkflow(withStep(step)))).toEqual([`passo@${LAST}`]);
  });
});

describe("auditWorkflow: actions", () => {
  it.each([
    "actions/checkout@v7",
    "actions/checkout@main",
    `actions/checkout@${OTHER_SHA.slice(0, 39)}`,
    `actions/checkout@${OTHER_SHA.toUpperCase()}`,
    `actions/checkout@${OTHER_SHA}0`,
    `docker://alpine@sha256:${OTHER_SHA}`,
    "./.github/actions/local",
    `actions/checkout/sub@${OTHER_SHA}`,
    ` actions/checkout@${OTHER_SHA}`,
  ])("recusa referência sem SHA de 40 hex: %s", (uses) => {
    expect(rules(auditWorkflow(withStep({ uses, with: { "persist-credentials": false } })))).toEqual([
      `action_sem_sha@${LAST}`,
    ]);
  });

  it.each(["actions/cache", "gitleaks/gitleaks-action", "actions/checkout-fork", "evil/checkout"])(
    "recusa action fora da lista: %s",
    (action) => {
      expect(rules(auditWorkflow(withStep({ uses: `${action}@${OTHER_SHA}` })))).toEqual([
        `action_fora_da_lista@${LAST}`,
      ]);
    },
  );

  it.each([
    ["sem with", undefined],
    ["sem a chave", {}],
    ["com true", { "persist-credentials": true }],
    ["com a string false", { "persist-credentials": "false" }],
  ])("recusa checkout que guarda credencial (%s)", (_label, inputs) => {
    expect(rules(auditWorkflow(withStep({ uses: CHECKOUT, with: inputs })))).toEqual([
      `checkout_com_credencial@${LAST}`,
    ]);
  });

  it.each([
    ["sem desligar o cache automático", { "node-version": "24" }],
    ["com cache pnpm", { "package-manager-cache": false, cache: "pnpm" }],
    ["com a string false", { "package-manager-cache": "false" }],
    ["sem with", undefined],
  ])("recusa setup-node %s", (_label, inputs) => {
    expect(rules(auditWorkflow(withStep({ uses: SETUP_NODE, with: inputs })))).toEqual([`cache@${LAST}`]);
  });

  it.each([
    [SETUP_NODE, "cache"],
    [CHECKOUT, "checkout_com_credencial"],
  ])("trata `with` que não é objeto como vazio (%s)", (uses, rule) => {
    for (const inputs of ["package-manager-cache: false", ["persist-credentials"], null]) {
      expect(rules(auditWorkflow(withStep({ uses, with: inputs })))).toEqual([`${rule}@${LAST}`]);
    }
    expect(auditWorkflow(withStep({ uses: SETUP_PNPM, with: "run_install" }))).toEqual([]);
  });

  it.each([true, "true"])("recusa pnpm/action-setup com cache %j", (cache) => {
    expect(rules(auditWorkflow(withStep({ uses: SETUP_PNPM, with: { cache } })))).toEqual([`cache@${LAST}`]);
  });

  it.each([true, "false", "[]"])("recusa pnpm/action-setup com run_install %j", (runInstall) => {
    expect(rules(auditWorkflow(withStep({ uses: SETUP_PNPM, with: { run_install: runInstall } })))).toEqual([
      `instalacao_sem_lockfile@${LAST}`,
    ]);
  });
});

describe("auditWorkflow: run", () => {
  it.each([
    "echo ${{ github.event.pull_request.title }}",
    "git checkout ${{ github.head_ref }}",
    "echo ${{ matrix.node }}",
  ])("recusa ${{ }} dentro de run: %s", (run) => {
    expect(rules(auditWorkflow(withStep({ run })))).toEqual([`interpolacao_em_run@${LAST}`]);
  });

  it.each([
    "pnpm install",
    "pnpm i",
    "pnpm install --prefer-offline\necho --frozen-lockfile",
    "pnpm add left-pad",
    "npm install",
    "npm i -g pnpm",
    "npm ci",
    "yarn install",
    "yarn add x",
  ])("recusa instalação fora do lockfile: %j", (run) => {
    expect(rules(auditWorkflow(withStep({ run })))).toEqual([`instalacao_sem_lockfile@${LAST}`]);
  });

  it("aceita outros comandos do pnpm e a instalação congelada em qualquer linha", () => {
    const run = "set -e\npnpm --version\npnpm install --frozen-lockfile\npnpm exec turbo run test";
    expect(auditWorkflow(withStep({ run }))).toEqual([]);
  });

  it.each(["npx turbo run test", "pnpx turbo", "pnpm dlx turbo", "pnpm  dlx turbo"])(
    "recusa execução de pacote remoto: %s",
    (run) => {
      expect(rules(auditWorkflow(withStep({ run })))).toEqual([`execucao_remota@${LAST}`]);
    },
  );

  it.each([
    "curl -fsSL https://x.invalid/i.sh | sh",
    "curl -fsSL https://x.invalid/i.sh | bash",
    "wget -qO- https://x.invalid/i.sh |sudo zsh",
    "curl https://x.invalid/i.sh|bash -s",
  ])("recusa download com pipe para shell, mesmo com sha256: %s", (download) => {
    const run = `${download}\necho "x  y" | sha256sum --check`;
    expect(rules(auditWorkflow(withStep({ run })))).toEqual([`execucao_remota@${LAST}`]);
  });

  it.each([
    "curl -o a.tgz https://x.invalid/a.tgz",
    "wget https://x.invalid/a.tgz",
    "curl -o a https://x\nsha256sum a",
    "curl -o a https://x\nfake_sha256sum --check a.sha",
  ])(
    "recusa download sem conferência de sha256: %j",
    (run) => {
      expect(rules(auditWorkflow(withStep({ run })))).toEqual([`download_sem_hash@${LAST}`]);
    },
  );

  it("o pipe para shell conta só na linha do download", () => {
    const run = 'curl -o a.tgz https://x.invalid/a.tgz\necho "x  a.tgz" | sha256sum --check\necho ok | sh';
    expect(auditWorkflow(withStep({ run }))).toEqual([]);
  });

  it("não confunde palavras que contêm curl, npx ou sh", () => {
    const run = "echo curly npxs\nls -la ./shell\necho bash";
    expect(auditWorkflow(withStep({ run }))).toEqual([]);
  });
});

describe("auditWorkflow: segredos", () => {
  it.each([
    ["no env do topo", { env: { TOKEN: "${{ secrets.NPM_TOKEN }}" } }],
    ["no env do job", { jobs: { test: job(baseSteps(), { env: { T: "${{ secrets.X }}" } }) } }],
    ["no with de uma action", { jobs: { test: job([...baseSteps(), { uses: CHECKOUT, with: { "persist-credentials": false, token: "${{ secrets.PAT }}" } }]) } }],
    ["com o github.token", { env: { GH: "${{ github.token }}" } }],
    ["com espaços e índice", { env: { T: "${{secrets['X']}}" } }],
  ])("recusa segredo %s", (_label, overrides) => {
    expect(rules(auditWorkflow(workflow(overrides)))).toContain("segredo@");
  });

  it("aceita expressões que não leem segredo, fora do run, e a palavra fora de expressão", () => {
    expect(auditWorkflow(workflow({ concurrency: { group: "ci-${{ github.ref }}" } }))).toEqual([]);
    expect(auditWorkflow(workflow({ name: "secrets e github.token" }))).toEqual([]);
  });

  it("acha o segredo dentro de listas", () => {
    const doc = workflow({ on: { push: { branches: ["${{ secrets.BRANCH }}"] } } });
    expect(rules(auditWorkflow(doc))).toEqual(["segredo@"]);
  });
});

const SETUP_SUPABASE = "supabase/setup-cli@afb1b15109756ea5cf9d8985a359d9095235ca2b";

describe("auditWorkflow: supabase/setup-cli (ADR-019 D8)", () => {
  it("aceita a action com a versao exata da CLI", () => {
    expect(auditWorkflow(withStep({ uses: SETUP_SUPABASE, with: { version: "2.120.0" } }))).toEqual([]);
  });

  it.each([
    ["sem with", undefined],
    ["sem version", {}],
    ["latest", { version: "latest" }],
    ["beta", { version: "beta" }],
    ["com v", { version: "v2.120.0" }],
    ["intervalo", { version: "^2.120.0" }],
    ["pre-release", { version: "2.121.0-beta.1" }],
    ["so major e minor", { version: "2.120" }],
    ["numero", { version: 2.12 }],
    ["com espaco", { version: " 2.120.0" }],
    ["com quebra de linha", { version: "2.120.0\n" }],
  ])("recusa versao que nao e exata: %s", (_label, inputs) => {
    const step = inputs === undefined ? { uses: SETUP_SUPABASE } : { uses: SETUP_SUPABASE, with: inputs };
    expect(rules(auditWorkflow(withStep(step)))).toEqual([`versao_nao_fixa@${LAST}`]);
  });

  it("recusa o github-token, mesmo vazio", () => {
    const step = { uses: SETUP_SUPABASE, with: { version: "2.120.0", "github-token": "" } };
    expect(rules(auditWorkflow(withStep(step)))).toEqual([`segredo@${LAST}`]);
  });

  it("outra action do dono supabase continua fora da lista", () => {
    expect(rules(auditWorkflow(withStep({ uses: `supabase/setup-cli-fork@${OTHER_SHA}`, with: { version: "2.120.0" } })))).toEqual([
      `action_fora_da_lista@${LAST}`,
    ]);
  });
});

describe("auditWorkflow: supabase só local (ADR-019 D8)", () => {
  it("aceita os subcomandos da pilha local", () => {
    const run = [
      "supabase telemetry disable",
      "supabase --version",
      "supabase start -x studio,realtime",
      'supabase status -o env | grep -E "^API_URL=" > "$RUNNER_TEMP/supabase-local.env"',
      "supabase stop --no-backup",
      'dir="$(dirname "$(command -v supabase)")"',
    ].join("\n");
    expect(auditWorkflow(withStep({ run }))).toEqual([]);
  });

  it.each([
    "supabase link --project-ref abc",
    "supabase db push",
    "supabase login",
    "supabase projects list",
    "supabase secrets set X=1",
    "supabase functions deploy",
    "supabase migration up",
    "supabase  db reset",
    "supabase\tlink",
    "echo ok && supabase link",
    "supabase start\nsupabase link",
  ])("recusa subcomando fora da lista: %s", (run) => {
    expect(rules(auditWorkflow(withStep({ run })))).toContain(`supabase_remoto@${LAST}`);
  });

  it.each([
    ["token da CLI no env", { env: { SUPABASE_ACCESS_TOKEN: "x" } }],
    ["senha do banco no env do job", { jobs: { test: job(baseSteps(), { env: { SUPABASE_DB_PASSWORD: "x" } }) } }],
    ["token citado no valor", { env: { X: "$SUPABASE_ACCESS_TOKEN" } }],
    ["URL do projeto real", { env: { API_URL: "https://abcdefgh.supabase.co" } }],
    ["pooler do projeto real", { env: { DB: "postgresql://u:p@aws-0-us-east-1.pooler.supabase.com:6543/postgres" } }],
    ["dominio supabase.in", { env: { API_URL: "https://abc.supabase.in" } }],
    ["--db-url num run", { jobs: { test: job([...baseSteps(), { run: "supabase start --db-url postgres://x" }]) } }],
    ["--linked num run", { jobs: { test: job([...baseSteps(), { run: "supabase status --linked" }]) } }],
    ["--project-ref no with", { jobs: { test: job([...baseSteps(), { uses: SETUP_SUPABASE, with: { version: "2.120.0", args: "--project-ref x" } }]) } }],
  ])("recusa marca do projeto real: %s", (_label, overrides) => {
    expect(rules(auditWorkflow(workflow(overrides)))).toContain("supabase_remoto@");
  });

  it("nao confunde nomes parecidos", () => {
    const doc = workflow({
      env: { SUPABASE_ACCESS_TOKENS_NOTE: "x", LINKED: "--linkedin", HOST: "x.supabase.company.example" },
      jobs: { test: job([...baseSteps(), { run: "echo nosupabase link\necho supabase-link" }]) },
    });
    expect(auditWorkflow(doc)).toEqual([]);
  });

  it("acha a marca na chave do env de um passo (dentro da lista de passos)", () => {
    const step = { run: "echo ok", env: { SUPABASE_ACCESS_TOKEN: "x" } };
    expect(rules(auditWorkflow(withStep(step)))).toEqual(["supabase_remoto@"]);
  });

  it("acha a marca dentro de listas", () => {
    const doc = workflow({ on: { push: { branches: ["x.supabase.co"] } } });
    expect(rules(auditWorkflow(doc))).toEqual(["supabase_remoto@"]);
  });

  it("expoe a lista de subcomandos congelada", () => {
    expect(WORKFLOW_POLICY.allowedSupabaseCommands).toEqual(["start", "status", "stop", "telemetry", "--version"]);
    expect(Object.isFrozen(WORKFLOW_POLICY.allowedSupabaseCommands)).toBe(true);
    expect(WORKFLOW_POLICY.allowedActions).toContain("supabase/setup-cli");
  });
});
