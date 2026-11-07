// Chave ES256 do GoTrue local (ADR-004 §4.3; emenda do 07h no ADR-019). O job db roda este script antes do
// `supabase start`, e o `supabase/config.toml` aponta o `signing_keys_path` para o arquivo gerado: o GoTrue assina com
// ES256, como o projeto real, e cada execução do CI tem uma chave nova, que morre com a VM. Nunca versionada
// (`.gitignore` e a regra `trampo-auth-seal-keys-files` do gitleaks).
//
// Roda direto no Node (sem build), então só importa módulos `node:` e só usa tipo apagável. O arquivo de destino
// precisa se chamar `signing_keys.json` e não pode existir (`wx`): o script nunca sobrescreve uma chave. Nada da chave
// vai para a saída.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";

const target = process.argv[2] ?? "";
if (!/(?:^|[\\/])signing_keys\.json$/.test(target) || process.argv.length !== 3) {
  process.stderr.write("uso: node write-signing-key.ts <caminho>/signing_keys.json\n");
  process.exit(2);
}

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = privateKey.export({ format: "jwk" });
// O formato que a CLI do Supabase lê no `signing_keys_path`: uma lista de JWK privadas, cada uma com `kid`.
const key = {
  kty: jwk.kty,
  kid: randomUUID(),
  use: "sig",
  key_ops: ["sign", "verify"],
  alg: "ES256",
  ext: true,
  crv: jwk.crv,
  x: jwk.x,
  y: jwk.y,
  d: jwk.d,
};
writeFileSync(target, `${JSON.stringify([key])}\n`, { flag: "wx", mode: 0o600 });
