// Configuração do JWT vinda do ambiente, validada no main.ts (ADR-013 D6). As duas variáveis são obrigatórias:
// sem elas o processo não sobe (falha fechado). O JWKS precisa ser o do próprio projeto: um erro de digitação
// que aponte para outro projeto derruba a subida.
import { z } from "zod";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

/** Origem exata em https, ou http só em loopback (Supabase local). Sem caminho, barra final ou credenciais. */
export function isSupabaseOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.origin !== value) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
}

export const JWKS_PATH = "/auth/v1/.well-known/jwks.json";
export const ISSUER_PATH = "/auth/v1";

export const AuthEnvSchema = z
  .object({
    SUPABASE_URL: z.string().refine(isSupabaseOrigin, "SUPABASE_URL precisa ser uma origem exata em https"),
    SUPABASE_JWKS_URL: z.string(),
  })
  .refine((env) => env.SUPABASE_JWKS_URL === `${env.SUPABASE_URL}${JWKS_PATH}`, {
    message: "SUPABASE_JWKS_URL precisa ser o JWKS do mesmo projeto",
    path: ["SUPABASE_JWKS_URL"],
  })
  .transform((env) => ({ issuer: `${env.SUPABASE_URL}${ISSUER_PATH}`, jwksUrl: new URL(env.SUPABASE_JWKS_URL) }));
export type AuthEnv = z.output<typeof AuthEnvSchema>;
