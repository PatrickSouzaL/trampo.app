// Adapter da Cloudflare Workers AI (ADR-020 D2 a D8), implementando a porta JobFactsExtractor do ADR-009 sem mudá-la.
//
// Devolve a resposta BRUTA: quem roda a guarda de saída é o router (ADR-009 D2). Sem logger e sem SDK. `call` nunca
// rejeita: toda falha vira um valor do enum da porta. O corpo de erro do provedor nunca é lido (SR-12): a Cloudflare
// pode ecoar o id, a conta ou um trecho da entrada. O token só existe no objeto de cabeçalhos dentro do closure.
//
// Fora da cadeia de produção até o gate do S-1 (ADR-020 D10, T28): o main.ts ainda não liga este adapter.
import { randomBytes } from "node:crypto";

import { JobFactsCacheEntrySchema } from "@trampo/contracts/job-facts";
import { z } from "zod";

import { EXTRACTION_RESPONSE_SCHEMA, buildExtractionMessages } from "../../application/llm/extraction-prompt.js";
import type {
  AttemptControl,
  JobFactsExtractor,
  LlmJobPayload,
  ProviderCallOutcome,
} from "../../application/ports/job-facts-extractor.js";

import {
  PERMANENT_FAILURE as PERMANENT,
  TRANSIENT_FAILURE as TRANSIENT,
  decodeUtf8,
  failureForStatus,
  parseEnvelope,
  readCapped,
  usageFrom,
} from "./llm-http.js";

/** Modelo provisório (ADR-020 D10): o único modelo de chat ativo na lista oficial do modo JSON. Decisão final no S-1. */
export const WORKERS_AI_DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export const WORKERS_AI_POLICY = {
  /** O padrão do modelo (256) truncaria o JSON; hipótese de ~450 tokens de saída (ADR-020 D4). Calibrar no S-1. */
  maxOutputTokens: 600,
  temperature: 0,
  /** Teto do corpo enviado, em bytes UTF-8 (D4). Acima disso, nada sai. */
  maxRequestBytes: 48 * 1024,
  /** Teto da resposta, contado em bytes durante a leitura (D6). */
  maxResponseBytes: 32 * 1024,
  /** Teto de `result.response` quando vem como string, em unidades UTF-16 (D6). */
  maxResponseTextChars: 16 * 1024,
} as const;

const API_ORIGIN = "https://api.cloudflare.com";
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const API_TOKEN = /^[A-Za-z0-9_-]{40,200}$/;
/**
 * Segmento do id depois do `@cf` (D3). O 1º caractere não pode ser `.`, então `.` e `..` caem aqui; `%`, `?`, `#`,
 * `\`, `@`, `/` e espaço estão fora do conjunto, e o segmento vazio (`@cf//x`) também.
 */
const MODEL_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

export type WorkersAiConfigVariable = "CLOUDFLARE_ACCOUNT_ID" | "CLOUDFLARE_API_TOKEN" | "CLOUDFLARE_WORKERS_AI_MODEL";

/** Lança no boot (como o ADR-009 D7). A mensagem cita só o nome da variável, nunca o valor (D8). */
export class WorkersAiConfigError extends Error {
  constructor(readonly variable: WorkersAiConfigVariable) {
    super(`${variable} fora da forma esperada (ADR-020 D3 e D8)`);
    this.name = "WorkersAiConfigError";
  }
}

export interface WorkersAiExtractorConfig {
  readonly accountId: string;
  readonly apiToken: string;
  readonly model: string;
  /** Só para os testes. O main.ts não passa nenhum dos três. */
  readonly fetch?: typeof fetch;
  readonly randomNonce?: () => string;
  readonly baseUrl?: URL;
}

/**
 * Envelope `{ result: { response, usage? }, success }` (D6), sem exigir chaves extras. `response` é string (a
 * referência da API) ou objeto (o exemplo do modo JSON). O formato OpenAI (`choices[]`) não tem `result.response`.
 */
const EnvelopeSchema = z.object({
  success: z.literal(true),
  result: z.object({
    response: z.union([z.string().max(WORKERS_AI_POLICY.maxResponseTextChars), z.looseObject({})]),
    usage: z.unknown().optional(),
  }),
});

