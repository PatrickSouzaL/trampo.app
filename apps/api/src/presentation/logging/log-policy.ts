// Política de log da F1-OBS-01 (ADR-010; SR-12; threat-model T23).
//
// A lista fechada é imposta na ESCRITA FINAL: o hook `streamWrite` do pino recebe a linha JSON pronta e
// `enforceLogAllowlist` a reconstrói só com as chaves e formas permitidas. O hook é da raiz, então nenhum
// child logger, serializer de rota ou formatter consegue gravar um campo fora da tabela (D1). Os
// serializers só ESCOLHEM campos dos objetos do Fastify (D3); a mensagem sai de um catálogo (D2).
import type { FastifyServerOptions } from "fastify";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

/** Destino das linhas de log (stdout em produção; um coletor nos testes). */
export interface LogDestination {
  write(line: string): void;
}

/** O que `buildApp` aceita: só o nível e o destino. A política em si não é configurável. */
export interface LoggerConfig {
  readonly level?: LogLevel;
  readonly stream?: LogDestination;
}

/** Catálogo fechado de mensagens (ADR-010 D2). */
export const LOG_MESSAGES = [
  "requisicao_recebida",
  "requisicao_concluida",
  "requisicao_com_erro",
  "fluxo_encerrado_antes",
  "servidor_ouvindo",
  "erro_interno",
  "autenticacao_indisponivel",
  "limite_indisponivel",
  "cota_indisponivel",
  "encerrando",
  "mensagem_fora_do_catalogo",
  "linha_de_log_descartada",
] as const;
export type LogMessage = (typeof LOG_MESSAGES)[number];

/** Mensagens fixas do Fastify 5.12.7 traduzidas para o catálogo. As demais viram `mensagem_fora_do_catalogo`. */
const FASTIFY_MESSAGES: ReadonlyMap<string, LogMessage> = new Map([
  ["incoming request", "requisicao_recebida"],
  ["request completed", "requisicao_concluida"],
  ["request errored", "requisicao_com_erro"],
  ["stream closed prematurely", "fluxo_encerrado_antes"],
]);
/** `Server listening at <endereço>`: o endereço de bind também não sai. */
const LISTENING_PREFIX = "Server listening at ";

/** Nomes de erro do catálogo (ADR-010 D1). Qualquer outro vira `outro`. */
export const LOG_ERROR_TYPES = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "FastifyError",
  "ZodError",
  "AbortError",
  "RouterConfigError",
  "ProviderChainConfigError",
  "DependencyContractError",
] as const;

export const UNKNOWN_ROUTE = "rota_desconhecida";

/** Chaves que uma linha pode ter, nos níveis 1 e 2 (a tabela do ADR-010 D1). */
export const LOG_ALLOWLIST = {
  top: ["level", "time", "msg", "reqId", "req", "res", "err", "responseTime", "signal"],
  req: ["id", "method", "route"],
  res: ["statusCode"],
  err: ["type", "code", "statusCode"],
} as const;

/** Registro fixo para o que não é um objeto JSON (o pino sempre escreve um; isto é a última barreira). */
export const DISCARDED_LINE = `${JSON.stringify({ level: 50, msg: "linha_de_log_descartada" })}\n`;

const CATALOG: ReadonlySet<string> = new Set(LOG_MESSAGES);
const ERROR_TYPES: ReadonlySet<string> = new Set(LOG_ERROR_TYPES);
const LEVELS: ReadonlySet<unknown> = new Set([10, 20, 30, 40, 50, 60]);
const METHODS: ReadonlySet<unknown> = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const SIGNALS: ReadonlySet<unknown> = new Set(["SIGINT", "SIGTERM"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ERROR_CODE = /^(?:FST_ERR|ERR)_[A-Z0-9_]{1,60}$/;

type Fields = Record<string, unknown>;
type PinoOptions = Exclude<NonNullable<FastifyServerOptions["logger"]>, boolean>;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lê um campo de qualquer valor, sem confiar no tipo. */
function pick(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Fields)[key] : undefined;
}

function uuidOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && UUID.test(value) ? value : undefined;
}

function statusCodeOrUndefined(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599 ? (value as number) : undefined;
}

export function catalogMessage(raw: unknown): LogMessage {
  if (typeof raw !== "string") return "mensagem_fora_do_catalogo";
  if (CATALOG.has(raw)) return raw as LogMessage;
  const fastify = FASTIFY_MESSAGES.get(raw);
  if (fastify !== undefined) return fastify;
  return raw.startsWith(LISTENING_PREFIX) ? "servidor_ouvindo" : "mensagem_fora_do_catalogo";
}

