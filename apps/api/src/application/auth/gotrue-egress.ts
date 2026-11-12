// Orçamento de saída e *bulkhead* das chamadas ao GoTrue (ADR-004 D8 item 5; emenda ao ADR-014, D10). O Supabase Auth
// vê um único IP, o da API (T43): o limite por IP dele vale para todos os usuários juntos. O orçamento fica abaixo de
// 50% dos tetos do P19, numa janela deslizante exata de 300 s (registro das chamadas, sem estouro na virada), e a
// renovação tem reserva própria: uma inundação de trocas não derruba quem já está logado. O *bulkhead* limita as
// chamadas simultâneas, e a troca nunca ocupa a última vaga (F1-API-08, achado A-03): ela é a única chamada que um
// anônimo leva ao GoTrue (basta um código de formato válido), enquanto a renovação exige um envelope que abre e o
// logout, um Bearer verificado. Os casos de uso (07f) só passam por aqui depois do Zod e, na renovação, do `open`: nada
// é consumido antes disso, e a negação não consome nada.
//
// Teto de rajada (07j; D8 item 5, "Emenda do 07h"): o balde `Token` do GoTrue tem rajada fixa de 30 e repõe 0,5 ficha
// por segundo; os 150 por 5 min são a média, não o teto de uma rajada. A janela de 300 s sozinha deixava passar 74
// chamadas seguidas, e o IP da API ficaria bloqueado no GoTrue até a reposição. As chamadas ao `/token` (troca e
// renovação) passam também por um balde de 15 fichas com 1 ficha a cada 4 s: metade da rajada e metade da reposição
// do GoTrue, então o balde de lá nunca desce de 15. O logout não entra (o `/logout` não tem limitador no GoTrue).
import type { Clock } from "../ports/clock.js";

/** Partições do orçamento no `/auth/v1/token`. O logout só passa pelo *bulkhead* (o balde dele é conferido no 07h). */
export type EgressPartition = "troca" | "renovacao";
export type EgressCall = EgressPartition | "logout";

export interface GotrueEgressPolicy {
  readonly windowMs: number;
  /** Trocas (`grant_type=pkce`) na janela: o pior caso conta no balde de sign-in **e** no de token. */
  readonly trocaMax: number;
  /** Troca + renovação (com a nova tentativa do D4 passo 6) na janela, no balde de token. */
  readonly tokenTotalMax: number;
  /** Vagas do total que a troca nunca usa: só a renovação as consome. */
  readonly renovacaoReserve: number;
  readonly maxConcurrent: number;
  /** Vagas do *bulkhead* que a troca pode ocupar; as outras ficam para a renovação e o logout (A-03). */
  readonly trocaMaxConcurrent: number;
  /** O `retryAfterSeconds` do 503 com o *bulkhead* cheio. */
  readonly busyRetryAfterSeconds: number;
  /** Fichas do balde de rajada do `/token`: o máximo de chamadas seguidas (07j). */
  readonly burstCapacity: number;
  /** Reposição do balde de rajada: uma ficha a cada tantos ms. */
  readonly burstRefillIntervalMs: number;
}

/**
 * Limites do Supabase Auth por IP no projeto real (P19, HITL-036): por 5 min. O `tokenBurst` é a rajada fixa do balde
 * `Token` no código do GoTrue (07h): 31 chamadas seguidas já levam 429.
 */
export const SUPABASE_AUTH_IP_LIMITS = { windowMs: 300_000, tokenRefresh: 150, signIn: 30, tokenBurst: 30 } as const;

export const GOTRUE_EGRESS_POLICY: GotrueEgressPolicy = {
  windowMs: 300_000,
  trocaMax: 14,
  tokenTotalMax: 74,
  renovacaoReserve: 37,
  maxConcurrent: 4,
  trocaMaxConcurrent: 3,
  busyRetryAfterSeconds: 5,
  burstCapacity: 15,
  burstRefillIntervalMs: 4_000,
};

export type EgressDenialReason = "orcamento_esgotado" | "bulkhead_cheio";

export interface EgressDenial {
  readonly ok: false;
  readonly reason: EgressDenialReason;
  readonly retryAfterSeconds: number;
}

export type EgressOutcome<T> = { readonly ok: true; readonly value: T } | EgressDenial;

export interface GotrueEgress {
  /**
   * Reserva uma vaga do orçamento e uma do *bulkhead* e roda `call`. Negado, `call` não roda e nada é consumido.
   * A vaga do *bulkhead* volta quando `call` termina, inclusive se rejeitar (a rejeição segue para o chamador).
   */
  run<T>(kind: EgressCall, call: () => Promise<T>): Promise<EgressOutcome<T>>;
}

export class EgressPolicyError extends Error {
  constructor() {
    super("política do orçamento de saída do GoTrue inválida");
    this.name = "EgressPolicyError";
  }
}

const positiveInt = (value: number): boolean => Number.isSafeInteger(value) && value >= 1;

/**
 * Com o registro vazio, as duas partições precisam passar: senão a negação nunca teria fim. E a troca precisa deixar
 * pelo menos uma vaga do *bulkhead* para quem já está logado.
 */
