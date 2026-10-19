// onRequest: tipo de mídia e Content-Encoding conferidos ANTES de ler o corpo (ADR-007 D1 e D2;
// SR-07; threat-model T18.6). O 415 do parser do Fastify fica como segunda camada.
import type { FastifyReply, FastifyRequest } from "fastify";

import { sendApiError } from "../api-error.js";

/** Métodos que sempre exigem corpo JSON, mesmo vazio. */
const BODY_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH"]);

/** Ausente ou exatamente `identity`. Sem descompressão de requisição (anti-bomba). */
export function isIdentityEncoding(value: string | undefined): boolean {
  return value === undefined || value.trim().toLowerCase() === "identity";
}

/** Essência `application/json` e, se houver `charset`, só `utf-8` (RFC 8259). */
export function isUtf8Json(value: string | undefined): boolean {
  if (value === undefined) return false;
  const [essence = "", ...params] = value.split(";");
  if (essence.trim().toLowerCase() !== "application/json") return false;
  for (const param of params) {
    const eq = param.indexOf("=");
    const name = (eq === -1 ? param : param.slice(0, eq)).trim().toLowerCase();
    if (name !== "charset") continue;
    if (eq === -1) return false;
    const raw = param.slice(eq + 1).trim().toLowerCase();
    const unquoted = raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    if (unquoted !== "utf-8") return false;
  }
  return true;
}

function carriesBody(request: FastifyRequest): boolean {
  const length = request.headers["content-length"];
  return request.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0");
}

export async function mediaTypeHook(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> {
  const acceptable =
    isIdentityEncoding(request.headers["content-encoding"]) &&
    (!(BODY_METHODS.has(request.method) || carriesBody(request)) || isUtf8Json(request.headers["content-type"]));
  return acceptable ? undefined : sendApiError(reply, request.id, "PAYLOAD_INVALIDO", { status: 415 });
}
