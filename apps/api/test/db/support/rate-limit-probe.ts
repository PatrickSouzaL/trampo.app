// Sonda do limite por IP do GoTrue local (ADR-004 D8 item 5 e §6.3, condição 3 do [APPSEC]; F1-API-07 07h). Só a
// contagem: quem manda as requisições é o auth-rate-limit.db.test.ts, contra a pilha local. Pura e testada no
// `pnpm test` (sem Docker), porque o job db roda só um dos dois ramos (limitador ativo ou inativo) e a cobertura dele
// não fecharia nos dois.

/** O balde `Token` do GoTrue (apilimiter.go): `token_refresh` por 5 min de reposição e rajada fixa de 30. */
export const GOTRUE_TOKEN_BUCKET = Object.freeze({ burst: 30, refillPerSecond: 150 / 300 });

export interface Flood {
  /** Status de cada requisição, na ordem. Para no primeiro 429. */
  readonly statuses: readonly number[];
  /** Posição (1 em diante) do primeiro 429, ou `null` se nenhum veio. */
  readonly firstLimitedAt: number | null;
  readonly elapsedMs: number;
}

/** Manda até `max` requisições em série e para no primeiro 429. */
export async function flood(send: () => Promise<number>, max: number, now: () => number = Date.now): Promise<Flood> {
  const statuses: number[] = [];
  const start = now();
  while (statuses.length < max) {
    const status = await send();
    statuses.push(status);
    if (status === 429) return { statuses, firstLimitedAt: statuses.length, elapsedMs: now() - start };
  }
  return { statuses, firstLimitedAt: null, elapsedMs: now() - start };
}

/**
 * A rajada medida cabe no balde esperado? Com o balde cheio, passam `burst` requisições e mais as fichas repostas
 * durante a própria rajada (arredondadas para cima, com uma de folga para o relógio).
 */
export function matchesBucket(result: Flood, bucket: { readonly burst: number; readonly refillPerSecond: number }): boolean {
  if (result.firstLimitedAt === null) return false;
  const passed = result.firstLimitedAt - 1;
  const refilled = Math.ceil((result.elapsedMs / 1_000) * bucket.refillPerSecond) + 1;
  return passed >= bucket.burst && passed <= bucket.burst + refilled;
}

/** Todas as respostas vieram do GoTrue e nenhuma foi o limite: 4xx, fora o 429. */
export function onlyRefusals(result: Flood): boolean {
  return result.statuses.length > 0 && result.statuses.every((status) => status >= 400 && status <= 499 && status !== 429);
}