/** `@cf/<segmento>/…`: o contrato do cache primeiro (ADR-015 §5), depois cada segmento (D3). */
function isValidModelId(model: string): boolean {
  if (!JobFactsCacheEntrySchema.shape.model.safeParse(model).success) return false;
  const [prefix, ...rest] = model.split("/");
  return prefix === "@cf" && rest.length > 0 && rest.every((segment) => MODEL_SEGMENT.test(segment));
}

/** 200 com corpo já decodificado: envelope válido dá a resposta bruta; o resto é permanente. */
function outcomeFor(text: string): ProviderCallOutcome {
  const envelope = parseEnvelope(text, EnvelopeSchema);
  if (envelope === null) return PERMANENT;
  const { response, usage } = envelope.result;
  return {
    ok: true,
    // Objeto (exemplo do modo JSON): volta a ser texto, e a guarda do router parseia de novo, com o teto de 8 KiB.
    raw: typeof response === "string" ? response : JSON.stringify(response),
    usage: usageFrom(usage),
  };
}

export function createCloudflareWorkersAiExtractor(config: WorkersAiExtractorConfig): JobFactsExtractor {
  if (!ACCOUNT_ID.test(config.accountId)) throw new WorkersAiConfigError("CLOUDFLARE_ACCOUNT_ID");
  if (!API_TOKEN.test(config.apiToken)) throw new WorkersAiConfigError("CLOUDFLARE_API_TOKEN");
  if (!isValidModelId(config.model)) throw new WorkersAiConfigError("CLOUDFLARE_WORKERS_AI_MODEL");

  // Segmentos já validados e sem codificar (o formato do exemplo oficial). A URL montada é conferida byte a byte:
  // qualquer normalização do parser (`.`, `..`, `%2e`) ou credencial na base derruba o boot (D3).
  const base = config.baseUrl ?? new URL(API_ORIGIN);
  const path = `/client/v4/accounts/${config.accountId}/ai/run/${config.model}`;
  const url = new URL(path, base);
  if (url.href !== `${base.origin}${path}`) throw new WorkersAiConfigError("CLOUDFLARE_WORKERS_AI_MODEL");

  const headers = Object.freeze({
    authorization: `Bearer ${config.apiToken}`,
    "content-type": "application/json",
    accept: "application/json",
  });
  const fetchImpl = config.fetch ?? fetch;
  const randomNonce = config.randomNonce ?? (() => randomBytes(16).toString("hex"));

  async function call(payload: LlmJobPayload, attempt: AttemptControl): Promise<ProviderCallOutcome> {
    let body: string;
    try {
      const built = buildExtractionMessages(payload, randomNonce());
      if (!built.ok) return PERMANENT;
      // Lista fechada (SR-01): exatamente estas 4 chaves. As mensagens do p1 já saem congeladas, só com `role` e
      // `content` (provado no teste do prompt e no teste do corpo exato daqui).
      body = JSON.stringify({
        messages: built.messages,
        response_format: { type: "json_schema", json_schema: EXTRACTION_RESPONSE_SCHEMA },
        max_tokens: WORKERS_AI_POLICY.maxOutputTokens,
        temperature: WORKERS_AI_POLICY.temperature,
      });
    } catch {
      return PERMANENT;
    }
    if (Buffer.byteLength(body, "utf8") > WORKERS_AI_POLICY.maxRequestBytes) return PERMANENT;

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        // Não segue redirecionamento: segui-lo levaria o token para outro host. O 3xx vira `erro_permanente` (D6).
        redirect: "manual",
        signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(attempt.timeoutMs)]),
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        return failureForStatus(response.status, response.headers.get("retry-after"));
      }
      if (response.body === null) return PERMANENT;
      const bytes = await readCapped(response.body, WORKERS_AI_POLICY.maxResponseBytes);
      if (bytes === null) return PERMANENT;
      const text = decodeUtf8(bytes);
      return text === null ? PERMANENT : outcomeFor(text);
    } catch {
      // Rede, aborto pelo signal ou pelo prazo, e erro ao ler o corpo (D6).
      return TRANSIENT;
    }
  }

  return Object.freeze({ provider: "cloudflare_workers_ai" as const, model: config.model, call });
}
