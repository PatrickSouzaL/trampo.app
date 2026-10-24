// O perfil válido mais pesado do contrato (ADR-021 D3, D10 e §3, critério 9): exatamente 12.288 bytes de JSON, quase
// tudo em ideogramas de 4 bytes sorteados de um alfabeto de 42.720 (CJK Ext. B). A compressão do TOAST (pglz ou
// lz4) só acha repetição, e sorteio sem padrão não tem: o perfil não parece menor do que é no banco. A semente é fixa: uma falha no job db se reproduz igual. O teste deste
// gerador (exatidão do byte, validade e semente) roda no `pnpm test`; o check de 16 KiB, no `test:db`.
import {
  BenefitCategorySchema,
  BrazilUfSchema,
  ContractTypeSchema,
  LanguageCodeSchema,
  RedFlagSignalSchema,
  SeniorityLevelSchema,
  USER_CRITERIA_MAX_JSON_BYTES,
  UserCriteriaSchema,
  WorkModelSchema,
  userCriteriaJsonBytes,
  type UserCriteria,
} from "@trampo/contracts";

/** CJK Unified Ideographs Extension B: 42.720 letras `Lo`, todas com 4 bytes em UTF-8 e sem caixa. */
export const IDEOGRAPH_FIRST = 0x2_0000;
export const IDEOGRAPH_COUNT = 0xa6e0;

export const HEAVIEST_CRITERIA_SEED = 0x7a3b_15c1;

/** Tetos do contrato: tags de 40 code points e cidades de 80. */
const TAG_LENGTH = 40;
const CITY_LENGTH = 80;
const LIST_CAPS = [
  ["mustHave", 15],
  ["niceToHave", 30],
  ["dealBreakers", 15],
] as const;
const CITY_CAP = 10;
/** Bytes deixados para as notas, que acertam o alvo no byte (até 500 code points no contrato). */
const NOTES_ROOM = 1_600;

const WEIGHTED = { level: "ponderado", weight: 5 } as const;

/** mulberry32: determinístico, sem dependência e bom o bastante para espalhar o alfabeto. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

export function heaviestCriteria(seed: number = HEAVIEST_CRITERIA_SEED): UserCriteria {
  const next = prng(seed);
  const ideographs = (length: number): string =>
    Array.from({ length }, () => String.fromCodePoint(IDEOGRAPH_FIRST + Math.floor(next() * IDEOGRAPH_COUNT))).join("");

  const stack = { mustHave: [] as string[], niceToHave: [] as string[], dealBreakers: [] as string[] };
  const cities: string[] = [];
  const build = (): UserCriteria => ({
    schemaVersion: 1,
    workModel: { accepted: [...WorkModelSchema.options], importance: WEIGHTED },
    seniority: { accepted: [...SeniorityLevelSchema.options], importance: WEIGHTED },
    contractType: { accepted: [...ContractTypeSchema.options], importance: WEIGHTED },
    salary: { minimum: 9_999_999.123456789, currency: "BRL", period: "hora", importance: WEIGHTED },
    location: { acceptedUfs: [...BrazilUfSchema.options], acceptedCities: [...cities], importance: WEIGHTED },
    stack: {
      mustHave: [...stack.mustHave],
      niceToHave: [...stack.niceToHave],
      dealBreakers: [...stack.dealBreakers],
      dealBreakerScope: "qualquer_mencao",
      niceToHaveWeight: 5,
    },
    languages: {
      proficiencies: LanguageCodeSchema.options.slice(0, 8).map((language) => ({ language, level: "intermediario" })),
      importance: WEIGHTED,
    },
    benefits: { desired: [...BenefitCategorySchema.options], importance: WEIGHTED },
    redFlagTolerance: Object.fromEntries(
      RedFlagSignalSchema.options.map((signal) => [signal, "eliminatorio"]),
    ) as UserCriteria["redFlagTolerance"],
    notes: null,
  });
  const budget = USER_CRITERIA_MAX_JSON_BYTES - NOTES_ROOM;

  // Enche as listas em ordem até a próxima entrada passar do orçamento; as notas acertam o resto.
  const slots: { readonly list: string[]; readonly cap: number; readonly length: number }[] = [
    ...LIST_CAPS.map(([name, cap]) => ({ list: stack[name], cap, length: TAG_LENGTH })),
    { list: cities, cap: CITY_CAP, length: CITY_LENGTH },
  ];
  fill: for (const slot of slots) {
    while (slot.list.length < slot.cap) {
      slot.list.push(ideographs(slot.length));
      if (userCriteriaJsonBytes(build()) > budget) {
        slot.list.pop();
        break fill;
      }
    }
  }

  // Trocar `null` por `"…"` soma `n − 2` bytes: n bytes de notas em ideogramas e, no fim, até 3 letras ASCII.
  const notesBytes = USER_CRITERIA_MAX_JSON_BYTES - userCriteriaJsonBytes(build()) + 2;
  // O NOTES_ROOM mais uma entrada (até 323 bytes) dá no máximo 483 code points; o parse recusaria acima de 500.
  const notes = ideographs(Math.floor(notesBytes / 4)) + "x".repeat(notesBytes % 4);
  return UserCriteriaSchema.parse({ ...build(), notes });
}
