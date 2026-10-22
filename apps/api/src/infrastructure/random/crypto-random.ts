// Adapter da porta Random (ADR-009 D1): o jitter do retry do router, com o CSPRNG do node:crypto.
import { randomInt } from "node:crypto";

import type { Random } from "../../application/ports/random.js";

/** O `randomInt` exige `max - min < 2^48`. A granularidade sobra para o jitter. */
const RANGE = 2 ** 48 - 1;

/** Número em [0, 1). */
export const cryptoRandom: Random = Object.freeze({ next: () => randomInt(0, RANGE) / RANGE });
