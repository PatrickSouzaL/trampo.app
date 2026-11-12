// Estado do IdP falso do E2E (ADR-004 §4.4), sem socket: o `authorize` do Supabase falso e as 3 rotas do BFF falso
// dividem o mesmo processo e o mesmo estado. O `authorize` valida os 4 parâmetros e guarda o challenge; a troca confere
// `S256(verifier)` contra ele, com código de uso único e 5 min, e registra o verifier recebido. Assim o PKCE fica provado
// de ponta a ponta, do Service Worker real até o BFF, sem o Supabase real. Os servidores HTTP são o fake-servers.ts.
// O roteiro (05c-2) torna os falsos mais hostis, nunca mais permissivos: ele só age depois das barreiras de sempre.
// 04b-3 (ADR-025 §6.5): o `POST /v1/analyze` em SSE, com o Bearer de uma sessão viva e o corpo do contrato da API, e os
// roteiros da análise e da renovação. O registro de cada análise guarda índice, contagem e hash, nunca token nem texto.
import { createHash } from "node:crypto";

import { type AnalysisStreamEvent, AnalysisStreamEventSchema, AnalyzeJobRequestSchema, type ApiError, type ApiErrorCode } from "@trampo/contracts/api";
import { AUTH_SCHEMA_VERSION, AuthExchangeRequestSchema, AuthLogoutRequestSchema, AuthRefreshRequestSchema } from "@trampo/contracts/auth";
import { z } from "zod";

import { REPORT } from "../../fixtures/stream";
import { type AccessCanary, type EnvelopeCanary, newAccessCanary, newCodeCanary, newEnvelopeCanary, newErrorCanary } from "./canaries";

export const FAKE_AUTH_POLICY = Object.freeze({
  /** O GoTrue aceita o código por 5 min (P8). Vale até o limite, inclusive. */
  codeTtlMs: 300_000,
  /** O JWT de 900 s do HITL-004. */
  expiresIn: 900,
});

const PROVIDERS: ReadonlySet<string> = new Set(["github", "google"]);
/** Exatamente estes 4, cada um uma vez, como o `buildAuthorizeUrl` monta (ADR-004 D3 passo 5). */
const AUTHORIZE_KEYS = ["provider", "redirect_to", "code_challenge", "code_challenge_method"] as const;
/** S256 de 32 bytes em base64url sem preenchimento. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** O `state` de 16 bytes do SW, em base64url. */
const STATE = /^[A-Za-z0-9_-]{22}$/;

export const s256 = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");
/** O hash do texto da vaga no registro da análise: o teste compara com o do texto capturado, sem o falso guardar o texto. */
export const textDigest = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Roteiro do próximo `authorize` válido (ADR-004 §4.4, cenários 7, 8 e 13), consumido nele:
 * - `segurar`: o 302 normal, mas preso no servidor até o `POST /soltar` do canal de controle;
 * - `cancelar`: o IdP negou; volta `error`, `error_code` e `error_description=CANARIO-ERR-<uuid>`, sem código;
 * - `outro_caminho`: o código certo em `/outro`, fora do `redirect_to`;
 * - `fragmento`: o código certo e um `#access_token=` canário (*downgrade* para *implicit*);
 * - `outro_challenge`: um código que a troca recusa, porque nasceu para o challenge de outro fluxo.
 */
export const AUTHORIZE_SCRIPTS = ["segurar", "cancelar", "outro_caminho", "fragmento", "outro_challenge"] as const;
export type AuthorizeScript = (typeof AUTHORIZE_SCRIPTS)[number];

/**
 * Roteiro da análise (04b-3; ADR-025 §6.5 D23), uma fila consumida um passo por pedido **válido** (origem, Bearer vivo,
 * tipo de conteúdo e corpo do contrato já conferidos):
 * - `401` e `503`: o `ApiError` do pedido, antes do stream;
 * - `fora_do_contrato`: 500 com um corpo que não é `ApiError` e leva um canário de erro;
 * - `silencio`: um `stage`, e o stream fica aberto sem mais nada (o prazo de 20 s do SW, e o cancelamento);
 * - `keep_alive`: um comentário `:` no meio do stream; `depois_do_resultado`: um `stage` depois do `result`;
 * - `event_divergente`: o `event:` que não bate com o `type`; `grande_demais`: uma linha sem fim acima de 64 KiB.
 */
export const ANALYZE_SCRIPTS = ["401", "503", "fora_do_contrato", "silencio", "keep_alive", "depois_do_resultado", "event_divergente", "grande_demais"] as const;
export type AnalyzeScript = (typeof ANALYZE_SCRIPTS)[number];

