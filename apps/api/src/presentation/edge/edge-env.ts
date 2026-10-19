// Configuração da borda vinda do ambiente, validada no main.ts (ADR-007 D5 e D6). Tudo falha fechado:
// sem CORS_ALLOWED_ORIGINS nenhuma origem de navegador passa; sem TRUST_PROXY o X-Forwarded-For é
// ignorado.
import { z } from "zod";

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

/**
 * Origem exata: `chrome-extension://<id>`, `https://host[:porta]` ou loopback em http (portal em dev).
 * `URL.origin === valor` recusa caminho, barra final, maiúsculas, credenciais e porta padrão escrita.
 */
export function isExactOrigin(value: string): boolean {
  if (EXTENSION_ORIGIN.test(value)) return true;
  if (value.includes("*") || !URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.origin !== value) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
}

const csv = (raw: string): string[] =>
  raw
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

/** IP ou CIDR de um salto de proxy real. `/0` confiaria em todo mundo, como `true`. */
const ProxyHopSchema = z
  .union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()])
  .refine((hop) => !hop.endsWith("/0"), "CIDR /0 equivale a confiar em qualquer origem");

export const EdgeEnvSchema = z.object({
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform(csv)
    .pipe(z.array(z.string().refine(isExactOrigin, "origem precisa ser exata")).max(10)),
  TRUST_PROXY: z
    .string()
    .default("false")
    .transform((raw) => (raw.trim() === "" || raw.trim() === "false" ? false : csv(raw)))
    .pipe(z.union([z.literal(false), z.array(ProxyHopSchema).min(1).max(10)])),
});
export type EdgeEnv = z.output<typeof EdgeEnvSchema>;
