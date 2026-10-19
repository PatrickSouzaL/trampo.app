// Porta de telemetria (ADR-001 §5.9; ADR-010 D5 e D6). Eventos só com enums e números: nenhum texto livre,
// nenhum dado de perfil, nenhum id de usuário e nenhum reqId (métrica é agregado, não rastro). O schema
// estrito é a definição; o adapter valida cada evento com ele e descarta o que não casar.
import { LlmProviderIdSchema, PlatformSchema } from "@trampo/contracts";
import { z } from "zod";

import type { ExtractionFailureReason, RouterTrailEntry } from "../llm/llm-provider-router.js";
import type { LlmOutputRejection } from "../llm/llm-output-guard.js";

/** Limite da latência registrada: 10× o prazo da análise (ADR-009 D4). Acima disso é erro de medida. */
export const TELEMETRY_LATENCY_MAX_MS = 120_000;
/** Teto de passos da trilha: até 3 provedores (dev) com um retry cada. */
export const TELEMETRY_STEPS_MAX = 6;

const ExtractionFailureReasonSchema = z.enum([
  "timeout",
  "limite_de_taxa",
  "saida_invalida",
  "erro_provedor",
  "circuito_aberto",
  "cota_esgotada",
]);
const ExtractionOutcomeSchema = z.union([z.literal("ok"), ExtractionFailureReasonSchema]);
const LlmOutputRejectionSchema = z.enum(["resposta_grande_demais", "json_invalido", "poluicao_de_prototipo", "schema_invalido"]);
const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

export const LlmExtractionEventSchema = z.strictObject({
  kind: z.literal("llm_extraction"),
  platform: PlatformSchema,
  outcome: ExtractionOutcomeSchema,
  /** Quem respondeu ok; null na falha. */
  provider: LlmProviderIdSchema.nullable(),
  latencyMs: z.int().min(0).max(TELEMETRY_LATENCY_MAX_MS),
  /** Chamadas feitas (passos com `called`): no máximo 2 (ADR-009 D5). */
  llmCalls: z.int().min(0).max(2),
  inputTokens: count,
  outputTokens: count,
  steps: z
    .array(
      z.strictObject({
        provider: LlmProviderIdSchema,
        outcome: ExtractionOutcomeSchema,
        called: z.boolean(),
        guardRejection: LlmOutputRejectionSchema.optional(),
      }),
    )
    .max(TELEMETRY_STEPS_MAX),
});
export type LlmExtractionEvent = z.infer<typeof LlmExtractionEventSchema>;

/** União fechada: um tipo novo de evento entra por ADR. */
export const TelemetryEventSchema = LlmExtractionEventSchema;
export type TelemetryEvent = LlmExtractionEvent;

export interface Telemetry {
  /** Nunca lança: a contabilidade não pode derrubar uma análise. */
  record(event: TelemetryEvent): void;
}

// Os enums acima são cópias dos tipos do router e da guarda: a compilação quebra se divergirem.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameReason: Same<z.infer<typeof ExtractionFailureReasonSchema>, ExtractionFailureReason> = true;
const sameRejection: Same<z.infer<typeof LlmOutputRejectionSchema>, LlmOutputRejection> = true;
const sameStepKeys: Same<keyof LlmExtractionEvent["steps"][number], keyof RouterTrailEntry> = true;
const sameStepOutcome: Same<z.infer<typeof ExtractionOutcomeSchema>, RouterTrailEntry["outcome"]> = true;
void [sameReason, sameRejection, sameStepKeys, sameStepOutcome];
