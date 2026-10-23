// JobFactsCache (ADR-015; SR-08, T11): política de escrita condição por condição, SET NX, revalidação completa
// na leitura (adulteração vira miss com DEL), modelo obsoleto, prazos e falha como miss, nunca como hit.
import {
  BenefitCategorySchema,
  ContractTypeSchema,
  LanguageCodeSchema,
  RedFlagSignalSchema,
  SeniorityLevelSchema,
  WorkModelSchema,
} from "@trampo/contracts";
import { type JobFacts, JobFactsCacheEntrySchema } from "@trampo/contracts/job-facts";
import { describe, expect, test } from "vitest";

import {
  CACHE_KEY_PREFIX,
  CACHE_POLICY,
  CacheConfigError,
  JobFactsCache,
  LlmOutputGuard,
  extractorVersionTag,
  type AcceptedModel,
  type CacheStoreRead,
  type CacheWriteCandidate,
  type JobFactsCacheStore,
  type LlmOutputSanitization,
} from "../../src/application/index.js";
import { FakeClock } from "./fakes/fake-clock.js";
import { VALID_RAW } from "./fakes/router-harness.js";

const guard = new LlmOutputGuard();
const inspected = guard.inspect(VALID_RAW);
if (!inspected.ok) throw new Error("fixture inválida");
const CLEAN: JobFacts = inspected.facts;

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const VERSION = "jf-p1-s1-n1-sel1-g2-b6000";
const NOW = Date.parse("2026-10-21T18:00:00.000Z");
const GROQ: AcceptedModel = { provider: "groq", model: "openai/gpt-oss-20b" };
const CLOUDFLARE: AcceptedModel = { provider: "cloudflare_workers_ai", model: "openai/gpt-oss-120b" };
const OLLAMA: AcceptedModel = { provider: "ollama", model: "qwen3:8b" };
const NO_SANITIZATION: LlmOutputSanitization = {
  urlsRemoved: 0,
  hiddenOrMarkupRemoved: 0,
  malformedItemsRemoved: 0,
  duplicatesRemoved: 0,
  itemsCut: 0,
  textTruncated: false,
  injectionSignal: false,
};
const CANDIDATE: CacheWriteCandidate = {
  textHash: HASH,
  facts: CLEAN,
  sanitization: NO_SANITIZATION,
  injectionLevel: "baixa",
  effectiveConfidence: 0.9,
  degraded: false,
  provider: GROQ.provider,
  model: GROQ.model,
};
const KEY = `jobfacts:v1:${VERSION}:${HASH}`;

type Mode =
  | { readonly kind: "normal" | "indisponivel" | "lanca" | "rejeita" | "trava" }
  | { readonly kind: "lixo"; readonly value: unknown };

function act<T>(mode: Mode, normal: () => T, unavailable: T): Promise<T> {
  switch (mode.kind) {
    case "lanca":
      throw new Error("redis fora do ar");
    case "rejeita":
      return Promise.reject(new Error("redis fora do ar"));
    case "trava":
      return new Promise<T>(() => undefined);
    case "indisponivel":
      return Promise.resolve(unavailable);
    case "lixo":
      return Promise.resolve(mode.value as T);
    default:
      return Promise.resolve(normal());
  }
}

function harness(options: { models?: readonly AcceptedModel[]; now?: number } = {}) {
  const clock = new FakeClock();
  const wall = { now: options.now ?? NOW };
  const values = new Map<string, string>();
  const ttls = new Map<string, number>();
  const calls: string[] = [];
  const removed: string[] = [];
  const modes: { read: Mode; write: Mode; remove: Mode } = { read: { kind: "normal" }, write: { kind: "normal" }, remove: { kind: "normal" } };
  const store: JobFactsCacheStore = {
    read: (key) => {
      calls.push("read");
      return act<CacheStoreRead>(modes.read, () => ({ ok: true, value: values.get(key) ?? null }), { ok: false });
    },
    writeIfAbsent: (key, value, ttlSeconds) => {
      calls.push("write");
      return act(
        modes.write,
        () => {
          if (values.has(key)) return "ja_existia";
          values.set(key, value);
          ttls.set(key, ttlSeconds);
          return "gravado";
        },
        "indisponivel",
      );
    },
    remove: (key) => {
      calls.push("remove");
      removed.push(key);
      return act(modes.remove, () => void values.delete(key), undefined);
    },
  };
  const cache = new JobFactsCache({
    store,
    clock,
    now: () => wall.now,
    extractorVersion: VERSION,
    acceptedModels: options.models ?? [GROQ, CLOUDFLARE, OLLAMA],
  });
  const lookup = (hash = HASH) => clock.run(cache.lookup(hash));
  const save = (candidate: Partial<CacheWriteCandidate> = {}) => clock.run(cache.store({ ...CANDIDATE, ...candidate }));
  return { cache, clock, wall, values, ttls, calls, removed, modes, lookup, save };
}

