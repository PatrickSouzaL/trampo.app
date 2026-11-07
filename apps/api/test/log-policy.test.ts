// F1-OBS-01 (ADR-010 D1 a D3): a lista fechada imposta na escrita final, o catálogo de mensagens e os
// serializers que só escolhem campos. O oráculo é um schema Zod estrito escrito a partir da tabela do ADR,
// independente da implementação.
import fc from "fast-check";
import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  DISCARDED_LINE,
  LOG_ALLOWLIST,
  LOG_ERROR_TYPES,
  LOG_MESSAGES,
  LOG_SERIALIZERS,
  UNKNOWN_ROUTE,
  catalogMessage,
  createLoggerOptions,
  enforceLogAllowlist,
} from "../src/presentation/logging/log-policy.js";

const ROUTES: ReadonlySet<string> = new Set(["/health", "/v1/analyses"]);
const UUID_A = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
const CANARY = "zz-canario-7f3a-zz";

const statusCode = z.int().min(100).max(599);
/** A tabela do ADR-010 D1, transcrita à mão. */
const LogLineSchema = z.strictObject({
  level: z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(40), z.literal(50), z.literal(60)]).optional(),
  time: z.int().min(0).optional(),
  msg: z.enum(LOG_MESSAGES),
  reqId: z.uuidv4().optional(),
  req: z
    .strictObject({
      id: z.uuidv4().optional(),
      method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OUTRO"]),
      route: z.union([z.enum(["/health", "/v1/analyses"]), z.literal(UNKNOWN_ROUTE)]),
    })
    .optional(),
  res: z.strictObject({ statusCode: statusCode.optional() }).optional(),
  err: z
    .strictObject({
      type: z.union([z.enum(LOG_ERROR_TYPES), z.literal("outro")]),
      code: z.string().regex(/^(?:FST_ERR|ERR)_[A-Z0-9_]{1,60}$/).optional(),
      statusCode: statusCode.optional(),
    })
    .optional(),
  responseTime: z.int().min(0).optional(),
  signal: z.enum(["SIGINT", "SIGTERM"]).optional(),
  suprimidas: z.int().min(0).optional(),
});

type LogLine = Partial<Record<(typeof LOG_ALLOWLIST.top)[number], unknown>>;

function enforce(record: unknown): LogLine {
  const line = enforceLogAllowlist(JSON.stringify(record), ROUTES);
  expect(line.endsWith("\n")).toBe(true);
  return JSON.parse(line) as LogLine;
}

