// Cadeia de provedores vinda do LLM_PROVIDER_CHAIN, validada no boot (ADR-009 D7). Falha fechado e cedo:
// o Gemini gratuito está fora nas Fases 0 e 1 (HITL-012), e o Ollama só entra em dev e evals.
import { type LlmProviderId, LlmProviderIdSchema } from "@trampo/contracts";
import { z } from "zod";

/** Provedores que podem ir para produção nas Fases 0 e 1, na ordem de menor exposição (ADR-001 §5.5). */
export const PRODUCTION_PROVIDERS: readonly LlmProviderId[] = ["groq", "cloudflare_workers_ai"];
/** Só dev e evals: o modelo roda na própria máquina. */
export const DEV_ONLY_PROVIDERS: readonly LlmProviderId[] = ["ollama"];

export interface ProviderChainOptions {
  readonly allowDevOnlyProviders: boolean;
}

export class ProviderChainConfigError extends Error {
  override readonly name = "ProviderChainConfigError";
}

/** `"groq,cloudflare_workers_ai"` → `["groq", "cloudflare_workers_ai"]`. Lança no boot se a cadeia não presta. */
export function parseLlmProviderChain(raw: string | undefined, options: ProviderChainOptions): readonly LlmProviderId[] {
  const allowed = new Set([...PRODUCTION_PROVIDERS, ...(options.allowDevOnlyProviders ? DEV_ONLY_PROVIDERS : [])]);
  const schema = z
    .string()
    .transform((value) => value.split(",").map((item) => item.trim()))
    .pipe(
      z
        .array(LlmProviderIdSchema.refine((id) => allowed.has(id), "provedor fora da política desta fase"))
        // Sem .min nem .max: o split sempre dá 1 item ou mais, e sem repetição a cadeia já fica limitada aos
        // provedores permitidos (2 em produção, 3 em dev).
        .refine((ids) => new Set(ids).size === ids.length, "provedor repetido"),
    );
  const parsed = schema.safeParse(raw);
  // Só a contagem de problemas: a mensagem não ecoa o valor do ambiente.
  if (!parsed.success) throw new ProviderChainConfigError(`LLM_PROVIDER_CHAIN inválida (${parsed.error.issues.length} problema(s))`);
  return Object.freeze(parsed.data);
}
