// Escritor SSE do POST /v1/analyze (ADR-017 D6). Cada evento é `event: <type>\ndata: <json>\n\n`, com um único
// `data:`, validado pelo AnalysisStreamEventSchema antes de ser escrito. O JSON.stringify escapa CR e LF dentro
// das strings, então nenhum campo quebra o enquadramento (U+2028 não é fim de linha no SSE). Sem `id:` e sem
// `retry:`: o cliente não reconecta, porque uma reconexão repetiria a análise.
import { Readable } from "node:stream";

import { type AnalysisStreamEvent, AnalysisStreamEventSchema } from "@trampo/contracts/api";

export const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";

/** Cabeçalhos do stream (ADR-017 D6). Sem Content-Length: o corpo é enviado em partes. */
export const SSE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "x-accel-buffering": "no",
} as const;

export class SseEventContractError extends Error {
  override readonly name = "SseEventContractError";
}

/** Um evento SSE. Lança se o evento sai do contrato; a mensagem é fixa (as issues do Zod podem ecoar valores). */
export function encodeSseEvent(event: AnalysisStreamEvent): string {
  const parsed = AnalysisStreamEventSchema.safeParse(event);
  if (!parsed.success) throw new SseEventContractError("Evento fora do AnalysisStreamEventSchema.");
  return `event: ${parsed.data.type}\ndata: ${JSON.stringify(parsed.data)}\n\n`;
}

/**
 * O corpo da resposta, entregue ao Fastify por `reply.send(readable)`, sem hijack. Depois do fim, ou com o cliente
 * fora (o Fastify destrói o readable quando a conexão fecha antes), nada mais é escrito.
 */
export class SseStream {
  readonly readable = new Readable({ read: () => undefined });
  #ended = false;

  get open(): boolean {
    return !this.#ended && !this.readable.destroyed;
  }

  /** `false`: o stream já fechou e o evento foi descartado. Lança se o evento sai do contrato (nada é escrito). */
  write(event: AnalysisStreamEvent): boolean {
    if (!this.open) return false;
    this.readable.push(encodeSseEvent(event));
    return true;
  }

  end(): void {
    if (!this.open) return;
    this.#ended = true;
    this.readable.push(null);
  }
}
