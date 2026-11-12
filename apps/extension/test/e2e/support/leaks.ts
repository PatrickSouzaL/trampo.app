// Lógica das provas negativas do 05c-3 (ADR-004 §4.5, SR-23, CA-04), sem navegador: o que os coletores do
// `auth-negative.e2e.test.ts` procuram e como contam. Os coletores (espião, heap, rede, console, mundos da aba) são cola
// de navegador e ficam fora daqui; cada "0" deles tem um controle positivo no próprio E2E (condição 3 do `[APPSEC]`).
import { canaryForms } from "./canaries";
import type { FakeState, RequestRecord } from "./fake-servers";

/** §4.5 item 3: nenhum trecho de canário com 16 caracteres ou mais no heap do painel nem no da aba. */
export const HEAP_FRAGMENT_CHARS = 16;

/** Os caracteres das três formas de todo canário (base64url, hex, UUID, `.` do JWS e do envelope e o `%` do escape). */
const FRAGMENT_ALPHABET = /^[\w.%-]+$/;
const FRAGMENT_RUN = new RegExp(`[\\w.%-]{${HEAP_FRAGMENT_CHARS},}`, "g");

export interface CanaryFragments {
  /** Cada trecho de 16 caracteres, ligado aos índices dos canários que o contêm (o cifrado está dentro do envelope). */
  readonly windows: ReadonlyMap<string, readonly number[]>;
  readonly canaries: readonly string[];
}

/**
 * Todos os trechos de 16 caracteres das três formas de cada canário. Canário mais curto que o trecho, ou com caractere fora
 * do alfabeto da busca, é erro do teste: a busca nunca o acharia, e o "0" seria falso.
 */
export function canaryFragments(canaries: Iterable<string>): CanaryFragments {
  const list = [...canaries];
  const windows = new Map<string, number[]>();
  list.forEach((canary, index) => {
    if (canary.length < HEAP_FRAGMENT_CHARS) throw new Error(`canário com menos de ${HEAP_FRAGMENT_CHARS} caracteres: a busca por trecho não o cobre`);
    for (const form of canaryForms(canary)) {
      if (!FRAGMENT_ALPHABET.test(form)) throw new Error("canário com caractere fora do alfabeto da busca por trecho");
      for (let start = 0; start + HEAP_FRAGMENT_CHARS <= form.length; start += 1) {
        const window = form.slice(start, start + HEAP_FRAGMENT_CHARS);
        const owners = windows.get(window);
        if (owners === undefined) windows.set(window, [index]);
        else if (!owners.includes(index)) owners.push(index);
      }
    }
  });
  return { windows, canaries: list };
}

/** Os canários com algum trecho de 16 caracteres no texto, sem repetição e na ordem da lista. */
export function findCanaryFragments(haystack: string, fragments: CanaryFragments): string[] {
  const hit = new Set<number>();
  for (const [run] of haystack.matchAll(FRAGMENT_RUN)) {
    for (let start = 0; start + HEAP_FRAGMENT_CHARS <= run.length; start += 1) {
      for (const index of fragments.windows.get(run.slice(start, start + HEAP_FRAGMENT_CHARS)) ?? []) hit.add(index);
    }
  }
  return fragments.canaries.filter((_, index) => hit.has(index));
}

/** Um valor do CDP (`Runtime.RemoteObject`) como texto: o valor, a descrição e a prévia das propriedades. */
interface RemoteObject {
  readonly value?: unknown;
  readonly unserializableValue?: string;
  readonly description?: string;
  readonly preview?: { readonly properties?: ReadonlyArray<{ readonly name: string; readonly value?: string }> };
}

const remoteText = (o: RemoteObject): string[] => [
  ...(o.value === undefined ? [] : [typeof o.value === "string" ? o.value : JSON.stringify(o.value)]),
  ...(o.unserializableValue === undefined ? [] : [o.unserializableValue]),
  ...(o.description === undefined ? [] : [o.description]),
  ...(o.preview?.properties ?? []).flatMap((p) => [p.name, p.value ?? ""]),
];