/**
 * Roteiro da renovação (04b-3; cenários 3 e 5 do ADR-004 §4.4), só para a renovação que valeria (corpo do contrato e
 * envelope de sessão viva): `503` (a sessão segue viva) e `segurar` (a resposta fica presa até o `POST /soltar`, que
 * então gira o par; sem o `soltar`, é a renovação que não responde). A troca continua sem roteiro.
 */
export const REFRESH_SCRIPTS = ["503", "segurar"] as const;
export type RefreshScript = (typeof REFRESH_SCRIPTS)[number];

/** O roteiro chega pelo canal de controle e é dado do teste: forma fechada, e ao menos uma chave. */
export const FakeScriptSchema = z
  .strictObject({
    authorize: z.enum(AUTHORIZE_SCRIPTS).optional(),
    /** Quantos logouts com o Bearer vivo, a seguir, respondem 503 sem derrubar a sessão (cenário 14). */
    logout503: z.int().min(1).max(5).optional(),
    analyze: z.array(z.enum(ANALYZE_SCRIPTS)).min(1).max(8).optional(),
    refresh: z.array(z.enum(REFRESH_SCRIPTS)).min(1).max(4).optional(),
    /** O `expiresIn` dos próximos pares emitidos, até o zerar: só encurta a vida do token (cenários 3 e 5). */
    expiresIn: z.int().min(1).max(FAKE_AUTH_POLICY.expiresIn).optional(),
  })
  .refine((s) => Object.values(s).some((value) => value !== undefined));
export type FakeScript = z.infer<typeof FakeScriptSchema>;

/**
 * `hold`: o servidor segura a resposta até o `POST /soltar` (o roteiro `segurar`); com `later`, é ele que diz a resposta
 * na hora de soltar (a renovação presa gira o par só então). `sse`: os trechos do stream 200 em `text/event-stream`; com
 * `hold`, o stream fica aberto depois deles.
 */
export type HttpReply = {
  readonly status: number;
  readonly body?: unknown;
  readonly location?: string;
  readonly hold?: true;
  readonly later?: () => HttpReply;
  readonly sse?: readonly string[];
};

export type AuthorizeRefusal = "parametros" | "provedor" | "metodo" | "challenge" | "redirect_to";
export type ExchangeRefusal = "corpo" | "codigo_desconhecido" | "codigo_vencido" | "verifier_divergente";

export interface FakeAuthCounters {
  readonly authorize: { ok: number; recusado: number };
  readonly exchange: { ok: number; recusado: number };
  readonly refresh: { ok: number; recusado: number };
  readonly logout: { ok: number; recusado: number };
  readonly analyze: { ok: number; recusado: number };
}

/** Uma análise que passou das barreiras. Nenhum valor de segredo: o access é o índice na lista dos emitidos. */
export interface AnalyzeRecord {
  readonly requestId: string;
  readonly mode: string;
  readonly platform: string;
  readonly extractorVersion: string;
  readonly clientTruncated: boolean;
  /** Unidades UTF-16 do texto recebido, e o SHA-256 dele em hex. */
  readonly textLength: number;
  readonly textDigest: string;
  /** Índice do access apresentado em `accessTokens`. */
  readonly access: number;
  /** O que o falso respondeu: o stream padrão ou o passo do roteiro. */
  readonly resposta: "stream" | AnalyzeScript;
}

export interface FakeAuthSnapshot {
  readonly counters: FakeAuthCounters;
  /** Os motivos das recusas, na ordem: o teste diz qual barreira parou o pedido. */
  readonly refusals: readonly string[];
  /** Os verifiers que chegaram à troca, válidos ou não: são canários também (§4.4). */
  readonly verifiers: readonly string[];
  /** Os access tokens emitidos, na ordem. */
  readonly accessTokens: readonly string[];
  /** Todo valor emitido ou recebido que nunca pode aparecer no painel, na aba, em log nem em `local`/`sync`. */
  readonly canaries: readonly string[];
  /** Cada passo do roteiro que de fato agiu, na ordem (`authorize:<roteiro>`, `logout:503`, `analyze:<passo>` e `refresh:<passo>`), e o `revogar`. */
  readonly roteiro: readonly string[];
  /** As análises que passaram das barreiras, na ordem. */
  readonly analyses: readonly AnalyzeRecord[];
}

