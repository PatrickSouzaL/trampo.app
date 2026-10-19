// Erros de socket antes de existir requisição (timeout de recepção, headers grandes demais, HTTP
// malformado) também saem como ApiError (ADR-007 D4). O padrão do Fastify devolvia JSON fora do
// contrato. Sem requisição, não há requestId.
import { STATUS_CODES } from "node:http";
import type { Socket } from "node:net";

import type { ApiErrorCode } from "@trampo/contracts/api";

import { apiError } from "../api-error.js";

function classify(code: string | undefined): { status: number; code: ApiErrorCode } {
  if (code === "ERR_HTTP_REQUEST_TIMEOUT") return { status: 408, code: "PAYLOAD_INVALIDO" };
  if (code === "HPE_HEADER_OVERFLOW") return { status: 431, code: "PAYLOAD_GRANDE_DEMAIS" };
  return { status: 400, code: "PAYLOAD_INVALIDO" };
}

export function edgeClientErrorHandler(error: Error & { code?: string }, socket: Socket): void {
  // Conexão resetada: não há para quem responder.
  if (error.code === "ECONNRESET" || socket.destroyed) return;
  const { status, code } = classify(error.code);
  const json = JSON.stringify(apiError(code, null).body);
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ""}\r\n` +
        "Content-Type: application/json; charset=utf-8\r\n" +
        `Content-Length: ${Buffer.byteLength(json)}\r\n` +
        "Connection: close\r\n\r\n" +
        json,
    );
  }
  socket.destroy();
}
