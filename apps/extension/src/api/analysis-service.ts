// Envio da vaga à API no Service Worker (F1-EXT-04 parte 2, 04b-1; ADR-025 §6 D10 a D12; ADR-004 D11.1 e D11.4). Só
// envia com o consentimento vigente (conferido antes do accessToken e de novo antes de cada transmissão), uma vaga
// pronta e um token. O 401 da API vale uma renovação, com o token capturado no envio, e um reenvio do mesmo pedido.
// Ao painel vão só eventos do AnalysisStreamEventSchema; o erro sintetizado aqui só tem texto do catálogo do SW, e o
// log, só motivos da lista fechada: nunca texto da vaga, token, requestId, status ou corpo (T23).
import { type AnalysisStreamEvent, AnalysisStreamEventSchema, type AnalyzeJobRequestInput, type ApiError, ApiErrorSchema } from "@trampo/contracts/api";

import type { CapturedJob } from "../capture/capture";
import type { ConsentService } from "../consent/consent-service";
import { createPanelHub } from "../messaging/panel-hub";
import type { AnalysisMode } from "../messaging/protocol";
import type { PanelPort } from "../messaging/worker-port";
import type { AuthService } from "../auth/auth-service";
import type { AnalyzeResult, ApiClient } from "./api-client";
import { type TerminalEvent, createSseReader } from "./sse-reader";

export const ANALYSIS_LOG_REASONS = [
  "analise_sem_api",
  "analise_sem_consentimento",
  "analise_sem_vaga",
  "analise_sem_token",
  "analise_em_curso",
  "analise_recusada",
  "analise_indisponivel",
  "analise_violacao",
  "analise_erro_servidor",
  "analise_falha_interna",
] as const;
export type AnalysisLogReason = (typeof ANALYSIS_LOG_REASONS)[number];

/** Os códigos que o SW sintetiza (D11) e o texto fixo de cada um. O painel não mostra o `message` (ADR-025 D5). */
export const LOCAL_ERROR_MESSAGES = Object.freeze({
  ERRO_INTERNO: "Falha interna da extensão ao enviar a vaga.",
  SERVICO_INDISPONIVEL: "O servidor do Trampo não respondeu a tempo.",
  NAO_AUTENTICADO: "A sessão não foi aceita pelo servidor.",
  LIMITE_DE_TAXA: "Muitos envios em pouco tempo.",
} as const);
type LocalCode = keyof typeof LOCAL_ERROR_MESSAGES;

export interface AnalysisServiceDeps {
  /** O cliente da composição (ADR-025 §6 D13); ausente no build sem as duas origens. */
  readonly api: Pick<ApiClient, "analyze"> | undefined;
  readonly auth: Pick<AuthService, "accessToken" | "onUnauthorized">;
  readonly consent: Pick<ConsentService, "isGranted">;
  /** A vaga da captura `pronto`, ou nada. */
  readonly job: () => Promise<CapturedJob | undefined>;
  readonly randomUUID: () => string;
  readonly log: (motivo: AnalysisLogReason) => void;
}

export interface AnalysisService {
  /** Porta confiável: recebe os eventos das análises seguintes. O handshake não muda. */
  attach(port: PanelPort): void;
  /** Clique em "Analisar vaga" ou "Reanalisar com IA". Nunca rejeita. */
  analyze(mode: AnalysisMode): Promise<void>;
  /** A captura mudou: a análise em curso não chega mais ao painel, e uma nova já pode começar. */
  cancel(): void;
}

