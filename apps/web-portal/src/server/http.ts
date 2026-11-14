// Auxiliares HTTP dos clientes do servidor do portal (o GoTrue, ADR-027 D1, e a API, ADR-028 D2): leitura com teto,
// UTF-8 estrito, JSON sem chave de protótipo e a classificação da falha do `fetch`. Nada daqui vai a log.

/** Códigos do Node para a conexão que nem abriu. */
const NOT_CONNECTED_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);
/** Mensagem do undici para o 3xx com `redirect: "error"`. */
const REDIRECT_REFUSED = "unexpected redirect";
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const PROTOTYPE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * O `fetch` rejeitou: `nao_conectou` quando a conexão nem abriu ou quando a resposta foi um redirecionamento (o pedido
 * não foi processado); `talvez` para o resto (prazo, aborto, socket fechado), que pode ter acontecido depois do envio.
 */
export function fetchFailure(error: unknown): "nao_conectou" | "talvez" {
  // O fetch do Node sempre rejeita com um Error; o `cause` dele só existe nas falhas de rede.
  const cause: unknown = (error as Error).cause;
  if (!(cause instanceof Error)) return "talvez";
  const code = (cause as NodeJS.ErrnoException).code;
  if (code !== undefined && NOT_CONNECTED_CODES.has(code)) return "nao_conectou";
  return cause.message === REDIRECT_REFUSED ? "nao_conectou" : "talvez";
}

export async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // O corpo já morreu; não há o que soltar.
  }
}

/** Lê no máximo `limit` bytes; `null` se passar (e o resto do stream é cancelado sem ler). */
export async function readCapped(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    total += next.value.byteLength;
    if (total > limit) {
      // Se o cancelamento falhar, quem chama já trata a exceção como resposta perdida.
      await reader.cancel();
      return null;
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks);
}

/** Texto UTF-8 estrito; `null` com byte inválido. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * JSON da resposta com teto, `application/json`, UTF-8 estrito e sem chaves de protótipo; `undefined` em qualquer
 * desvio. Lança se o socket cair no meio do corpo (quem chama classifica).
 */
export async function readJson(response: Response, limit: number): Promise<unknown> {
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (response.body === null || type !== "application/json") {
    await discard(response);
    return undefined;
  }
  const bytes = await readCapped(response.body, limit);
  if (bytes === null) return undefined;
  const text = decodeUtf8(bytes);
  if (text === null) return undefined;
  try {
    let hostile = false;
    const value: unknown = JSON.parse(text, (key, inner: unknown) => {
      if (PROTOTYPE_KEYS.has(key)) hostile = true;
      return inner;
    });
    return hostile ? undefined : value;
  } catch {
    return undefined;
  }
}
