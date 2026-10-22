// CriteriaRepository em memória (ADR-017 D1), para os testes da rota (F1-API-04 parte 2) até o adapter do
// Supabase (F1-DB-01). Registra os userIds consultados, para provar a ordem de defesa (critérios antes da cota),
// e os tokens recebidos, para provar que a rota leva ao adapter o token já verificado (ADR-018 D6).
import type { UserCriteria } from "@trampo/contracts";

import type { CriteriaLookup, CriteriaRepository, CriteriaSubject } from "../../../src/application/index.js";

export class FakeCriteriaRepository implements CriteriaRepository {
  readonly loads: string[] = [];
  readonly tokens: string[] = [];
  readonly #byUser = new Map<string, UserCriteria>();
  /** Simula o banco fora do ar. */
  unavailable = false;

  set(userId: string, criteria: UserCriteria): this {
    this.#byUser.set(userId, criteria);
    return this;
  }

  load(subject: CriteriaSubject): Promise<CriteriaLookup> {
    this.loads.push(subject.userId);
    this.tokens.push(subject.accessToken);
    if (this.unavailable) return Promise.resolve({ found: false, unavailable: true });
    const criteria = this.#byUser.get(subject.userId);
    return Promise.resolve(criteria === undefined ? { found: false } : { found: true, criteria });
  }
}
