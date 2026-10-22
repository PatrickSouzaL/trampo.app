// Ambiente do rate limit, da cota e do ledger (ADR-014 D8), validado no main.ts. As três variáveis são
// obrigatórias: sem Redis não há limite, e sem limite a API não sobe (falha fechado). Nenhuma mensagem de erro
// repete o valor recebido.
import { z } from "zod";

import { RATE_KEY_PEPPER_PATTERN } from "../crypto/hmac-key-pseudonymizer.js";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

/** Origem exata em https, ou http só em loopback (o Upstash simulado dos testes). Sem caminho nem credenciais. */
export function isUpstashOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.origin !== value) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
}

export const LimitsEnvSchema = z
  .object({
    UPSTASH_REDIS_REST_URL: z.string().refine(isUpstashOrigin, "UPSTASH_REDIS_REST_URL precisa ser uma origem exata em https"),
    UPSTASH_REDIS_REST_TOKEN: z.string().regex(/^\S{1,512}$/, "UPSTASH_REDIS_REST_TOKEN ausente ou fora da forma"),
    RATE_KEY_PEPPER: z.string().regex(RATE_KEY_PEPPER_PATTERN, "RATE_KEY_PEPPER precisa ser base64url de pelo menos 32 bytes"),
  })
  .transform((env) => ({
    restUrl: new URL(env.UPSTASH_REDIS_REST_URL),
    restToken: env.UPSTASH_REDIS_REST_TOKEN,
    pepper: env.RATE_KEY_PEPPER,
  }));
export type LimitsEnv = z.output<typeof LimitsEnvSchema>;
