// Adapter da porta IdGenerator (ADR-017 D1): UUID v4 do `node:crypto`, com CSPRNG.
import { randomUUID } from "node:crypto";

import type { IdGenerator } from "../../application/ports/id-generator.js";

export const cryptoIdGenerator: IdGenerator = Object.freeze({ uuid: () => randomUUID() });
