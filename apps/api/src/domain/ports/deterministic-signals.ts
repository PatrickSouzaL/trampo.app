// Porta DeterministicSignals (ADR-011 D1): contrato do CONSUMIDOR (FactResolver), que o
// DeterministicPreFilter (F1-DOM-04) implementa. Independente do usuário: função do texto e da versão.
import type { ContractType, SalaryFacts, SeniorityLevel, WorkModel } from "@trampo/contracts";

/** Força do sinal (ADR-001 §5.3). O FactResolver só usa `explicita`; `fraca` serve ao roteamento R3. */
export type SignalStrength = "explicita" | "fraca";

export type InjectionLevel = "baixa" | "media" | "alta";

export interface SetSignal<T extends string> {
  readonly values: readonly T[];
  readonly strength: SignalStrength;
}

export interface SalarySignal {
  readonly value: SalaryFacts;
  readonly strength: SignalStrength;
}

export interface StackMentionSignal {
  /** Grafia canônica do TechDictionary (TechTag válida), nunca a do usuário. */
  readonly term: string;
  readonly strength: SignalStrength;
}

export interface DeterministicSignals {
  readonly workModels: SetSignal<WorkModel> | null;
  readonly contractTypes: SetSignal<ContractType> | null;
  readonly seniorityLevels: SetSignal<SeniorityLevel> | null;
  readonly salary: SalarySignal | null;
  readonly stackMentions: readonly StackMentionSignal[];
  readonly injectionLevel: InjectionLevel;
}
