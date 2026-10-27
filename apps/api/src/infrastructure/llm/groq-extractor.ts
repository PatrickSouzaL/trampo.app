// Adapter do Groq (ADR-022 D1 a D6 e D8), implementando a porta JobFactsExtractor do ADR-009 sem mudá-la.
//
// Devolve a resposta BRUTA: quem roda a guarda de saída é o router (ADR-009 D2). Sem logger e sem SDK. `call` nunca
// rejeita: toda falha vira um valor do enum da porta. O corpo de qualquer não-200 é cancelado sem leitura (SR-12):
// o `400 json_validate_failed` traz em `error.failed_generation` a saída do modelo sobre o texto da vaga, e ela
// nunca é lida. A chave de API só existe no objeto de cabeçalhos dentro do closure.
//
// Fora da cadeia de produção até o aceite do p3/g4 (spike-metrics §2.8, T28): o main.ts ainda não liga este adapter.
import { randomBytes } from "node:crypto";

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

/**
 * Modelo fixo no código, sem variável de ambiente (D1): todo modelo passa pelo gate do golden dataset (T28), então
 * trocar de modelo é mudança de código, com aceite. O `reasoning_effort` do corpo só vale para esta família.
 */
export const GROQ_MODEL = "openai/gpt-oss-20b";

/** URL fixa (D3). O construtor confere a URL montada byte a byte contra esta. */
export const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";

export const GROQ_POLICY = {
  /** Saída máxima medida de 704 tokens com o raciocínio (S-1); acima vira `finish_reason: "length"` (D4). */
  maxCompletionTokens: 1_024,
  temperature: 0,
  /** Teto do corpo enviado, em bytes UTF-8 (D4). Acima disso, nada sai. */
  maxRequestBytes: 48 * 1024,
  /** Teto da resposta, contado em bytes durante a leitura (D6). */
  maxResponseBytes: 32 * 1024,
  /** Teto de `choices[0].message.content`, em unidades UTF-16 (D6). */
  maxContentChars: 16 * 1024,
} as const;

const API_ORIGIN = "https://api.groq.com";
const CHAT_COMPLETIONS_PATH = "/openai/v1/chat/completions";
const API_KEY = /^gsk_[A-Za-z0-9_-]{20,200}$/;
/** Origem dos testes (D3): `http:` só no loopback, onde roda o Groq simulado. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `baseUrl` só existe nos testes: não há `GROQ_BASE_URL` (D3, D8). */
export type GroqConfigVariable = "GROQ_API_KEY" | "baseUrl";

/** Lança no boot (como o ADR-009 D7). A mensagem cita só o nome da variável, nunca o valor (D8). */
export class GroqConfigError extends Error {
  constructor(readonly variable: GroqConfigVariable) {
    super(`${variable} fora da forma esperada (ADR-022 D3 e D8)`);
    this.name = "GroqConfigError";
  }
}

export interface GroqExtractorConfig {
  readonly apiKey: string;
  /** Só para os testes. O main.ts não passa nenhum dos três; o `baseUrl` troca só a origem (D3). */
  readonly fetch?: typeof fetch;
  readonly randomNonce?: () => string;
  readonly baseUrl?: URL;
}

/**
 * Envelope de um 200 (D6), sem exigir chave extra: `id`, `x_groq`, `system_fingerprint` e `message.reasoning` são
 * tolerados e nunca copiados. `tool_calls` presente é recusado mesmo vazio (o corpo não manda `tools`).
 */
const ChoiceSchema = z.object({
  message: z.object({
    content: z.string().max(GROQ_POLICY.maxContentChars).nullable(),
    // `null` é a ausência no formato OpenAI; qualquer outro valor é chamada de ferramenta.
    tool_calls: z.null().optional(),
  }),
  finish_reason: z.string(),
});
const EnvelopeSchema = z.object({
  choices: z.tuple([ChoiceSchema], ChoiceSchema),
  usage: z.unknown().optional(),
});