export interface FakeAuth {
  /** `GET /auth/v1/authorize` do Supabase falso: 302 para o chromiumapp com o código, ou 400. */
  authorize(query: URLSearchParams): HttpReply;
  /** `POST /v1/auth/exchange`. */
  exchange(body: unknown): HttpReply;
  /** `POST /v1/auth/refresh`. */
  refresh(body: unknown): HttpReply;
  /** `POST /v1/auth/logout`, com o cabeçalho `Authorization` cru. */
  logout(body: unknown, authorization: string | undefined): HttpReply;
  /** `POST /v1/analyze`, com o cabeçalho `Authorization` cru: o stream SSE, ou a recusa. */
  analyze(body: unknown, authorization: string | undefined): HttpReply;
  /** Encerra todas as sessões vivas, como o logout em outro dispositivo (ADR-004 D11.6), e diz quantas eram. */
  revoke(): number;
  /** Arma o roteiro: cada chave presente substitui a pendente. */
  script(script: FakeScript): void;
  snapshot(): FakeAuthSnapshot;
}

export interface FakeAuthDeps {
  /** O ID derivado da chave efêmera (P17): o `redirect_to` só vale para ele. */
  readonly extensionId: string;
  readonly now: () => number;
  readonly newCode?: () => string;
  readonly newAccess?: () => AccessCanary;
  readonly newEnvelope?: () => EnvelopeCanary;
  readonly newError?: () => string;
}

const apiError = (code: ApiErrorCode): ApiError => ({ code, message: "Recusado pelo BFF falso do E2E.", requestId: null, retryAfterSeconds: null });
const NAO_AUTENTICADO: HttpReply = { status: 401, body: apiError("NAO_AUTENTICADO") };
const PAYLOAD_INVALIDO: HttpReply = { status: 400, body: apiError("PAYLOAD_INVALIDO") };
const SERVICO_INDISPONIVEL: HttpReply = { status: 503, body: apiError("SERVICO_INDISPONIVEL") };

/** Um evento na forma exata do ADR-017 D6, validado pelo contrato antes de sair. */
const frame = (event: AnalysisStreamEvent): string => {
  const parsed = AnalysisStreamEventSchema.parse(event);
  return `event: ${parsed.type}\ndata: ${JSON.stringify(parsed)}\n\n`;
};
/** Um byte acima do teto do stream no SW (64 KiB), numa linha que nunca termina: o leitor não tem o que recusar antes. */
const OVERSIZED_LINE = `event: ${"a".repeat(65_536)}`;