function localError(code: LocalCode, requestId: string | null): TerminalEvent {
  return AnalysisStreamEventSchema.parse({
    type: "error",
    error: { code, message: LOCAL_ERROR_MESSAGES[code], requestId, retryAfterSeconds: null },
  }) as TerminalEvent;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** O `ApiError` do servidor vale se for do contrato e deste pedido (ou sem pedido). */
function serverError(raw: unknown, requestId: string): ApiError | undefined {
  const parsed = ApiErrorSchema.safeParse(raw);
  return parsed.success && (parsed.data.requestId === null || parsed.data.requestId === requestId) ? parsed.data : undefined;
}

/** O código pelo status, quando o corpo não é um `ApiError` deste pedido. O 401 sem ele não pede login (T30). */
function codeForStatus(status: number): LocalCode {
  if (status === 429) return "LIMITE_DE_TAXA";
  if (status === 401 || status >= 500) return "SERVICO_INDISPONIVEL";
  return "ERRO_INTERNO";
}

type Sent =
  | { readonly kind: "terminal"; readonly event: TerminalEvent; readonly motivo: AnalysisLogReason | null }
  | { readonly kind: "nao_autenticado" }
  | { readonly kind: "cancelado" };

const CANCELADO: Sent = { kind: "cancelado" };

export function createAnalysisService(deps: AnalysisServiceDeps): AnalysisService {
  const hub = createPanelHub();
  // A captura que muda soma a geração: nada da análise antiga chega mais ao painel.
  let generation = 0;
  let running = false;

  // Só sai o que a geração vigente produziu: o leitor recebe pedaço só com ela (o `onText` responde `parar` depois do
  // cancelamento), e o terminal só sai depois de conferi-la.
  const emit = (event: AnalysisStreamEvent): void => {
    hub.broadcast({ kind: "stream", event });
  };
  const fail = (motivo: AnalysisLogReason, code: LocalCode, requestId: string | null): Sent => ({
    kind: "terminal",
    event: localError(code, requestId),
    motivo,
  });

  /** O que a API respondeu, na tabela do D10. */
  const classify = (result: AnalyzeResult, requestId: string, end: () => ReturnType<ReturnType<typeof createSseReader>["end"]>): Sent => {
    if (!result.ok) {
      return result.reason === "sem_resposta" ? fail("analise_indisponivel", "SERVICO_INDISPONIVEL", requestId) : fail("analise_violacao", "ERRO_INTERNO", requestId);
    }
    if (!result.stream) {
      const error = serverError(parseJson(result.body), requestId);
      if (error === undefined) return fail("analise_violacao", codeForStatus(result.status), requestId);
      if (result.status === 401 && error.code === "NAO_AUTENTICADO") return { kind: "nao_autenticado" };
      return { kind: "terminal", event: { type: "error", error }, motivo: "analise_erro_servidor" };
    }
    if (result.fim === "queda") return fail("analise_indisponivel", "SERVICO_INDISPONIVEL", requestId);
    if (result.fim !== "completo") return fail("analise_violacao", "ERRO_INTERNO", requestId);
    const ended = end();
    if (ended.kind !== "completo") {
      return ended.kind === "incompleto" ? fail("analise_indisponivel", "SERVICO_INDISPONIVEL", requestId) : fail("analise_violacao", "ERRO_INTERNO", requestId);
    }
    const { terminal } = ended;
    if (terminal.type === "error" && serverError(terminal.error, requestId) === undefined) return fail("analise_violacao", "ERRO_INTERNO", requestId);
    return { kind: "terminal", event: terminal, motivo: null };
  };

  /** Uma transmissão: o consentimento e a geração conferidos logo antes, e o stream lido pelo leitor estrito. */
  const transmit = async (gen: number, api: Pick<ApiClient, "analyze">, body: AnalyzeJobRequestInput, token: string, first: boolean): Promise<Sent> => {
    if (!(await deps.consent.isGranted())) return fail("analise_sem_consentimento", "ERRO_INTERNO", first ? null : body.requestId);
    if (gen !== generation) return CANCELADO;
    const reader = createSseReader(emit);
    const result = await api.analyze({ body, accessToken: token }, (text) => (gen === generation && reader.push(text) === "seguir" ? "seguir" : "parar"));
    if (gen !== generation) return CANCELADO;
    return classify(result, body.requestId, () => reader.end());
  };

  const run = async (gen: number, mode: AnalysisMode): Promise<Sent> => {
    const api = deps.api;
    if (api === undefined) return fail("analise_sem_api", "ERRO_INTERNO", null);
    if (!(await deps.consent.isGranted())) return fail("analise_sem_consentimento", "ERRO_INTERNO", null);
    const job = await deps.job();
    if (job === undefined) return fail("analise_sem_vaga", "ERRO_INTERNO", null);
    const token = await deps.auth.accessToken();
    if (token === undefined) return fail("analise_sem_token", "SERVICO_INDISPONIVEL", null);
    const body: AnalyzeJobRequestInput = {
      schemaVersion: 1,
      requestId: deps.randomUUID(),
      source: { platform: job.platform, extractorVersion: job.extractorVersion },
      job: { titleHint: null, text: job.text, clientTruncated: job.truncated },
      mode,
    };
    const sent = await transmit(gen, api, body, token, true);
    if (sent.kind !== "nao_autenticado") return sent;
    // D11.4: o token que levou o 401 é o capturado no envio, nunca um lido depois.
    const renewed = await deps.auth.onUnauthorized(1, token);
    if (renewed === undefined) return fail("analise_recusada", "NAO_AUTENTICADO", body.requestId);
    const again = await transmit(gen, api, body, renewed, false);
    if (again.kind !== "nao_autenticado") return again;
    await deps.auth.onUnauthorized(2, renewed);
    return fail("analise_recusada", "NAO_AUTENTICADO", body.requestId);
  };

  return {
    attach(port) {
      hub.add(port);
    },
    async analyze(mode) {
      if (running) {
        deps.log("analise_em_curso");
        return;
      }
      running = true;
      const gen = generation;
      let sent: Sent;
      try {
        sent = await run(gen, mode);
      } catch {
        sent = fail("analise_falha_interna", "ERRO_INTERNO", null);
      }
      // Cancelada: a análise nova (se houver) é dona do `running`, e nada desta sai. O `cancelado` só volta com a
      // geração trocada, e o `nao_autenticado` nunca sai do `run`: com a geração vigente, o resultado é um terminal.
      if (gen !== generation || sent.kind !== "terminal") return;
      running = false;
      if (sent.motivo !== null) deps.log(sent.motivo);
      emit(sent.event);
    },
    cancel() {
      generation += 1;
      running = false;
    },
  };
}
