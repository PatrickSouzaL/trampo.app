// Adapter da porta TextHasher do domínio (ADR-005 D1): sha256 do OpenSSL via node:crypto, sem
// criptografia artesanal. Provado com os vetores do NIST (FIPS 180-2) em test/infrastructure.
import { createHash } from "node:crypto";

import type { TextHasher } from "../../domain/ports/text-hasher.js";

export const nodeTextHasher: TextHasher = {
  sha256Hex: (text) => createHash("sha256").update(text, "utf8").digest("hex"),
};
