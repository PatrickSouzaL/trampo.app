// Cliente REST do Upstash (ADR-014 D2 e D3): o ÚNICO lugar que fala com o Redis. Sem SDK: um `fetch` para
// `POST {url}/multi-exec` (transação MULTI/EXEC, atômica no servidor) com o token só no header.
//
// Falha fechado em qualquer desvio: status ≠ 200, redirecionamento, prazo, corpo acima do teto, UTF-8 ou JSON
// inválido, array do tamanho errado, item com `error` (o Upstash segue executando os outros comandos da
// transação) ou tipo inesperado → `null`. Nunca rejeita. Nada do token, da URL ou dos comandos vai para log.
import { z } from "zod";

export type RedisArgument = string | number;
export type RedisCommand = readonly [string, ...RedisArgument[]];
export type RedisValue = number | string | null;

export interface RedisTransactions {
  /** Resultados na ordem dos comandos, ou `null` se qualquer coisa saiu do contrato. Nunca rejeita. */
  exec(commands: readonly RedisCommand[], signal: AbortSignal): Promise<readonly RedisValue[] | null>;
}

export const UPSTASH_CLIENT_POLICY = {
  /** Teto de cada transação. O guarda da aplicação tem 250 ms; a borda inteira tem 80 ms de orçamento típico. */
  timeoutMs: 200,
  maxCommands: 16,
  maxResponseBytes: 16 * 1024,
  maxStringReplyChars: 64,
} as const;

export interface UpstashRestClientConfig {
  readonly url: URL;
  readonly token: string;
  /** Só para os testes encurtarem o prazo. */
  readonly timeoutMs?: number;
}

const ResponseSchema = z
  .array(
    z.strictObject({
      result: z.union([z.int(), z.string().max(UPSTASH_CLIENT_POLICY.maxStringReplyChars), z.null()]),
    }),
  )
  .max(UPSTASH_CLIENT_POLICY.maxCommands);

/** Lê o corpo contando bytes; `null` acima do teto. Sair do for-await cancela o resto do stream. */
async function readCapped(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<string | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) return null;
    chunks.push(chunk);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

export function createUpstashRestClient(config: UpstashRestClientConfig): RedisTransactions {
  const endpoint = new URL("/multi-exec", config.url);
  const headers = { authorization: `Bearer ${config.token}`, "content-type": "application/json" };
  const timeoutMs = config.timeoutMs ?? UPSTASH_CLIENT_POLICY.timeoutMs;

  return {
    async exec(commands, signal) {
      if (commands.length === 0 || commands.length > UPSTASH_CLIENT_POLICY.maxCommands) return null;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(commands),
          // Seguir um redirecionamento levaria o token para outro host.
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
        if (response.status !== 200 || response.body === null) {
          await response.body?.cancel();
          return null;
        }
        const text = await readCapped(response.body, UPSTASH_CLIENT_POLICY.maxResponseBytes);
        if (text === null) return null;
        const parsed = ResponseSchema.safeParse(JSON.parse(text));
        if (!parsed.success || parsed.data.length !== commands.length) return null;
        return parsed.data.map((item) => item.result);
      } catch {
        return null;
      }
    },
  };
}
