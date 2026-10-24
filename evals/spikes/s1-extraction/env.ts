// S-1: lê do `apps/api/.env` só as quatro variáveis do spike, sem jogar o resto do arquivo no `process.env`
// (AGENTS §3.2: nenhum valor é impresso; o erro diz só o nome da variável que falta).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ENV_PATH = join(import.meta.dirname, "..", "..", "..", "apps", "api", ".env");

const WANTED = ["GROQ_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_WORKERS_AI_MODEL"] as const;
export type SpikeVariable = (typeof WANTED)[number];

export function readSpikeEnv(path: string = ENV_PATH): ReadonlyMap<SpikeVariable, string> {
  const out = new Map<SpikeVariable, string>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const eq = line.indexOf("=");
    if (eq <= 0 || line.trimStart().startsWith("#")) continue;
    const name = line.slice(0, eq).trim();
    const wanted = WANTED.find((w) => w === name);
    if (wanted === undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'")) && value.endsWith(value.charAt(0))) {
      value = value.slice(1, -1);
    }
    if (value !== "") out.set(wanted, value);
  }
  return out;
}

export function requireVar(env: ReadonlyMap<SpikeVariable, string>, name: SpikeVariable): string {
  const value = env.get(name);
  if (value === undefined) throw new Error(`${name} ausente em apps/api/.env`);
  return value;
}
