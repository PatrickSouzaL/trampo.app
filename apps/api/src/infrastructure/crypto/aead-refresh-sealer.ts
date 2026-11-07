// RefreshSealer com AEAD (ADR-004 D5; SR-21). Envelope `r1.<kid>.<iv>.<cifrado>.<tag>` sobre o aead-envelope, com
// anel próprio (`AUTH_REFRESH_SEAL_KEYS` e `AUTH_REFRESH_SEAL_ACTIVE_KEY`), separado do anel da pretensão. O AAD é
// `trampo:auth.refresh:r1:<Origin>`: liga o envelope ao build da extensão. É higiene, não autenticação (um script
// fora do navegador forja o `Origin`).
//
// O texto claro é `{ rt, sid, sst, iat }` em `strictObject`, com teto de 768 bytes **em bytes** (emenda da revisão
// da F1-AUTH-00): um `rt` fora do ASCII, ou com caracteres que o JSON escapa, passaria do teto e geraria um envelope
// que o próprio `SealedRefreshSchema` recusa; esse excesso não é selado (`ok: false`, 503 na rota). `seal` e `open`
// nunca lançam, e nada do envelope, da chave ou do texto claro vai para mensagem de erro.
import { z } from "zod";

import type { RefreshSealer, SealedSession } from "../../application/ports/refresh-sealer.js";
import { createAeadEnvelope, parseAeadKeyring, type AeadKeyring } from "./aead-envelope.js";

export const REFRESH_ENVELOPE_VERSION = "r1";
export const REFRESH_SEALER_POLICY = {
  plaintextMaxBytes: 768,
  /** `string(1..512)` do ADR-004 D5 (o formato real do refresh fica a verificar no P9). */
  refreshTokenMaxChars: 512,
  /** A faixa do cifrado no `SealedRefreshSchema` (ADR-004 D7): 768 bytes dão 1.024 caracteres. */
  ciphertextMinChars: 20,
  ciphertextMaxChars: 1_024,
  envelopeMaxChars: 1_100,
} as const;

const FORMAT = {
  version: REFRESH_ENVELOPE_VERSION,
  aadPrefix: `trampo:auth.refresh:${REFRESH_ENVELOPE_VERSION}:`,
  ciphertextChars: { min: REFRESH_SEALER_POLICY.ciphertextMinChars, max: REFRESH_SEALER_POLICY.ciphertextMaxChars },
} as const;

const EpochSecondsSchema = z.int().positive();
const SealedSessionSchema = z.strictObject({
  rt: z.string().min(1).max(REFRESH_SEALER_POLICY.refreshTokenMaxChars),
  sid: z.uuid(),
  sst: EpochSecondsSchema,
  iat: EpochSecondsSchema,
});

export class RefreshKeyringConfigError extends Error {
  constructor() {
    super(
      "AUTH_REFRESH_SEAL_KEYS e AUTH_REFRESH_SEAL_ACTIVE_KEY precisam de 1 a 4 chaves <kid>:<32 bytes em base64url>, " +
        "kid em [a-z0-9]{1,16}, e um kid ativo do anel",
    );
    this.name = "RefreshKeyringConfigError";
  }
}

const keyringError = (): Error => new RefreshKeyringConfigError();

/** Lê o anel do .env no boot e falha fechado sem ecoar valor (ADR-004 D5). */
export function parseRefreshKeyring(keys: string, activeKid: string): AeadKeyring {
  return parseAeadKeyring(keys, activeKid, keyringError);
}

export function createAeadRefreshSealer(keyring: AeadKeyring): RefreshSealer {
  const aead = createAeadEnvelope(FORMAT, keyring, keyringError);

  return {
    seal(session, origin) {
      const parsed = SealedSessionSchema.safeParse(session);
      if (!parsed.success) return { ok: false };
      const plaintext = Buffer.from(JSON.stringify(parsed.data), "utf8");
      if (plaintext.length > REFRESH_SEALER_POLICY.plaintextMaxBytes) return { ok: false };
      return { ok: true, envelope: aead.seal(plaintext, origin) };
    },

    open(envelope, origin) {
      const plaintext = aead.open(envelope, origin);
      if (plaintext === null) return { ok: false };
      // JSON inválido lança aqui. Um `__proto__` vira chave própria no JSON.parse, e o schema estrito a recusa.
      let decoded: unknown;
      try {
        decoded = JSON.parse(plaintext.toString("utf8"));
      } catch {
        return { ok: false };
      }
      const session = SealedSessionSchema.safeParse(decoded);
      return session.success ? { ok: true, session: session.data satisfies SealedSession } : { ok: false };
    },
  };
}
