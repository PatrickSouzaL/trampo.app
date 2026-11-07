// Guarda em volta do CriteriaRepository (ADR-018 D6; ADR-021 D5; risco residual do ADR-017 §3.2). Confere a
// entrada, dá um prazo à porta (withDeadline, como os guardas do ADR-014 D1) e revalida a resposta com um schema
// estrito. Na leitura, exceção, rejeição, demora ou resposta fora do contrato viram `unavailable` (503): nunca
// liberam a análise. Na escrita, os critérios são reparseados antes de tocar na porta, e qualquer desvio também
// é `unavailable`. É um decorador da própria porta, então as rotas não mudam. Nunca rejeita.
import { type UserCriteria, UserCriteriaSchema } from "@trampo/contracts";
import { ACCESS_TOKEN_MAX_CHARS } from "@trampo/contracts/limits";
import { z } from "zod";

import type { Clock } from "../ports/clock.js";
import type {
  CriteriaLookup,
  CriteriaReader,
  CriteriaRepository,
  CriteriaSave,
  CriteriaSubject,
} from "../ports/criteria-repository.js";
import { withDeadline } from "../shared/with-deadline.js";

/** Hipótese da Fase 1 (PostgREST na mesma região), calibrada no S-5. Muda só por ADR. */
export const CRITERIA_GUARD_POLICY = {
  timeoutMs: 1_000,
  /** O mesmo teto da borda (ADR-013 D3), da fonte única do contrato. */
  accessTokenMaxChars: ACCESS_TOKEN_MAX_CHARS,
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

/** Só o sucesso tem forma; qualquer outra resposta (inclusive a falha declarada) é `unavailable`. */
const SavedSchema = z.strictObject({ saved: z.literal(true) });

const UNAVAILABLE: CriteriaLookup = { found: false, unavailable: true };
const NOT_CONFIGURED: CriteriaLookup = { found: false };
const SAVED: CriteriaSave = { saved: true };
const SAVE_UNAVAILABLE: CriteriaSave = { saved: false, unavailable: true };

/** Forma canônica: os critérios reparseados, nunca o objeto do adapter; qualquer desvio é `unavailable`. */
function revalidate(value: unknown): CriteriaLookup {
  const parsed = CriteriaLookupSchema.safeParse(value);
  if (!parsed.success) return UNAVAILABLE;
  if (parsed.data.found) return { found: true, criteria: parsed.data.criteria };
  return parsed.data.unavailable === true ? UNAVAILABLE : NOT_CONFIGURED;
}

function revalidateSave(value: unknown): CriteriaSave {
  return SavedSchema.safeParse(value).success ? SAVED : SAVE_UNAVAILABLE;
}

/**
 * `P` é a porta embrulhada. Sobre uma porta só de leitura (o adapter do Supabase até o commit 3 do ADR-021), o
 * guarda só lê: o `save` exige, em tipo, uma porta que também grava (ADR-021 §5.2).
 */
export class CriteriaGuard<P extends CriteriaReader = CriteriaRepository> implements CriteriaReader {
  readonly #repository: P;
  readonly #clock: Clock;
  readonly #timeoutMs: number;

  constructor(repository: P, clock: Clock, timeoutMs: number = CRITERIA_GUARD_POLICY.timeoutMs) {
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

  /**
   * Substitui os critérios do dono (ADR-021 D5). O adapter recebe o valor reparseado pelo UserCriteriaSchema, nunca
   * o objeto de quem chama: critérios fora do contrato, acima do teto de bytes ou com chave a mais não chegam à
   * porta. O `signal` de quem chama não entra: o prazo e o aborto são do guarda.
   */
  save(this: CriteriaGuard<CriteriaRepository>, subject: CriteriaSubject, criteria: UserCriteria): Promise<CriteriaSave> {
    const input = CriteriaSubjectSchema.safeParse(subject);
    if (!input.success) return Promise.resolve(SAVE_UNAVAILABLE);
    const parsed = UserCriteriaSchema.safeParse(criteria);
    if (!parsed.success) return Promise.resolve(SAVE_UNAVAILABLE);
    const { userId, accessToken } = input.data;
    return withDeadline(
      this.#clock,
      this.#timeoutMs,
      (signal) => this.#repository.save({ userId, accessToken }, parsed.data, signal).then(revalidateSave),
      SAVE_UNAVAILABLE,
    );
  }
}
