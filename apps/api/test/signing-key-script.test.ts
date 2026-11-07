// O gerador da chave ES256 do GoTrue local (ADR-004 §4.3; emenda do 07h no ADR-019) roda no job db antes do
// `supabase start`. Aqui, sem Docker, o script roda de verdade num diretório temporário: a forma da JWK que a CLI lê,
// o par que assina e verifica, a recusa de sobrescrever e a de destino com outro nome. O uso da chave pelo GoTrue só
// se prova no job db (auth-contract.db.test.ts).
import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";

const SCRIPT = fileURLToPath(new URL("./db/support/write-signing-key.ts", import.meta.url));
const B64URL_32 = /^[\w-]{43}$/;

const SigningKeySchema = z.strictObject({
  kty: z.literal("EC"),
  kid: z.uuid(),
  use: z.literal("sig"),
  key_ops: z.tuple([z.literal("sign"), z.literal("verify")]),
  alg: z.literal("ES256"),
  ext: z.literal(true),
  crv: z.literal("P-256"),
  x: z.string().regex(B64URL_32),
  y: z.string().regex(B64URL_32),
  d: z.string().regex(B64URL_32),
});

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trampo-signing-key-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 20_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("write-signing-key.ts", () => {
  test("grava uma lista com uma JWK ES256 privada no formato da CLI, sem nada na saída padrão", () => {
    const target = join(dir, "signing_keys.json");
    const result = run(target);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    const keys = z.array(SigningKeySchema).length(1).parse(JSON.parse(readFileSync(target, "utf8")));
    const [key] = keys as [z.infer<typeof SigningKeySchema>];
    // O par confere: o que a privada assina, a pública (sem `d`, como o JWKS do GoTrue) verifica.
    const privateKey = createPrivateKey({ key, format: "jwk" });
    const { d: _d, ...publicJwk } = key;
    const publicKey = createPublicKey({ key: publicJwk, format: "jwk" });
    const signature = sign("sha256", Buffer.from("trampo"), { key: privateKey, dsaEncoding: "ieee-p1363" });
    expect(verify("sha256", Buffer.from("trampo"), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  test("cada execução gera uma chave nova", () => {
    const a =join(mkdtempSync(join(dir, "a-")), "signing_keys.json");
    const b = join(mkdtempSync(join(dir, "b-")), "signing_keys.json");
    expect(run(a).status).toBe(0);
    expect(run(b).status).toBe(0);
    const keyA = SigningKeySchema.parse((JSON.parse(readFileSync(a, "utf8")) as unknown[])[0]);
    const keyB = SigningKeySchema.parse((JSON.parse(readFileSync(b, "utf8")) as unknown[])[0]);
    expect(keyA.kid).not.toBe(keyB.kid);
    expect(keyA.d).not.toBe(keyB.d);
  });

  test("nunca sobrescreve um arquivo que já existe", () => {
    const target = join(dir, "signing_keys.json");
    writeFileSync(target, "anterior");
    const result = run(target);
    expect(result.status).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe("anterior");
  });

  test.each([
    ["sem destino", []],
    ["destino com outro nome", ["chave.json"]],
    ["nome que só termina parecido", ["my_signing_keys.json"]],
    ["argumento a mais", ["signing_keys.json", "extra"]],
  ])("recusa %s, sem gravar nada", (_name, args) => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8", timeout: 20_000 });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("uso:");
    expect(() => statSync(join(dir, "signing_keys.json"))).toThrow();
  });
});
