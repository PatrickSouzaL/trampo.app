// Harness dos casos de uso do BFF (F1-API-07 07f, ADR-004 D4): GoTrue roteirizado, verificador falso que conhece os
// tokens que o GoTrue falso emitiu, o RefreshSealer AEAD real e o orçamento de saída real (07e), os dois com espião.
// Um log único de eventos prova a ordem (formato → `open` → idades → chaves → orçamento → GoTrue → verificação →
// selagem). Dois relógios, como em produção: o de parede (`now`, epoch em ms) e o monotônico (FakeClock), que só
// anda no `run` e dá o prazo da nova tentativa.
import { randomBytes } from "node:crypto";

import type { AccessTokenVerification, AccessTokenVerifier, TokenLifetime } from "../../../src/application/ports/access-token-verifier.js";
import type {
  AuthLogoutResult,
  AuthTokenGateway,
  AuthTokenResult,
  AuthTokens,
} from "../../../src/application/ports/auth-token-gateway.js";
import type { RefreshSealer, SealedSession } from "../../../src/application/ports/refresh-sealer.js";
import {
  createGotrueEgress,
  GOTRUE_EGRESS_POLICY,
  type GotrueEgress,
  type GotrueEgressPolicy,
} from "../../../src/application/auth/gotrue-egress.js";
import { createAeadRefreshSealer, parseRefreshKeyring } from "../../../src/infrastructure/crypto/aead-refresh-sealer.js";

import { FakeClock } from "./fake-clock.js";

export const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
export const OTHER_ORIGIN = "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba";
export const SID = "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3";
export const OTHER_SID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
export const AUTH_CODE = "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f";
/** O verifier do RFC 7636 (apêndice B). */
export const CODE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
/** Relógio de parede no início de cada teste, em segundos inteiros. */
export const START_SECONDS = 1_790_000_000;
export const AGES = { maxAgeSeconds: 86_400, idleSeconds: 14_400 } as const;

export const RECUSADO: AuthTokenResult = { ok: false, reason: "recusado" };
export const NAO_RECEBIDO: AuthTokenResult = { ok: false, reason: "nao_recebido" };
export const PODE_TER_ROTACIONADO: AuthTokenResult = { ok: false, reason: "pode_ter_rotacionado" };

/** Uma resposta do GoTrue roteirizada: recebe o `signal` que o caso de uso passou. */
export type GatewayStep = (signal: AbortSignal | undefined) => AuthTokenResult | Promise<AuthTokenResult>;
export type LogoutStep = () => AuthLogoutResult | Promise<AuthLogoutResult>;

export interface GatewayCall {
  readonly method: "exchangePkce" | "refresh" | "logout";
  readonly args: readonly string[];
  readonly signal: AbortSignal | undefined;
}

/** Claims de um token emitido pelo GoTrue falso, que o verificador falso devolve. */
export interface MintOptions {
  readonly sessionId?: string | null;
  /** Idade do token no instante da emissão, em segundos (iat = agora − idade). */
  readonly ageSeconds?: number;
  /** `exp − iat`. */
  readonly lifetimeSeconds?: number;
  readonly expiresIn?: number;
  readonly accessToken?: string;
  readonly refreshToken?: string;
}

interface Minted {
  readonly sessionId: string | null;
  readonly lifetime: TokenLifetime;
}

const b64 = (bytes: number): string => randomBytes(bytes).toString("base64url");

export function newSealKey(): string {
  return randomBytes(32).toString("base64url");
}

export class AuthHarness {
  /** Relógio de parede, epoch em ms. */
  nowMs = START_SECONDS * 1_000;
  readonly clock = new FakeClock();
  readonly events: string[] = [];
  readonly calls: GatewayCall[] = [];
  readonly sealCalls: { readonly session: SealedSession; readonly origin: string }[] = [];
  readonly egressRuns: string[] = [];
  /** Roteiro do GoTrue, consumido em ordem; vazio, emite um par novo da sessão SID. */
  readonly steps: GatewayStep[] = [];
  readonly logoutSteps: LogoutStep[] = [];
  readonly minted = new Map<string, Minted>();
  keysReadyResult: () => Promise<boolean> = async () => true;
  /** Por padrão, o verificador aceita só os tokens que o GoTrue falso emitiu. */
  verifyResult: (token: string) => Promise<AccessTokenVerification> = async (token) => {
    const minted = this.minted.get(token);
    if (minted === undefined) return { ok: false, reason: "token_invalido" };
    return { ok: true, principal: { userId: "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f", sessionId: minted.sessionId }, lifetime: minted.lifetime };
  };
  sealOverride: ((session: SealedSession, origin: string) => ReturnType<RefreshSealer["seal"]>) | null = null;
  openOverride: ((envelope: string, origin: string) => ReturnType<RefreshSealer["open"]>) | null = null;

