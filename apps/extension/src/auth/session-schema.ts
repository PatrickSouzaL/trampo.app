// Sessão guardada da extensão (ADR-004 D9): o access token opaco e o envelope selado do refresh, em
// `storage.session`, lidos e gravados só por src/auth. O refresh cru do Supabase nunca chega aqui, e
// nenhuma claim do JWT é lida: o SW trata o token como opaco.
import { AccessTokenSchema, SealedRefreshSchema } from "@trampo/contracts/auth";
import { z } from "zod";

import { type SessionStore, sessionStore } from "../messaging/session-store";

export const SESSION_STORAGE_KEY = "trampo/sessao/v1";

/** O `expiresIn` do contrato vai de 1 a 900 s (ADR-004 D7): a vida guardada fica no mesmo intervalo, em ms. */
const MIN_LIFETIME_MS = 1_000;
const MAX_LIFETIME_MS = 900_000;

/**
 * Exatamente 5 chaves (chave extra, como um `token` plantado, invalida o valor). `accessExpiresAt` é o
 * epoch local em ms de `obtainedAt + expiresIn * 1000`: um valor que prometa mais que 900 s, ou nada, é
 * adulterado e não fica (endurecimento do 05a-2).
 */
export const StoredSessionSchema = z
  .strictObject({
    v: z.literal(1),
    accessToken: AccessTokenSchema,
    refreshToken: SealedRefreshSchema,
    // Positivo por tabela: o `obtainedAt` é positivo, e o `refine` exige ao menos 1.000 ms a mais.
    accessExpiresAt: z.int(),
    obtainedAt: z.int().positive(),
  })
  .refine((s) => s.accessExpiresAt - s.obtainedAt >= MIN_LIFETIME_MS && s.accessExpiresAt - s.obtainedAt <= MAX_LIFETIME_MS);
export type StoredSession = z.infer<typeof StoredSessionSchema>;

type SessionArea = Parameters<typeof sessionStore>[2];

/** A chave `trampo/sessao/v1`, revalidada na leitura: valor fora do schema é apagado e lido como ausente. */
export function authSessionStore(area?: SessionArea): SessionStore<typeof StoredSessionSchema> {
  return sessionStore(SESSION_STORAGE_KEY, StoredSessionSchema, area);
}