/** Espera os DEL em melhor esforço. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Uma entrada válida, serializada, com campos trocados. */
function entry(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    extractorVersion: VERSION,
    textHash: HASH,
    provider: "groq",
    model: GROQ.model,
    extractedAt: new Date(NOW - 60_000).toISOString(),
    facts: CLEAN,
    ...patch,
  });
}

describe("configuração (ADR-015 D2 e D6)", () => {
  test("política fixada no ADR", () => {
    expect(CACHE_POLICY).toEqual({
      ttlSeconds: 864_000,
      minConfidence: 0.5,
      entryMaxChars: 16_384,
      lookupTimeoutMs: 150,
      storeTimeoutMs: 250,
      clockSkewMs: 300_000,
      maxAgeMarginMs: 86_400_000,
    });
    expect(CACHE_KEY_PREFIX).toBe("jobfacts:v1");
  });

  test("a versão do extrator junta prompt, schema, normalizador, seletor, guarda e orçamento", () => {
    expect(extractorVersionTag({ prompt: "p1", normalizer: "n1", selector: "sel1", guard: "g2", budgetChars: 6_000 })).toBe(VERSION);
  });

  test.each([
    ["prompt em maiúsculas", { prompt: "P1" }],
    ["prompt com espaço", { prompt: "p 1" }],
    ["tag longa demais", { prompt: "p".repeat(20) }],
    ["orçamento fracionário", { budgetChars: 6_000.5 }],
    ["orçamento negativo", { budgetChars: -1 }],
    ["orçamento zero", { budgetChars: 0 }],
  ])("%s: lança no boot", (_name, patch) => {
    expect(() => extractorVersionTag({ prompt: "p1", normalizer: "n1", selector: "sel1", guard: "g2", budgetChars: 6_000, ...patch })).toThrow(
      CacheConfigError,
    );
  });

  test.each([[""], ["JF-1"], ["x".repeat(33)], ["jf p1"]])("extractorVersion inválida (%j) derruba o construtor", (extractorVersion) => {
    const h = harness();
    expect(
      () => new JobFactsCache({ store: { read: () => Promise.resolve({ ok: false }), writeIfAbsent: () => Promise.resolve("indisponivel"), remove: () => Promise.resolve() }, clock: h.clock, now: () => NOW, extractorVersion, acceptedModels: [] }),
    ).toThrow(CacheConfigError);
  });

  test("a chave só tem versão e hash", () => {
    expect(harness().cache.keyFor(HASH)).toBe(KEY);
  });

  test("o schema limita a entrada bem abaixo do teto: o maior JobFacts possível cabe com folga", () => {
    const tag = (prefix: string, i: number) => `${prefix.repeat(37)}${String(i).padStart(3, "0")}`;
    const largest = JobFactsCacheEntrySchema.parse({
      schemaVersion: 1,
      extractorVersion: "x".repeat(32),
      textHash: HASH,
      provider: "cloudflare_workers_ai",
      model: `m${"x".repeat(79)}`,
      extractedAt: new Date(NOW).toISOString(),
      facts: {
        title: "𝐀".repeat(200),
        seniorityLevels: SeniorityLevelSchema.options.slice(0, 3),
        yearsExperienceMin: 40,
        workModels: WorkModelSchema.options.slice(0, 3),
        location: { city: "𝐀".repeat(80), stateUf: "SP", countryIso2: "BR" },
        salary: { min: 9_999_999.99, max: 10_000_000, currency: "BRL", period: "mes" },
        contractTypes: ContractTypeSchema.options.slice(0, 5),
        stackRequired: Array.from({ length: 30 }, (_, i) => tag("𝐀", i)),
        stackNiceToHave: Array.from({ length: 30 }, (_, i) => tag("𝐁", i)),
        benefits: [...BenefitCategorySchema.options],
        languageRequirements: LanguageCodeSchema.options.slice(0, 5).map((language) => ({ language, level: null, required: true })),
        redFlagSignals: [...RedFlagSignalSchema.options],
        extractionConfidence: 0.123456789,
      },
    });
    const size = JSON.stringify(largest).length;
    expect(size).toBeLessThan(CACHE_POLICY.entryMaxChars / 2);
  });
});