export interface ConsoleEvent {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

/** O texto de cada evento de console do §4.5 item 9 que o coletor procura; outro método é erro do coletor. */
export function consoleText({ method, params }: ConsoleEvent): string {
  if (method === "Runtime.consoleAPICalled") return (params["args"] as RemoteObject[]).flatMap(remoteText).join("\n");
  if (method === "Runtime.exceptionThrown") {
    const details = params["exceptionDetails"] as { text: string; url?: string; exception?: RemoteObject };
    return [details.text, details.url ?? "", ...(details.exception === undefined ? [] : remoteText(details.exception))].join("\n");
  }
  if (method === "Log.entryAdded") {
    const entry = params["entry"] as { text: string; url?: string; args?: RemoteObject[] };
    return [entry.text, entry.url ?? "", ...(entry.args ?? []).flatMap(remoteText)].join("\n");
  }
  throw new Error(`evento fora do §4.5 item 9: ${method}`);
}

/**
 * §4.5 item 10, no total do que os falsos receberam: cada pedido que fere a regra, descrito sem valor. A troca e a
 * renovação vão sem `Authorization` e sem `Cookie`; o logout e a análise (os POST) levam o Bearer, e só eles (cenário 12
 * do §4.4, 04b-3); o BFF só ouve a origem exata da
 * extensão; o Supabase falso só vê a navegação do `authorize`, sem `Authorization` e sem `Origin` de extensão; o chromiumapp
 * só o GET do retorno, sem nada (§4.4, "Emenda do 05c-1").
 */
export function requestViolations(state: FakeState, extensionOrigin: string, chromiumappPaths: readonly string[] = ["/auth"]): string[] {
  const out: string[] = [];
  const flag = (r: RequestRecord, rule: string) => out.push(`${r.server} ${r.method} ${r.path}: ${rule}`);
  for (const r of state.requests) {
    if (r.server === "bff") {
      if (r.origin !== extensionOrigin) flag(r, "origem diferente da extensão");
      if (r.cookie) flag(r, "Cookie");
      const isLogout = r.method === "POST" && r.path === "/v1/auth/logout";
      const isAnalyze = r.method === "POST" && r.path === "/v1/analyze";
      if (isLogout && !r.authorization) flag(r, "logout sem Bearer");
      if (isAnalyze && !r.authorization) flag(r, "análise sem Bearer");
      if (!isLogout && !isAnalyze && r.authorization) flag(r, "Authorization fora do logout e da análise");
    } else if (r.server === "supabase") {
      if (r.method !== "GET" || r.path !== "/auth/v1/authorize") flag(r, "fora do authorize");
      if (r.authorization) flag(r, "Authorization");
      if (r.origin?.startsWith("chrome-extension://") === true) flag(r, "Origin de extensão");
    } else {
      if (r.method !== "GET" || !chromiumappPaths.includes(r.path)) flag(r, "fora do retorno");
      if (r.origin !== null || r.authorization || r.cookie) flag(r, "origem, Authorization ou Cookie");
    }
  }
  return out;
}

/**
 * O que cada build do E2E tem de ser, conferido no manifesto logo depois do build (ADR-004 §4.4): o `wxt build` também
 * lê os `.env` da pasta da extensão, e um valor de lá que vazasse para o build do teste poria uma chave ou uma origem real
 * no E2E. O "fechado" não tem `key` e sai com `connect-src 'none'`; o "auth" tem a `key` efêmera e só a API falsa.
 */
export function builtManifestViolations(manifest: Readonly<Record<string, unknown>>, expected: { readonly key?: string; readonly apiOrigin?: string }): string[] {
  const out: string[] = [];
  if (manifest["key"] !== expected.key) out.push(expected.key === undefined ? "key presente no build sem chave" : "key diferente da efêmera");
  const csp = (manifest["content_security_policy"] as { extension_pages?: unknown } | undefined)?.extension_pages;
  const connect = typeof csp === "string" ? /connect-src ([^;]*)$/.exec(csp)?.[1] : undefined;
  if (connect !== (expected.apiOrigin ?? "'none'")) out.push("connect-src diferente do declarado no build");
  return out;
}