function projectReq(value: unknown, knownRoutes: ReadonlySet<string>): Fields | undefined {
  if (!isFields(value)) return undefined;
  const id = uuidOrUndefined(value["id"]);
  const route = value["route"];
  return {
    ...(id === undefined ? {} : { id }),
    method: METHODS.has(value["method"]) ? value["method"] : "OUTRO",
    route: typeof route === "string" && knownRoutes.has(route) ? route : UNKNOWN_ROUTE,
  };
}

function projectRes(value: unknown): Fields | undefined {
  if (!isFields(value)) return undefined;
  const statusCode = statusCodeOrUndefined(value["statusCode"]);
  return statusCode === undefined ? {} : { statusCode };
}

function projectErr(value: unknown): Fields | undefined {
  if (!isFields(value)) return undefined;
  const type = value["type"];
  const code = value["code"];
  const statusCode = statusCodeOrUndefined(value["statusCode"]);
  return {
    type: typeof type === "string" && ERROR_TYPES.has(type) ? type : "outro",
    ...(typeof code === "string" && ERROR_CODE.test(code) ? { code } : {}),
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

/**
 * Reconstrói uma linha de log só com as chaves e formas do ADR-010 D1. Chave fora da lista ou valor com
 * forma errada é descartado; o que não é um objeto JSON vira `DISCARDED_LINE`. Nunca lança.
 */
export function enforceLogAllowlist(line: string, knownRoutes: ReadonlySet<string>): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return DISCARDED_LINE;
  }
  if (!isFields(parsed)) return DISCARDED_LINE;

  const out: Fields = {};
  if (LEVELS.has(parsed["level"])) out["level"] = parsed["level"];
  const time = parsed["time"];
  if (Number.isSafeInteger(time) && (time as number) >= 0) out["time"] = time;
  out["msg"] = catalogMessage(parsed["msg"]);
  const reqId = uuidOrUndefined(parsed["reqId"]);
  if (reqId !== undefined) out["reqId"] = reqId;
  const req = projectReq(parsed["req"], knownRoutes);
  if (req !== undefined) out["req"] = req;
  const res = projectRes(parsed["res"]);
  if (res !== undefined) out["res"] = res;
  const err = projectErr(parsed["err"]);
  if (err !== undefined) out["err"] = err;
  const responseTime = parsed["responseTime"];
  const roundedTime = typeof responseTime === "number" && responseTime >= 0 ? Math.round(responseTime) : Number.NaN;
  if (Number.isSafeInteger(roundedTime)) out["responseTime"] = roundedTime;
  if (SIGNALS.has(parsed["signal"])) out["signal"] = parsed["signal"];
  return `${JSON.stringify(out)}\n`;
}

/**
 * Serializers que só escolhem campos (ADR-010 D3). Substituem os padrões do Fastify (url com query, host,
 * remoteAddress, remotePort) e do pino (message, stack). Nenhum cabeçalho é escolhido.
 */
export const LOG_SERIALIZERS = {
  req: (req: unknown) => ({ id: pick(req, "id"), method: pick(req, "method"), route: pick(pick(req, "routeOptions"), "url") }),
  res: (res: unknown) => ({ statusCode: pick(res, "statusCode") }),
  err: (err: unknown) => ({ type: pick(err, "name"), code: pick(err, "code"), statusCode: pick(err, "statusCode") }),
};

/**
 * Opções do pino para o Fastify. `knownRoutes` é o conjunto fechado de rotas registradas (alimentado pelo
 * `onRoute` do buildApp): a rota só aparece no log se estiver nele.
 */
export function createLoggerOptions(config: LoggerConfig, knownRoutes: ReadonlySet<string>): PinoOptions {
  return {
    // Sem `base: null`: hostname e pid já caem na allowlist do streamWrite (seria código equivalente).
    level: config.level ?? "info",
    // Os tipos do Fastify prometem um FastifyRequest; em runtime o valor pode ser qualquer coisa, e os
    // serializers aceitam `unknown` de propósito.
    serializers: LOG_SERIALIZERS as unknown as NonNullable<PinoOptions["serializers"]>,
    hooks: { streamWrite: (line: string) => enforceLogAllowlist(line, knownRoutes) },
    ...(config.stream === undefined ? {} : { stream: config.stream }),
  };
}
