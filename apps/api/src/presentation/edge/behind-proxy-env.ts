// `API_BEHIND_PROXY` (ADR-004 D8 item 4; emenda ao ADR-014, D10), lido em falha fechada. O limitador local antes do JWT
// conta pelo `request.ip`: atrás de um proxy sem `TRUST_PROXY`, todo mundo cai no balde do proxy e o limite vira
// global. A variável declara se há proxy, e o boot recusa a declaração que contradiz o `TRUST_PROXY`. Obrigatória fora
// de `NODE_ENV=test` exato (falha fechada: um ambiente sem `NODE_ENV` conta como produção). A mensagem não repete valor.
export class BehindProxyConfigError extends Error {
  constructor() {
    super("API_BEHIND_PROXY precisa ser true ou false e concordar com o TRUST_PROXY (true exige os saltos do proxy)");
    this.name = "BehindProxyConfigError";
  }
}

/** `trustProxy` é o `TRUST_PROXY` já validado pelo `EdgeEnvSchema`: `false` ou a lista de saltos. */
export function readApiBehindProxy(
  source: Readonly<Record<string, string | undefined>>,
  trustProxy: false | readonly string[],
): boolean {
  const raw = source["API_BEHIND_PROXY"] ?? "";
  const hasHops = trustProxy !== false;
  if (raw === "" && source["NODE_ENV"] === "test") return hasHops;
  if (raw !== "true" && raw !== "false") throw new BehindProxyConfigError();
  const behindProxy = raw === "true";
  if (behindProxy !== hasHops) throw new BehindProxyConfigError();
  return behindProxy;
}
