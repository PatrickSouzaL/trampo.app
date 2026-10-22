// Toda resposta de erro da API é um ApiError do contrato público: acionável e sem vazamento
// (sem stack trace, sem detalhes do Zod, sem nomes internos). contratos-zod §4.7.
import { ApiErrorSchema, type ApiError, type ApiErrorCode } from "@trampo/contracts/api";
import type { FastifyReply } from "fastify";

/** Status HTTP e mensagem padrão de cada código (pt-BR, texto seguro para o painel). */
const CATALOG: Record<ApiErrorCode, { status: number; message: string }> = {
  NAO_AUTENTICADO: { status: 401, message: "Sessão expirada. Entre de novo para continuar." },
  PROIBIDO: { status: 403, message: "Recurso não disponível." },
  PAYLOAD_GRANDE_DEMAIS: { status: 413, message: "O texto enviado é grande demais." },
  PAYLOAD_INVALIDO: { status: 400, message: "Os dados enviados não são válidos." },
  TEXTO_CURTO_DEMAIS: { status: 422, message: "O texto da vaga é curto demais para analisar." },
  CRITERIOS_NAO_CONFIGURADOS: { status: 409, message: "Configure os seus critérios no portal antes de analisar." },
  LIMITE_DE_TAXA: { status: 429, message: "Muitas análises seguidas. Tente de novo em instantes." },
  COTA_DIARIA_ESGOTADA: { status: 429, message: "A cota de análises de hoje acabou. Volte amanhã." },
  SERVICO_INDISPONIVEL: { status: 503, message: "Serviço indisponível no momento. Tente de novo em instantes." },
  ERRO_INTERNO: { status: 500, message: "Erro interno. Tente de novo em instantes." },
};

export interface ApiErrorReply {
  readonly status: number;
  readonly body: ApiError;
}

/**
 * Monta o corpo e o status. O corpo é autovalidado contra o contrato; se algo sair do contrato,
 * cai num ERRO_INTERNO fixo (a API nunca emite um erro fora do schema).
 */
export function apiError(
  code: ApiErrorCode,
  requestId: string | null,
  options: { status?: number; retryAfterSeconds?: number | null } = {},
): ApiErrorReply {
  const entry = CATALOG[code];
  const candidate = { code, message: entry.message, requestId, retryAfterSeconds: options.retryAfterSeconds ?? null };
  const parsed = ApiErrorSchema.safeParse(candidate);
  if (parsed.success) return { status: options.status ?? entry.status, body: parsed.data };
  return {
    status: 500,
    body: { code: "ERRO_INTERNO", message: CATALOG.ERRO_INTERNO.message, requestId: null, retryAfterSeconds: null },
  };
}

/**
 * Responde um ApiError a partir de um hook. Devolve o reply para o hook async encerrar o ciclo. Com
 * `retryAfterSeconds`, o mesmo valor vai no corpo e no cabeçalho `Retry-After` (429 do ADR-014 D9).
 */
export function sendApiError(
  reply: FastifyReply,
  requestId: string,
  code: ApiErrorCode,
  options: { status?: number; retryAfterSeconds?: number } = {},
): FastifyReply {
  const { status, body } = apiError(code, requestId, options);
  if (body.retryAfterSeconds !== null) void reply.header("retry-after", String(body.retryAfterSeconds));
  return reply.code(status).send(body);
}