describe("escrita (SR-08): todas as condições, cada uma isolada, sem comando na recusa", () => {
  test("candidato limpo grava com SET NX EX de 10 dias, só com os campos estritos da entrada", async () => {
    const h = harness();
    await expect(h.save()).resolves.toEqual({ written: true });
    expect(h.ttls.get(KEY)).toBe(864_000);
    const stored = JSON.parse(h.values.get(KEY) ?? "null") as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["extractedAt", "extractorVersion", "facts", "model", "provider", "schemaVersion", "textHash"]);
    expect(stored).toMatchObject({ schemaVersion: 1, extractorVersion: VERSION, textHash: HASH, provider: "groq", model: GROQ.model, extractedAt: "2026-10-21T18:00:00.000Z" });
    expect(stored["facts"]).toEqual(CLEAN);
  });

  test("a segunda escrita não sobrescreve a primeira (ja_existia)", async () => {
    const h = harness();
    await h.save();
    const first = h.values.get(KEY);
    h.wall.now = NOW + 1_000;
    await expect(h.save({ provider: "cloudflare_workers_ai", model: CLOUDFLARE.model })).resolves.toEqual({ written: false, reason: "ja_existia" });
    expect(h.values.get(KEY)).toBe(first);
  });

  test.each<[string, Partial<CacheWriteCandidate>, string]>([
    ["análise degradada", { degraded: true }, "degradada"],
    ["injection média no texto", { injectionLevel: "media" }, "injecao_no_texto"],
    ["injection alta no texto", { injectionLevel: "alta" }, "injecao_no_texto"],
    ["guarda removeu URL ou oculto", { sanitization: { ...NO_SANITIZATION, urlsRemoved: 1, injectionSignal: true } }, "injecao_na_saida"],
    ["confiança 0,49", { effectiveConfidence: 0.49 }, "baixa_confianca"],
    ["confiança NaN", { effectiveConfidence: Number.NaN }, "baixa_confianca"],
    ["confiança infinita", { effectiveConfidence: Number.POSITIVE_INFINITY }, "baixa_confianca"],
    ["Ollama (dev), mesmo listado", { provider: "ollama", model: OLLAMA.model }, "provedor_nao_permitido"],
    ["Gemini", { provider: "google_ai_studio", model: "gemini-2.5-flash" }, "provedor_nao_permitido"],
    ["modelo fora da cadeia", { model: "openai/gpt-oss-120b" }, "provedor_nao_permitido"],
    ["provedor trocado com o modelo do outro", { provider: "cloudflare_workers_ai", model: GROQ.model }, "provedor_nao_permitido"],
    ["textHash em maiúsculas", { textHash: "A".repeat(64) }, "fatos_fora_do_contrato"],
    ["textHash curto", { textHash: "a".repeat(63) }, "fatos_fora_do_contrato"],
    ["fatos que a guarda mudaria (URL no título)", { facts: { ...CLEAN, title: "Dev https://golpe.example/x" } }, "fatos_fora_do_contrato"],
    ["fatos que a guarda mudaria (espaço duplo)", { facts: { ...CLEAN, title: "Dev  Pleno" } }, "fatos_fora_do_contrato"],
    ["fatos com campo a mais", { facts: { ...CLEAN, userId: "x" } as JobFacts }, "fatos_fora_do_contrato"],
    ["modelo fora do padrão do contrato", { model: "@CF/meta/llama" }, "provedor_nao_permitido"],
    ["id da Workers AI que não está na cadeia", { provider: "cloudflare_workers_ai", model: "@cf/meta/llama" }, "provedor_nao_permitido"],
  ])("%s → %s", async (_name, patch, reason) => {
    const h = harness();
    await expect(h.save(patch)).resolves.toEqual({ written: false, reason });
    expect(h.calls).toEqual([]);
  });

  test("confiança exatamente 0,5 grava; injection e degradação recusam mesmo com confiança 1", async () => {
    await expect(harness().save({ effectiveConfidence: 0.5 })).resolves.toEqual({ written: true });
    await expect(harness().save({ effectiveConfidence: 1, degraded: true })).resolves.toMatchObject({ written: false });
  });

  test("remoções que não são de injection (duplicata, corte) não impedem a escrita", async () => {
    const h = harness();
    await expect(h.save({ sanitization: { ...NO_SANITIZATION, duplicatesRemoved: 2, itemsCut: 1, textTruncated: true } })).resolves.toEqual({
      written: true,
    });
  });

  test.each(["x@cf/", "@CF/x", "@cf//x", "@cf/"])("modelo %j, que o contrato recusa: fatos_fora_do_contrato, mesmo aceito na cadeia", async (model) => {
    const h = harness({ models: [{ provider: "groq", model }] });
    await expect(h.save({ model })).resolves.toEqual({ written: false, reason: "fatos_fora_do_contrato" });
    expect(h.calls).toEqual([]);
  });

  test("id da Workers AI com @cf/ na cadeia: grava e a leitura devolve hit com o id exato (F1-LLM-02)", async () => {
    const workersAi: AcceptedModel = { provider: "cloudflare_workers_ai", model: "@cf/openai/gpt-oss-120b" };
    const h = harness({ models: [GROQ, workersAi] });
    await expect(h.save({ provider: workersAi.provider, model: workersAi.model })).resolves.toEqual({ written: true });
    await expect(h.lookup()).resolves.toMatchObject({ hit: true, entry: { provider: workersAi.provider, model: workersAi.model } });
  });

  test("dado do usuário pendurado no candidato nunca chega ao valor gravado", async () => {
    const h = harness();
    const canary = "canario-perfil-pretensao-15000";
    await h.save({ ...({ userId: canary, criteria: { salary: canary } } as object) });
    expect(h.values.get(KEY)).not.toContain(canary);
  });

  test.each<[string, Mode]>([
    ["indisponível", { kind: "indisponivel" }],
    ["que lança", { kind: "lanca" }],
    ["que rejeita", { kind: "rejeita" }],
    ["com resposta fora do contrato", { kind: "lixo", value: "talvez" }],
  ])("Redis %s → indisponivel", async (_name, mode) => {
    const h = harness();
    h.modes.write = mode;
    await expect(h.save()).resolves.toEqual({ written: false, reason: "indisponivel" });
  });

  test("Redis travado → indisponivel exatamente no prazo de 250 ms", async () => {
    const h = harness();
    h.modes.write = { kind: "trava" };
    const start = h.clock.nowMs();
    await expect(h.save()).resolves.toEqual({ written: false, reason: "indisponivel" });
    expect(h.clock.nowMs() - start).toBe(250);
    expect(h.clock.pendingTimers).toBe(0);
  });

  test("relógio de parede inválido → indisponivel, sem comando", async () => {
    const h = harness({ now: Number.NaN });
    await expect(h.save()).resolves.toEqual({ written: false, reason: "indisponivel" });
    expect(h.calls).toEqual([]);
  });
});