/**
 * Origem conferida no boot (D3): sem caminho, query, fragment nem credencial; `https:` em qualquer host ou `http:`
 * só no loopback. A de produção é a constante `GROQ_CHAT_COMPLETIONS_URL`.
 */
function chatCompletionsUrl(baseUrl: URL | undefined): URL {
  const base = baseUrl ?? new URL(API_ORIGIN);
  const loopback = base.protocol === "http:" && LOOPBACK_HOSTS.has(base.hostname);
  // Caminho, query e fragment da base somem no `new URL` abaixo sem mudar o href: são conferidos aqui. A credencial
  // fica no href e não na origin, e cai na conferência byte a byte.
  const clean = base.pathname === "/" && base.search === "" && base.hash === "";
  if (!clean || (base.protocol !== "https:" && !loopback)) throw new GroqConfigError("baseUrl");
  const url = new URL(CHAT_COMPLETIONS_PATH, base);
  if (url.href !== `${base.origin}${CHAT_COMPLETIONS_PATH}`) throw new GroqConfigError("baseUrl");
  return url;
}

/** 200 com corpo já decodificado: só `finish_reason: "stop"` com `content` string é sucesso; o resto é permanente. */
function outcomeFor(text: string): ProviderCallOutcome {
  const envelope = parseEnvelope(text, EnvelopeSchema);
  if (envelope === null) return PERMANENT;
  const [choice] = envelope.choices;
  if (choice.finish_reason !== "stop" || choice.message.content === null) return PERMANENT;
  return { ok: true, raw: choice.message.content, usage: usageFrom(envelope.usage) };
}

export function createGroqExtractor(config: GroqExtractorConfig): JobFactsExtractor {
  if (!API_KEY.test(config.apiKey)) throw new GroqConfigError("GROQ_API_KEY");
  const url = chatCompletionsUrl(config.baseUrl);

  const headers = Object.freeze({
    authorization: `Bearer ${config.apiKey}`,
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
      // Lista fechada (SR-01): exatamente estas 7 chaves, sem `tools`, `stream`, `user` nem `n`. É o corpo medido no
      // aceite (`nao_estrito`), menos o teto de saída do spike.
      body = JSON.stringify({
        model: GROQ_MODEL,
        messages: built.messages,
        response_format: {
          type: "json_schema",
          json_schema: { name: "job_facts", strict: false, schema: EXTRACTION_RESPONSE_SCHEMA },
        },
        reasoning_effort: "low",
        include_reasoning: false,
        temperature: GROQ_POLICY.temperature,
        max_completion_tokens: GROQ_POLICY.maxCompletionTokens,
      });
    } catch {
      return PERMANENT;
    }
    if (Buffer.byteLength(body, "utf8") > GROQ_POLICY.maxRequestBytes) return PERMANENT;

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        // Não segue redirecionamento: segui-lo levaria a chave para outro host. O 3xx vira `erro_permanente` (D3).
        redirect: "manual",
        // O prazo vem do router, que já aplica o teto de 3 s do Groq (D5, D9).
        signal: AbortSignal.any([attempt.signal, AbortSignal.timeout(attempt.timeoutMs)]),
      });
      if (response.status !== 200) {
        // Inclusive o 400 `json_validate_failed`: o corpo traz `failed_generation`, que nunca é lido (D6).
        await response.body?.cancel().catch(() => undefined);
        return failureForStatus(response.status, response.headers.get("retry-after"));
      }
      if (response.body === null) return PERMANENT;
      const bytes = await readCapped(response.body, GROQ_POLICY.maxResponseBytes);
      if (bytes === null) return PERMANENT;
      const text = decodeUtf8(bytes);
      return text === null ? PERMANENT : outcomeFor(text);
    } catch {
      // Rede, aborto pelo signal ou pelo prazo, e erro ao ler o corpo (D6).
      return TRANSIENT;
    }
  }

  return Object.freeze({ provider: "groq" as const, model: GROQ_MODEL, call });
}