  readonly sealKey = newSealKey();
  readonly realSealer: RefreshSealer = createAeadRefreshSealer(parseRefreshKeyring(`k1:${this.sealKey}`, "k1"));
  readonly realEgress: GotrueEgress;

  constructor(policy: GotrueEgressPolicy = GOTRUE_EGRESS_POLICY) {
    this.realEgress = createGotrueEgress(this.clock, policy);
  }

  get nowSeconds(): number {
    return this.nowMs / 1_000;
  }

  /** Um par emitido pelo GoTrue falso, com as claims que o verificador falso vai devolver. */
  mint(options: MintOptions = {}): AuthTokens {
    const accessToken = options.accessToken ?? `${b64(12)}.${b64(24)}.${b64(16)}`;
    const issuedAt = Math.floor(this.nowSeconds) - (options.ageSeconds ?? 0);
    this.minted.set(accessToken, {
      sessionId: options.sessionId === undefined ? SID : options.sessionId,
      lifetime: { issuedAt, expiresAt: issuedAt + (options.lifetimeSeconds ?? 900) },
    });
    return {
      accessToken,
      refreshToken: options.refreshToken ?? `rt-${b64(9)}`,
      expiresIn: options.expiresIn ?? 900,
      tokenType: "bearer",
    };
  }

  /** O GoTrue falso responde com um par novo. */
  issues(options: MintOptions = {}): GatewayStep {
    return () => ({ ok: true, tokens: this.mint(options) });
  }

  #next(signal: AbortSignal | undefined): Promise<AuthTokenResult> {
    const step = this.steps.shift() ?? this.issues();
    return Promise.resolve(step(signal));
  }

  readonly gateway: AuthTokenGateway = {
    exchangePkce: (authCode, codeVerifier, signal) => {
      this.events.push("gotrue:exchangePkce");
      this.calls.push({ method: "exchangePkce", args: [authCode, codeVerifier], signal });
      return this.#next(signal);
    },
    refresh: (refreshToken, signal) => {
      this.events.push("gotrue:refresh");
      this.calls.push({ method: "refresh", args: [refreshToken], signal });
      return this.#next(signal);
    },
    logout: (accessToken, signal) => {
      this.events.push("gotrue:logout");
      this.calls.push({ method: "logout", args: [accessToken], signal });
      const step = this.logoutSteps.shift() ?? (() => ({ ok: true }) as const);
      return Promise.resolve(step());
    },
  };

  readonly verifier: AccessTokenVerifier = {
    keysReady: () => {
      this.events.push("keysReady");
      return this.keysReadyResult();
    },
    verify: (token) => {
      this.events.push("verify");
      return this.verifyResult(token);
    },
  };

  readonly sealer: RefreshSealer = {
    seal: (session, origin) => {
      this.events.push("seal");
      this.sealCalls.push({ session, origin });
      return this.sealOverride === null ? this.realSealer.seal(session, origin) : this.sealOverride(session, origin);
    },
    open: (envelope, origin) => {
      this.events.push("open");
      return this.openOverride === null ? this.realSealer.open(envelope, origin) : this.openOverride(envelope, origin);
    },
  };

  readonly egress: GotrueEgress = {
    run: (kind, call) => {
      this.events.push(`egress:${kind}`);
      this.egressRuns.push(kind);
      return this.realEgress.run(kind, call);
    },
  };

  readonly now = (): number => this.nowMs;

  /** Envelope genuíno, selado com a chave do harness. */
  envelope(session: Partial<SealedSession> = {}, origin = EXTENSION_ORIGIN): string {
    const sealed = this.realSealer.seal(
      { rt: "rt-original", sid: SID, sst: START_SECONDS - 600, iat: START_SECONDS - 60, ...session },
      origin,
    );
    if (!sealed.ok) throw new Error("envelope de teste fora da política");
    return sealed.envelope;
  }

  /** Abre um envelope da resposta com a chave do harness. */
  openEnvelope(envelope: string, origin = EXTENSION_ORIGIN): SealedSession {
    const opened = this.realSealer.open(envelope, origin);
    if (!opened.ok) throw new Error("envelope da resposta não abre");
    return opened.session;
  }

  /** Gasta `n` vagas da partição no orçamento real, fora do log, sem chamar o GoTrue falso. */
  async spend(kind: "troca" | "renovacao", n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      const outcome = await this.realEgress.run(kind, async () => undefined);
      if (!outcome.ok) throw new Error("orçamento esgotado antes do esperado");
    }
  }
}