export function createFakeAuth(deps: FakeAuthDeps): FakeAuth {
  const newCode = deps.newCode ?? newCodeCanary;
  const newAccess = deps.newAccess ?? newAccessCanary;
  const newEnvelope = deps.newEnvelope ?? newEnvelopeCanary;
  const newError = deps.newError ?? newErrorCanary;
  const host = `https://${deps.extensionId}.chromiumapp.org`;
  const redirectBase = `${host}/auth`;
  const counters: FakeAuthCounters = {
    authorize: { ok: 0, recusado: 0 },
    exchange: { ok: 0, recusado: 0 },
    refresh: { ok: 0, recusado: 0 },
    logout: { ok: 0, recusado: 0 },
    analyze: { ok: 0, recusado: 0 },
  };
  const refusals: string[] = [];
  const verifiers: string[] = [];
  const accessTokens: string[] = [];
  const canaries: string[] = [];
  const roteiro: string[] = [];
  const analyses: AnalyzeRecord[] = [];
  const codes = new Map<string, { readonly challenge: string; readonly issuedAt: number }>();
  /** Sessões vivas: envelope → access. A renovação gira o par; o logout derruba pelo access. */
  const sessions = new Map<string, string>();
  let pendingAuthorize: AuthorizeScript | undefined;
  let pendingLogout503 = 0;
  let pendingAnalyze: AnalyzeScript[] = [];
  let pendingRefresh: RefreshScript[] = [];
  let expiresIn: number = FAKE_AUTH_POLICY.expiresIn;

  const refuse = (route: keyof FakeAuthCounters, motivo: string, reply: HttpReply): HttpReply => {
    counters[route].recusado += 1;
    refusals.push(`${route}:${motivo}`);
    return reply;
  };

  const issue = (): HttpReply => {
    const access = newAccess();
    const { envelope, cipher } = newEnvelope();
    sessions.set(envelope, access.token);
    accessTokens.push(access.token);
    canaries.push(access.token, ...access.segments, envelope, cipher);
    return { status: 200, body: { schemaVersion: AUTH_SCHEMA_VERSION, accessToken: access.token, refreshToken: envelope, expiresIn } };
  };

  /** O envelope da sessão viva deste `Authorization`: só "Bearer " e o access exato de uma sessão que o falso mantém. */
  const liveSession = (authorization: string | undefined): readonly [string, string] | undefined => {
    const token = authorization?.startsWith("Bearer ") === true ? authorization.slice("Bearer ".length) : undefined;
    return [...sessions].find(([, access]) => access === token);
  };

  const statePrefix = `${redirectBase}?st=`;
  /** Depois da 1ª barreira, os 4 parâmetros existem uma vez cada: o `String` só tira o `null` do tipo. */
  const authorizeRefusal = (query: URLSearchParams): AuthorizeRefusal | undefined => {
    if ([...query.keys()].length !== AUTHORIZE_KEYS.length || AUTHORIZE_KEYS.some((key) => query.getAll(key).length !== 1)) return "parametros";
    if (!PROVIDERS.has(String(query.get("provider")))) return "provedor";
    if (query.get("code_challenge_method") !== "s256") return "metodo";
    if (!CHALLENGE.test(String(query.get("code_challenge")))) return "challenge";
    const redirectTo = String(query.get("redirect_to"));
    if (!redirectTo.startsWith(statePrefix) || !STATE.test(redirectTo.slice(statePrefix.length))) return "redirect_to";
    return undefined;
  };

  return {
    authorize(query) {
      const motivo = authorizeRefusal(query);
      if (motivo !== undefined) return refuse("authorize", motivo, { status: 400, body: "authorize recusado pelo Supabase falso" });
      counters.authorize.ok += 1;
      const state = String(query.get("redirect_to")).slice(statePrefix.length);
      const script = pendingAuthorize;
      pendingAuthorize = undefined;
      if (script !== undefined) roteiro.push(`authorize:${script}`);
      if (script === "cancelar") {
        // Como o GoTrue no fluxo PKCE: o erro vai na query do `redirect_to`, que já traz o `st`. Nenhum código nasce.
        const description = newError();
        canaries.push(description);
        return { status: 302, location: `${statePrefix}${state}&error=access_denied&error_code=access_denied&error_description=${description}` };
      }
      const code = newCode();
      // O challenge de outro fluxo: o S256 de um valor que nenhum SW tem.
      const challenge = script === "outro_challenge" ? s256(newCode()) : String(query.get("code_challenge"));
      codes.set(code, { challenge, issuedAt: deps.now() });
      canaries.push(code);
      const search = `?code=${code}&st=${state}`;
      if (script === "outro_caminho") return { status: 302, location: `${host}/outro${search}` };
      if (script === "fragmento") {
        const access = newAccess();
        canaries.push(access.token, ...access.segments);
        return { status: 302, location: `${redirectBase}${search}#access_token=${access.token}&token_type=bearer` };
      }
      return { status: 302, location: `${redirectBase}${search}`, ...(script === "segurar" ? { hold: true as const } : {}) };
    },

    exchange(body) {
      const parsed = AuthExchangeRequestSchema.safeParse(body);
      if (!parsed.success) return refuse("exchange", "corpo", PAYLOAD_INVALIDO);
      const { authCode, codeVerifier } = parsed.data;
      verifiers.push(codeVerifier);
      canaries.push(codeVerifier);
      const entry = codes.get(authCode);
      // Uso único: o código morre na primeira troca, qualquer que seja o resultado (P8).
      codes.delete(authCode);
      if (entry === undefined) return refuse("exchange", "codigo_desconhecido", NAO_AUTENTICADO);
      if (deps.now() - entry.issuedAt > FAKE_AUTH_POLICY.codeTtlMs) return refuse("exchange", "codigo_vencido", NAO_AUTENTICADO);
      if (s256(codeVerifier) !== entry.challenge) return refuse("exchange", "verifier_divergente", NAO_AUTENTICADO);
      counters.exchange.ok += 1;
      return issue();
    },

    refresh(body) {
      const parsed = AuthRefreshRequestSchema.safeParse(body);
      if (!parsed.success) return refuse("refresh", "corpo", PAYLOAD_INVALIDO);
      const envelope = parsed.data.refreshToken;
      /** Gira o par na hora de responder: a sessão pode ter morrido enquanto a resposta estava presa. */
      const rotate = (): HttpReply => {
        if (!sessions.delete(envelope)) return refuse("refresh", "envelope_desconhecido", NAO_AUTENTICADO);
        counters.refresh.ok += 1;
        return issue();
      };
      // O roteiro só vale para a renovação que o falso aceitaria: o envelope de fora não o gasta.
      if (!sessions.has(envelope)) return rotate();
      const script = pendingRefresh.shift();
      if (script === undefined) return rotate();
      roteiro.push(`refresh:${script}`);
      if (script === "503") return refuse("refresh", "roteiro_503", SERVICO_INDISPONIVEL);
      return { status: 200, hold: true, later: rotate };
    },

    logout(body, authorization) {
      if (!AuthLogoutRequestSchema.safeParse(body).success) return refuse("logout", "corpo", PAYLOAD_INVALIDO);
      const envelope = liveSession(authorization)?.[0];
      if (envelope === undefined) return refuse("logout", "bearer", NAO_AUTENTICADO);
      // O 503 do roteiro só vem depois do corpo e do Bearer conferidos, e a sessão continua viva no servidor.
      if (pendingLogout503 > 0) {
        pendingLogout503 -= 1;
        roteiro.push("logout:503");
        return refuse("logout", "roteiro_503", SERVICO_INDISPONIVEL);
      }
      sessions.delete(envelope);
      counters.logout.ok += 1;
      return { status: 204 };
    },

    analyze(body, authorization) {
      // Como a API real: o Bearer antes do corpo. Só o access de uma sessão viva (não girado, encerrado nem revogado).
      const access = liveSession(authorization)?.[1];
      if (access === undefined) return refuse("analyze", "bearer", NAO_AUTENTICADO);
      const parsed = AnalyzeJobRequestSchema.safeParse(body);
      if (!parsed.success) return refuse("analyze", "corpo", PAYLOAD_INVALIDO);
      const { requestId, mode, source, job } = parsed.data;
      // O texto como chegou, antes do corte do contrato: é o que o SW mandou.
      const text = (body as { readonly job: { readonly text: string } }).job.text;
      const script = pendingAnalyze.shift();
      analyses.push({
        requestId,
        mode,
        platform: source.platform,
        extractorVersion: source.extractorVersion,
        clientTruncated: job.clientTruncated,
        textLength: text.length,
        textDigest: textDigest(text),
        access: accessTokens.indexOf(access),
        resposta: script ?? "stream",
      });
      if (script !== undefined) roteiro.push(`analyze:${script}`);
      const failure = (status: number, code: ApiErrorCode): HttpReply => refuse("analyze", `roteiro_${script}`, { status, body: { ...apiError(code), requestId } });
      if (script === "401") return failure(401, "NAO_AUTENTICADO");
      if (script === "503") return failure(503, "SERVICO_INDISPONIVEL");
      if (script === "fora_do_contrato") {
        const erro = newError();
        canaries.push(erro);
        return refuse("analyze", "roteiro_fora_do_contrato", { status: 500, body: { erro } });
      }
      counters.analyze.ok += 1;
      const recebido = frame({ type: "stage", stage: "recebido", elapsedMs: 0 });
      const pontuando = frame({ type: "stage", stage: "pontuando", elapsedMs: 40 });
      const result = frame({ type: "result", report: { ...REPORT, requestId } });
      if (script === "silencio") return { status: 200, sse: [recebido], hold: true };
      if (script === "keep_alive") return { status: 200, sse: [recebido, ": keep-alive\n\n", result] };
      if (script === "depois_do_resultado") return { status: 200, sse: [recebido, result, pontuando] };
      if (script === "event_divergente") return { status: 200, sse: [recebido, result.replace("event: result", "event: stage")] };
      if (script === "grande_demais") return { status: 200, sse: [recebido, OVERSIZED_LINE] };
      return { status: 200, sse: [recebido, frame({ type: "stage", stage: "normalizando", elapsedMs: 5 }), pontuando, result] };
    },

    revoke() {
      const alive = sessions.size;
      sessions.clear();
      roteiro.push("revogar");
      return alive;
    },

    script(script) {
      if (script.authorize !== undefined) pendingAuthorize = script.authorize;
      if (script.logout503 !== undefined) pendingLogout503 = script.logout503;
      if (script.analyze !== undefined) pendingAnalyze = [...script.analyze];
      if (script.refresh !== undefined) pendingRefresh = [...script.refresh];
      if (script.expiresIn !== undefined) expiresIn = script.expiresIn;
    },

    snapshot() {
      return structuredClone({ counters, refusals, verifiers, accessTokens, canaries, roteiro, analyses });
    },
  };
}
