// Algoritmos puros do rate limit, da cota e do ledger (ADR-014 D4 a D6). Toda a lógica fica aqui, em
// TypeScript testável: o Redis só guarda contadores (INCR, GET, SADD, SCARD), sem script Lua.

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** Instante de parede válido: inteiro seguro, não negativo. Fora disso o adapter falha fechado. */
export function isEpochMs(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export interface WindowPosition {
  /** Índice da janela fixa atual (`floor(agora / janela)`). */
  readonly index: number;
  /** Milissegundos decorridos dentro da janela atual, em [0, janela). */
  readonly elapsedMs: number;
}

export function windowPosition(epochMs: number, windowMs: number): WindowPosition {
  const index = Math.floor(epochMs / windowMs);
  return { index, elapsedMs: epochMs - index * windowMs };
}

/**
 * Janela deslizante aproximada: a janela anterior pesa pela fração que ainda cabe na janela deslizante.
 * `current` já inclui a requisição que está sendo decidida.
 */
export function slidingWindowCount(previous: number, current: number, elapsedMs: number, windowMs: number): number {
  return Math.floor((previous * (windowMs - elapsedMs)) / windowMs) + current;
}

/** Segundos até o fim da janela atual, em [1, janela em segundos]. */
export function windowRetryAfterSeconds(elapsedMs: number, windowMs: number): number {
  const seconds = Math.ceil((windowMs - elapsedMs) / MS_PER_SECOND);
  return Math.min(Math.max(seconds, 1), windowMs / MS_PER_SECOND);
}

export interface QuotaDay {
  /** Data civil no fuso da cota, `AAAA-MM-DD`. */
  readonly day: string;
  /** Segundos até a próxima meia-noite nesse fuso, em [1, 86.400]. */
  readonly secondsUntilNextDay: number;
}

/** O dia civil num deslocamento fixo de UTC (a cota usa UTC−03:00). */
export function quotaDay(epochMs: number, utcOffsetMinutes: number): QuotaDay {
  const shifted = epochMs + utcOffsetMinutes * MS_PER_MINUTE;
  const dayIndex = Math.floor(shifted / MS_PER_DAY);
  return {
    day: new Date(dayIndex * MS_PER_DAY).toISOString().slice(0, 10),
    secondsUntilNextDay: Math.ceil(((dayIndex + 1) * MS_PER_DAY - shifted) / MS_PER_SECOND),
  };
}

/** Dia UTC (`AAAA-MM-DD`) e minuto UTC (índice) dos contadores dos provedores. */
export function utcDayAndMinute(epochMs: number): { readonly day: string; readonly minute: number } {
  return { day: quotaDay(epochMs, 0).day, minute: Math.floor(epochMs / MS_PER_MINUTE) };
}
