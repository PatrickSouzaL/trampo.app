// Métodos de autenticação (`amr`) aceitos pelo verificador do JWT (ADR-004 D6; emenda ao ADR-013 D4), lidos em
// falha fechada. Padrão `oauth`: só login social entra na API. `password` existe só para a pilha local do Supabase
// (`NODE_ENV=test` exato) e derruba a subida em qualquer outro ambiente. Lista separada por vírgula, sem espaço, sem
// repetição e na caixa do GoTrue. Nenhuma mensagem repete o valor recebido.
export const AMR_METHODS = ["oauth", "password"] as const;
export type AmrMethod = (typeof AMR_METHODS)[number];

export const DEFAULT_ALLOWED_AMR: readonly [AmrMethod, ...AmrMethod[]] = ["oauth"];

/** Só a pilha local (test:db, contrato do 07h) entra por senha. */
const TEST_ONLY_METHODS: ReadonlySet<AmrMethod> = new Set(["password"]);

export class AllowedAmrConfigError extends Error {
  constructor() {
    super("AUTH_ALLOWED_AMR precisa listar métodos do ADR-004 D6, sem repetição (senha só com NODE_ENV=test)");
    this.name = "AllowedAmrConfigError";
  }
}

const isAmrMethod = (value: string): value is AmrMethod => (AMR_METHODS as readonly string[]).includes(value);

export function readAllowedAmr(source: Readonly<Record<string, string | undefined>>): readonly [AmrMethod, ...AmrMethod[]] {
  const raw = source["AUTH_ALLOWED_AMR"] ?? "";
  if (raw === "") return DEFAULT_ALLOWED_AMR;
  const testStack = source["NODE_ENV"] === "test";
  const methods: AmrMethod[] = [];
  for (const item of raw.split(",")) {
    if (!isAmrMethod(item) || methods.includes(item)) throw new AllowedAmrConfigError();
    if (TEST_ONLY_METHODS.has(item) && !testStack) throw new AllowedAmrConfigError();
    methods.push(item);
  }
  const [first, ...rest] = methods;
  // `split` sempre devolve ao menos um item, e item vazio já foi recusado: `first` existe.
  return [first as AmrMethod, ...rest];
}