describe("leitura", () => {
  test("ida e volta: o que foi gravado volta como hit, igual", async () => {
    const h = harness();
    await h.save();
    const result = await h.lookup();
    expect(result).toEqual({
      hit: true,
      entry: { schemaVersion: 1, extractorVersion: VERSION, textHash: HASH, provider: "groq", model: GROQ.model, extractedAt: "2026-10-21T18:00:00.000Z", facts: CLEAN },
    });
    expect(h.removed).toEqual([]);
  });

  test("sem entrada → ausente", async () => {
    await expect(harness().lookup()).resolves.toEqual({ hit: false, reason: "ausente" });
  });

  test("textHash inválido → indisponivel sem tocar no Redis", async () => {
    const h = harness();
    await expect(h.lookup("zz")).resolves.toEqual({ hit: false, reason: "indisponivel" });
    expect(h.calls).toEqual([]);
  });

  test.each<[string, Mode]>([
    ["indisponível", { kind: "indisponivel" }],
    ["que lança", { kind: "lanca" }],
    ["que rejeita", { kind: "rejeita" }],
    ["com lixo", { kind: "lixo", value: { ok: "sim" } }],
    ["com lixo nulo", { kind: "lixo", value: null }],
  ])("Redis %s → miss indisponivel, sem DEL", async (_name, mode) => {
    const h = harness();
    await h.save();
    h.modes.read = mode;
    const result = await h.lookup();
    expect(result).toMatchObject({ hit: false });
    await settle();
    expect(h.removed).toEqual([]);
  });

  test("porta que diz ok: false mas traz um valor válido: nunca é hit", async () => {
    const h = harness();
    h.modes.read = { kind: "lixo", value: { ok: false, value: entry() } };
    await expect(h.lookup()).resolves.toEqual({ hit: false, reason: "indisponivel" });
  });

  test("Redis travado → indisponivel exatamente no prazo de 150 ms", async () => {
    const h = harness();
    h.modes.read = { kind: "trava" };
    const start = h.clock.nowMs();
    await expect(h.lookup()).resolves.toEqual({ hit: false, reason: "indisponivel" });
    expect(h.clock.nowMs() - start).toBe(150);
  });

  const FUTURE_LIMIT = NOW + CACHE_POLICY.clockSkewMs;
  const OLDEST = NOW - CACHE_POLICY.ttlSeconds * 1_000 - CACHE_POLICY.maxAgeMarginMs;
  test.each<[string, string]>([
    ["string acima do teto", `${entry()}${" ".repeat(CACHE_POLICY.entryMaxChars)}`],
    ["JSON inválido", "{"],
    ["JSON truncado", entry().slice(0, 100)],
    ["__proto__", entry({ __proto__: { admin: true } }).replace('"schemaVersion"', '"__proto__":{"x":1},"schemaVersion"')],
    ["__proto__ escapado", entry().replace('"schemaVersion"', '"\\u005f_proto__":{"x":1},"schemaVersion"')],
    ["constructor", entry().replace('"schemaVersion"', '"constructor":{"x":1},"schemaVersion"')],
    ["campo a mais", entry({ userId: "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f" })],
    ["schemaVersion 2", entry({ schemaVersion: 2 })],
    ["outra versão do extrator", entry({ extractorVersion: "jf-p0-s1-n1-sel1-g1-b6000" })],
    ["outro textHash", entry({ textHash: OTHER_HASH })],
    ["provedor Ollama (dev) no Redis", entry({ provider: "ollama", model: OLLAMA.model })],
    ["extractedAt no futuro além da tolerância", entry({ extractedAt: new Date(FUTURE_LIMIT + 1_000).toISOString() })],
    ["extractedAt velho demais", entry({ extractedAt: new Date(OLDEST - 1_000).toISOString() })],
    ["extractedAt fora do formato", entry({ extractedAt: "ontem" })],
    ["URL no título", entry({ facts: { ...CLEAN, title: "Vaga em https://golpe.example" } })],
    ["invisível numa tag", entry({ facts: { ...CLEAN, stackRequired: ["Type​Script"] } })],
    ["marcação no título", entry({ facts: { ...CLEAN, title: "<b>Dev</b>" } })],
    ["fatos que a guarda mudaria (espaço duplo)", entry({ facts: { ...CLEAN, title: "Dev  Pleno" } })],
    ["fatos com campo a mais", entry({ facts: { ...CLEAN, nota: 100 } })],
    ["array em vez de objeto", JSON.stringify([entry()])],
    ["número", "42"],
  ])("adulteração (%s) → corrompido, com DEL", async (_name, raw) => {
    const h = harness();
    h.values.set(KEY, raw);
    await expect(h.lookup()).resolves.toEqual({ hit: false, reason: "corrompido" });
    await settle();
    expect(h.removed).toEqual([KEY]);
  });

  test("limites de idade: exatamente na tolerância do futuro e no mais velho aceito ainda dão hit", async () => {
    for (const extractedAt of [FUTURE_LIMIT, OLDEST]) {
      const h = harness();
      h.values.set(KEY, entry({ extractedAt: new Date(extractedAt).toISOString() }));
      await expect(h.lookup()).resolves.toMatchObject({ hit: true });
    }
  });

  test("modelo que saiu da cadeia → obsoleto, com DEL (a próxima escrita volta a ser possível)", async () => {
    const h = harness({ models: [CLOUDFLARE] });
    h.values.set(KEY, entry());
    await expect(h.lookup()).resolves.toEqual({ hit: false, reason: "obsoleto" });
    await settle();
    expect(h.removed).toEqual([KEY]);
    await expect(h.save({ provider: CLOUDFLARE.provider, model: CLOUDFLARE.model })).resolves.toEqual({ written: true });
  });

  test("entrada de outro provedor de produção ainda na cadeia dá hit", async () => {
    const h = harness();
    h.values.set(KEY, entry({ provider: CLOUDFLARE.provider, model: CLOUDFLARE.model }));
    await expect(h.lookup()).resolves.toMatchObject({ hit: true, entry: { provider: "cloudflare_workers_ai" } });
  });

  test("DEL que falha é absorvido", async () => {
    for (const kind of ["rejeita", "lanca"] as const) {
      const h = harness();
      h.values.set(KEY, "{");
      h.modes.remove = { kind };
      await expect(h.lookup()).resolves.toEqual({ hit: false, reason: "corrompido" });
      await settle();
    }
  });

  test("relógio de parede inválido na leitura → indisponivel, sem DEL", async () => {
    const h = harness();
    h.values.set(KEY, entry());
    h.wall.now = -1;
    await expect(h.lookup()).resolves.toEqual({ hit: false, reason: "indisponivel" });
    await settle();
    expect(h.removed).toEqual([]);
  });
});