function assertPolicy(policy: GotrueEgressPolicy): void {
  const ints = [
    policy.windowMs,
    policy.trocaMax,
    policy.tokenTotalMax,
    policy.maxConcurrent,
    policy.trocaMaxConcurrent,
    policy.busyRetryAfterSeconds,
    policy.burstCapacity,
    policy.burstRefillIntervalMs,
  ];
  const reserveOk = Number.isSafeInteger(policy.renovacaoReserve) && policy.renovacaoReserve >= 0;
  const slotKept = policy.trocaMaxConcurrent < policy.maxConcurrent;
  if (!ints.every(positiveInt) || !reserveOk || policy.renovacaoReserve >= policy.tokenTotalMax || !slotKept) throw new EgressPolicyError();
}

interface Spent {
  readonly atMs: number;
  readonly partition: EgressPartition;
}

const MS_PER_SECOND = 1_000;

export function createGotrueEgress(clock: Clock, policy: GotrueEgressPolicy = GOTRUE_EGRESS_POLICY): GotrueEgress {
  assertPolicy(policy);
  // Em ordem de chamada (o relógio é monotônico): os mais antigos vencem primeiro.
  let spent: Spent[] = [];
  let inFlight = 0;
  let trocasInFlight = 0;
  // Balde de rajada em ms inteiros, sem fração de ficha: `burstFullAtMs` é o instante em que o balde volta a estar
  // cheio. Cada chamada o empurra um intervalo, e a chamada passa enquanto ele não ficar além de uma capacidade inteira.
  let burstFullAtMs = Number.NEGATIVE_INFINITY;
  const burstSpanMs = (policy.burstCapacity - 1) * policy.burstRefillIntervalMs;

  /** Milissegundos até haver uma ficha; 0 com ficha disponível. */
  const burstWaitMs = (nowMs: number): number => Math.max(0, burstFullAtMs - burstSpanMs - nowMs);

  const allows = (partition: EgressPartition, troca: number, renovacao: number): boolean =>
    partition === "renovacao"
      ? troca + renovacao < policy.tokenTotalMax
      : troca < policy.trocaMax && troca + Math.max(renovacao, policy.renovacaoReserve) < policy.tokenTotalMax;

  /** Segundos até a 1ª chamada que, ao sair da janela, libera a partição. */
  function retryAfterSeconds(partition: EgressPartition, nowMs: number, troca: number, renovacao: number): number {
    let t = troca;
    let r = renovacao;
    // Negado implica registro não vazio, e a política garante que o registro vazio libera: o laço sempre acha uma.
    let freedAtMs = (spent.at(-1) as Spent).atMs + policy.windowMs;
    for (const entry of spent) {
      if (entry.partition === "troca") t -= 1;
      else r -= 1;
      if (allows(partition, t, r)) {
        freedAtMs = entry.atMs + policy.windowMs;
        break;
      }
    }
    return Math.max(1, Math.ceil((freedAtMs - nowMs) / MS_PER_SECOND));
  }

  function spend(partition: EgressPartition): EgressDenial | null {
    const nowMs = clock.nowMs();
    // A janela é (agora − 300 s, agora]: a chamada de exatamente 300 s atrás já saiu.
    spent = spent.filter((entry) => entry.atMs > nowMs - policy.windowMs);
    const troca = spent.filter((entry) => entry.partition === "troca").length;
    const renovacao = spent.length - troca;
    // A chamada precisa passar na janela e na rajada. Negada por uma, não gasta a outra, e o Retry-After é o maior.
    const windowWaitSeconds = allows(partition, troca, renovacao) ? 0 : retryAfterSeconds(partition, nowMs, troca, renovacao);
    const burstWaitSeconds = Math.ceil(burstWaitMs(nowMs) / MS_PER_SECOND);
    if (windowWaitSeconds > 0 || burstWaitSeconds > 0) {
      return { ok: false, reason: "orcamento_esgotado", retryAfterSeconds: Math.max(windowWaitSeconds, burstWaitSeconds) };
    }
    spent.push({ atMs: nowMs, partition });
    burstFullAtMs = Math.max(burstFullAtMs, nowMs) + policy.burstRefillIntervalMs;
    return null;
  }

  return {
    async run(kind, call) {
      // O *bulkhead* decide primeiro: cheio, nenhuma vaga do orçamento é gasta. A troca para antes, no teto dela.
      const troca = kind === "troca";
      if (inFlight >= policy.maxConcurrent || (troca && trocasInFlight >= policy.trocaMaxConcurrent)) {
        return { ok: false, reason: "bulkhead_cheio", retryAfterSeconds: policy.busyRetryAfterSeconds };
      }
      if (kind !== "logout") {
        const denial = spend(kind);
        if (denial !== null) return denial;
      }
      inFlight += 1;
      if (troca) trocasInFlight += 1;
      try {
        return { ok: true, value: await call() };
      } finally {
        inFlight -= 1;
        if (troca) trocasInFlight -= 1;
      }
    },
  };
}