describe("enforceLogAllowlist: tabela do ADR-010 D1", () => {
  test("a allowlist exportada é a do ADR (trava contra crescimento silencioso)", () => {
    expect(LOG_ALLOWLIST).toEqual({
      top: ["level", "time", "msg", "reqId", "req", "res", "err", "responseTime", "signal", "suprimidas"],
      req: ["id", "method", "route"],
      res: ["statusCode"],
      err: ["type", "code", "statusCode"],
    });
    expect(Object.keys(LogLineSchema.shape)).toEqual(LOG_ALLOWLIST.top);
  });

  test("registro completo e válido passa intacto (exceto o arredondamento de responseTime)", () => {
    const out = enforce({
      level: 30,
      time: 1_760_000_000_000,
      msg: "requisicao_concluida",
      reqId: UUID_A,
      req: { id: UUID_A, method: "POST", route: "/v1/analyses" },
      res: { statusCode: 200 },
      err: { type: "ZodError", code: "FST_ERR_VALIDATION", statusCode: 400 },
      responseTime: 12.6,
      signal: "SIGTERM",
      suprimidas: 999,
    });
    expect(out).toEqual({
      level: 30,
      time: 1_760_000_000_000,
      msg: "requisicao_concluida",
      reqId: UUID_A,
      req: { id: UUID_A, method: "POST", route: "/v1/analyses" },
      res: { statusCode: 200 },
      err: { type: "ZodError", code: "FST_ERR_VALIDATION", statusCode: 400 },
      responseTime: 13,
      signal: "SIGTERM",
      suprimidas: 999,
    });
  });

  test("chaves fora da lista somem, inclusive headers, body, url, IP, hostname e pid", () => {
    const out = enforce({
      level: 30,
      msg: "requisicao_recebida",
      headers: { authorization: `Bearer ${CANARY}` },
      authorization: CANARY,
      cookie: CANARY,
      body: { jobText: CANARY },
      url: `/v1?q=${CANARY}`,
      remoteAddress: "203.0.113.9",
      ip: "203.0.113.9",
      hostname: "maquina",
      pid: 4242,
      req: { id: UUID_A, method: "GET", route: "/health", headers: { cookie: CANARY }, url: CANARY },
      res: { statusCode: 200, headers: { "set-cookie": CANARY } },
      err: { type: "Error", message: CANARY, stack: CANARY },
    });
    expect(out).toEqual({
      level: 30,
      msg: "requisicao_recebida",
      req: { id: UUID_A, method: "GET", route: "/health" },
      res: { statusCode: 200 },
      err: { type: "Error" },
    });
  });

  test("__proto__ e constructor literais na linha não passam nem poluem o protótipo", () => {
    const line = `{"__proto__":{"level":30,"polluted":"${CANARY}"},"constructor":{"prototype":{"x":1}},"msg":"encerrando"}`;
    expect(enforceLogAllowlist(line, ROUTES)).toBe('{"msg":"encerrando"}\n');
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  test("o que não é objeto JSON vira o registro fixo de descarte", () => {
    for (const line of ["", "nao json", "[1,2]", "null", "42", '"texto"', "{", `${CANARY}`]) {
      expect(enforceLogAllowlist(line, ROUTES)).toBe(DISCARDED_LINE);
    }
    expect(JSON.parse(DISCARDED_LINE)).toEqual({ level: 50, msg: "linha_de_log_descartada" });
  });

  test("level fora de 10..60 em passos de 10 é descartado", () => {
    for (const level of [0, 35, 70, "30", null, 30.5]) expect(enforce({ level, msg: "encerrando" })).not.toHaveProperty("level");
    for (const level of [10, 20, 30, 40, 50, 60]) expect(enforce({ level }).level).toBe(level);
  });

  test("time só como inteiro seguro e não negativo", () => {
    for (const time of [-1, 1.5, "1", null, 2 ** 53]) expect(enforce({ time })).not.toHaveProperty("time");
    expect(enforce({ time: 0 }).time).toBe(0);
  });

  test("reqId só como UUID v4 minúsculo", () => {
    for (const reqId of [CANARY, UUID_A.toUpperCase(), `${UUID_A}x`, `x${UUID_A}`, "3f2b8c1e-9a4d-1e6f-8b7a-1c2d3e4f5a6b", 1]) {
      expect(enforce({ reqId })).not.toHaveProperty("reqId");
    }
    expect(enforce({ reqId: UUID_A }).reqId).toBe(UUID_A);
  });

  test("req: método fora da lista vira OUTRO; rota não registrada vira rota_desconhecida; id inválido some", () => {
    expect(enforce({ req: { id: CANARY, method: "TRACE", route: `/v1/analyses?q=${CANARY}` } }).req).toEqual({
      method: "OUTRO",
      route: UNKNOWN_ROUTE,
    });
    expect(enforce({ req: { method: "get", route: 1 } }).req).toEqual({ method: "OUTRO", route: UNKNOWN_ROUTE });
    expect(enforce({ req: {} }).req).toEqual({ method: "OUTRO", route: UNKNOWN_ROUTE });
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(enforce({ req: { method, route: "/health" } }).req).toEqual({ method, route: "/health" });
    }
  });

  test("req, res e err que não são objeto (inclusive array) somem", () => {
    for (const value of [[], [{ statusCode: 200 }], "x", 1, null, true]) {
      const out = enforce({ req: value, res: value, err: value });
      expect(out).not.toHaveProperty("req");
      expect(out).not.toHaveProperty("res");
      expect(out).not.toHaveProperty("err");
    }
  });

  test("statusCode só como inteiro em 100..599", () => {
    for (const s of [99, 600, 200.5, "200", null]) {
      expect(enforce({ res: { statusCode: s } }).res).toEqual({});
      expect(enforce({ err: { statusCode: s } }).err).toEqual({ type: "outro" });
    }
    for (const s of [100, 599]) expect(enforce({ res: { statusCode: s } }).res).toEqual({ statusCode: s });
  });

  test("err: tipo fora do catálogo vira outro; code só no padrão FST_ERR_/ERR_", () => {
    expect(enforce({ err: { type: CANARY, code: CANARY } }).err).toEqual({ type: "outro" });
    expect(enforce({ err: { type: 1, code: 1 } }).err).toEqual({ type: "outro" });
    for (const code of ["FST_ERR", "ERR_", "ERR_abc", "XERR_A", `ERR_${"A".repeat(61)}`, "ERR_A\n"]) {
      expect(enforce({ err: { code } }).err).toEqual({ type: "outro" });
    }
    expect(enforce({ err: { code: `ERR_${"A".repeat(60)}` } }).err).toEqual({ type: "outro", code: `ERR_${"A".repeat(60)}` });
    for (const type of LOG_ERROR_TYPES) expect(enforce({ err: { type } }).err).toEqual({ type });
  });

  test("responseTime: número finito e não negativo, arredondado", () => {
    for (const responseTime of [-0.1, "5", null]) expect(enforce({ responseTime })).not.toHaveProperty("responseTime");
    // JSON.parse("1e999") dá Infinity: a única forma de um não finito chegar.
    expect(JSON.parse(enforceLogAllowlist('{"responseTime":1e999}', ROUTES))).not.toHaveProperty("responseTime");
    expect(enforce({ responseTime: 0 }).responseTime).toBe(0);
    expect(enforce({ responseTime: 2.4 }).responseTime).toBe(2);
    // Achado da propriedade: 2^53 arredondado não é inteiro seguro.
    expect(enforce({ responseTime: 2 ** 53 })).not.toHaveProperty("responseTime");
    expect(enforce({ responseTime: Number.MAX_SAFE_INTEGER }).responseTime).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("suprimidas só inteiro seguro >= 0 (o contador das linhas amostradas do BFF, ADR-004 D8 item 7)", () => {
    for (const suprimidas of [-1, 1.5, "3", CANARY, null, [1], { n: 1 }, Number.MAX_SAFE_INTEGER + 1]) {
      expect(enforce({ msg: "auth_limite_local", suprimidas })).not.toHaveProperty("suprimidas");
    }
    expect(enforce({ msg: "auth_limite_local", suprimidas: 0 }).suprimidas).toBe(0);
    expect(enforce({ msg: "auth_limite_local", suprimidas: Number.MAX_SAFE_INTEGER }).suprimidas).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("signal só SIGINT ou SIGTERM", () => {
    for (const signal of ["SIGKILL", CANARY, 2]) expect(enforce({ signal })).not.toHaveProperty("signal");
    expect(enforce({ signal: "SIGINT" }).signal).toBe("SIGINT");
  });
});

describe("catalogMessage: ADR-010 D2", () => {
  test("valores do catálogo passam", () => {
    for (const m of LOG_MESSAGES) expect(catalogMessage(m)).toBe(m);
  });

  test("mensagens fixas do Fastify viram enums do catálogo", () => {
    expect(catalogMessage("incoming request")).toBe("requisicao_recebida");
    expect(catalogMessage("request completed")).toBe("requisicao_concluida");
    expect(catalogMessage("request errored")).toBe("requisicao_com_erro");
    expect(catalogMessage("stream closed prematurely")).toBe("fluxo_encerrado_antes");
    expect(catalogMessage("Server listening at http://10.0.0.7:3001")).toBe("servidor_ouvindo");
  });

  test("qualquer outra coisa vira mensagem_fora_do_catalogo (URL com query, err.message, interpolação)", () => {
    for (const m of [
      `Route GET:/v1?token=${CANARY} not found`,
      `Reply was already sent, did you forget to "return reply" in the "/x?q=${CANARY}" (GET) route?`,
      CANARY,
      "",
      "Server listening at",
      "x Server listening at http://10.0.0.7:3001",
      " incoming request",
      undefined,
      null,
      42,
      { msg: "encerrando" },
    ]) {
      expect(catalogMessage(m)).toBe("mensagem_fora_do_catalogo");
    }
  });

  test("a linha sempre ganha msg, mesmo sem msg na entrada", () => {
    expect(enforce({})).toEqual({ msg: "mensagem_fora_do_catalogo" });
  });
});

describe("LOG_SERIALIZERS: só escolhem campos (ADR-010 D3)", () => {
  test("req escolhe id, method e routeOptions.url; nada de url, headers, ip, host ou socket", () => {
    const req = {
      id: UUID_A,
      method: "POST",
      url: `/v1/analyses?q=${CANARY}`,
      ip: "203.0.113.9",
      host: "api.exemplo",
      headers: { authorization: CANARY, cookie: CANARY },
      socket: { remoteAddress: "203.0.113.9", remotePort: 5555 },
      body: { jobText: CANARY },
      routeOptions: { url: "/v1/analyses", config: { segredo: CANARY } },
    };
    expect(LOG_SERIALIZERS.req(req)).toEqual({ id: UUID_A, method: "POST", route: "/v1/analyses" });
  });

  test("res escolhe statusCode; err escolhe name, code e statusCode (sem message e sem stack)", () => {
    expect(LOG_SERIALIZERS.res({ statusCode: 201, getHeaders: () => ({ "set-cookie": CANARY }) })).toEqual({ statusCode: 201 });
    const err = Object.assign(new TypeError(CANARY), { code: "ERR_X", statusCode: 500, input: CANARY });
    expect(LOG_SERIALIZERS.err(err)).toEqual({ type: "TypeError", code: "ERR_X", statusCode: 500 });
  });

  test("para qualquer entrada, nunca lançam e só devolvem as chaves da lista", () => {
    fc.assert(
      fc.property(fc.anything({ withNullPrototype: true, withObjectString: true }), (value) => {
        expect(Object.keys(LOG_SERIALIZERS.req(value))).toEqual(LOG_ALLOWLIST.req);
        expect(Object.keys(LOG_SERIALIZERS.res(value))).toEqual(LOG_ALLOWLIST.res);
        expect(Object.keys(LOG_SERIALIZERS.err(value))).toEqual(LOG_ALLOWLIST.err);
      }),
      { numRuns: 1_000 },
    );
  });
});

describe("createLoggerOptions", () => {
  test("nível padrão info, serializers e hook da política; stream só se dado", () => {
    const options = createLoggerOptions({}, ROUTES) as Record<string, unknown>;
    expect(options["level"]).toBe("info");
    expect(options["serializers"]).toBe(LOG_SERIALIZERS);
    expect(options).not.toHaveProperty("stream");
    const stream = { write: () => undefined };
    const custom = createLoggerOptions({ level: "warn", stream }, ROUTES) as Record<string, unknown>;
    expect(custom["level"]).toBe("warn");
    expect(custom["stream"]).toBe(stream);
    const hooks = custom["hooks"] as { streamWrite: (line: string) => string };
    expect(hooks.streamWrite('{"msg":"encerrando","url":"/x"}')).toBe('{"msg":"encerrando"}\n');
  });
});

// Propriedade (SR-12): para QUALQUER entrada, a saída só tem chaves e formas da tabela e nunca contém o
// canário. As entradas misturam chaves arbitrárias com as chaves da lista e valores válidos com lixo.
const validLeaf = fc.constantFrom<unknown>(30, 0, 200, 599, 12.5, "GET", "POST", "/health", UUID_A, "TypeError", "FST_ERR_X", "SIGINT", "encerrando", "incoming request");
const leaf = fc.oneof(
  fc.string().map((s) => `${s}${CANARY}`),
  fc.string({ unit: "binary" }).map((s) => `${CANARY}${s}`),
  fc.integer(),
  fc.double(),
  fc.boolean(),
  fc.constant(null),
  validLeaf,
);
const key = fc.oneof(
  fc.constantFrom(...LOG_ALLOWLIST.top, ...LOG_ALLOWLIST.req, ...LOG_ALLOWLIST.err, "__proto__", "constructor", "headers", "authorization", "cookie", "message", "stack"),
  fc.string(),
);
const { json } = fc.letrec<{ json: unknown }>((tie) => ({
  json: fc.oneof({ depthSize: "small" }, leaf, fc.array(tie("json"), { maxLength: 4 }), fc.dictionary(key, tie("json"), { maxKeys: 6 })),
}));
const record = fc.dictionary(key, json, { maxKeys: 12 });

describe("propriedade: a saída só tem chaves da allowlist (SR-12)", () => {
  test("qualquer objeto JSON", () => {
    fc.assert(
      fc.property(record, (input) => {
        const out = enforceLogAllowlist(JSON.stringify(input), ROUTES);
        expect(out).not.toContain(CANARY);
        LogLineSchema.parse(JSON.parse(out));
      }),
      { numRuns: 1_000 },
    );
  });

  test("qualquer string", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string({ unit: "binary" }), fc.json()), (line) => {
        const out = enforceLogAllowlist(line, ROUTES);
        expect(out.endsWith("\n")).toBe(true);
        LogLineSchema.parse(JSON.parse(out));
      }),
      { numRuns: 1_000 },
    );
  });
});
