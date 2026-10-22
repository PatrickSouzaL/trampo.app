// Guarda em volta do CriteriaRepository (ADR-018 D6; risco residual do ADR-017 §3.2). Confere a entrada, dá
// um prazo à porta (withDeadline, como os guardas do ADR-014 D1) e revalida a resposta com o UserCriteriaSchema.
// Exceção, rejeição, demora ou resposta fora do contrato viram `unavailable` (503): nunca liberam a análise.
// É um decorador da própria porta, então a rota não muda. Nunca rejeita.
import { UserCriteriaSchema } from "@trampo/contracts";
import { z } from "zod";

import type { Clock } from "../ports/clock.js";
import type { CriteriaLookup, CriteriaRepository, CriteriaSubject } from "../ports/criteria-repository.js";
import { withDeadline } from "../shared/with-deadline.js";

/** Hipótese da Fase 1 (PostgREST na mesma região), calibrada no S-5. Muda só por ADR. */
export const CRITERIA_GUARD_POLICY = {
  timeoutMs: 1_000,
  /** O mesmo teto da borda (ADR-013 D3). */
  accessTokenMaxChars: 8_192,
} as const;

const CriteriaSubjectSchema = z.strictObject({
  userId: z.uuid(),
  accessToken: z
    .string()
    .max(CRITERIA_GUARD_POLICY.accessTokenMaxChars)
    .regex(/^[\w-]+\.[\w-]+\.[\w-]+$/),
});

const CriteriaLookupSchema = z.union([
  z.strictObject({ found: z.literal(true), criteria: UserCriteriaSchema }),
  z.strictObject({ found: z.literal(false), unavailable: z.boolean().optional() }),
]);

const UNAVAILABLE: CriteriaLookup = { found: false, unavailable: true };
const NOT_CONFIGURED: CriteriaLookup = { found: false };

/** Forma canônica: os critérios reparseados, nunca o objeto do adapter; qualquer desvio é `unavailable`. */
function revalidate(value: unknown): CriteriaLookup {
  const parsed = CriteriaLookupSchema.safeParse(value);
  if (!parsed.success) return UNAVAILABLE;
  if (parsed.data.found) return { found: true, criteria: parsed.data.criteria };
  return parsed.data.unavailable === true ? UNAVAILABLE : NOT_CONFIGURED;
}

export class CriteriaGuard implements CriteriaRepository {
  readonly #repository: CriteriaRepository;
  readonly #clock: Clock;
  readonly #timeoutMs: number;

  constructor(repository: CriteriaRepository, clock: Clock, timeoutMs: number = CRITERIA_GUARD_POLICY.timeoutMs) {
    this.#repository = repository;
    this.#clock = clock;
    this.#timeoutMs = timeoutMs;
  }

  /** O `signal` de quem chama não entra: o prazo e o aborto são do guarda. */
  load(subject: CriteriaSubject): Promise<CriteriaLookup> {
    const input = CriteriaSubjectSchema.safeParse(subject);
    if (!input.success) return Promise.resolve(UNAVAILABLE);
    const { userId, accessToken } = input.data;
    return withDeadline(
      this.#clock,
      this.#timeoutMs,
      (signal) => this.#repository.load({ userId, accessToken }, signal).then(revalidate),
      UNAVAILABLE,
    );
  }
}
