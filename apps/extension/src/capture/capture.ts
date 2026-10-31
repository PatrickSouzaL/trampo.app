// Captura da vaga pelo Service Worker (F1-EXT-03; ADR-024; ADR-001 §5.0 passos 2 a 5).
// Escolhe o extrator pelo host da aba, injeta-o (ADR-023), valida o retorno como dado hostil e limpa
// o texto. O texto colado pelo usuário passa pela mesma limpeza.
import type { AnalyzeJobRequest } from "@trampo/contracts/api";
import { JOB_TEXT_MAX_CHARS, JOB_TEXT_MIN_CHARS } from "@trampo/contracts/limits";
import { VersionTagSchema } from "@trampo/contracts/primitives";
import { z } from "zod";

import {
  extractJobText,
  type DiscardReason,
  type ExtractionLimits,
  type ExtractorPlatform,
  type ExtractorVersion,
} from "../extraction/job-extractor";
import { cleanJobText, countCodePoints } from "./job-text";

type Platform = AnalyzeJobRequest["source"]["platform"];

/**
 * Limites passados ao extrator. `maxChars` é em UTF-16: o dobro do teto em code points garante que o
 * corte do Service Worker, e não o do extrator, decide o que fica. `minChars` é refeito em code points
 * depois da limpeza.
 */
export const EXTRACTION_LIMITS = {
  maxChars: 2 * JOB_TEXT_MAX_CHARS,
  maxNodes: 50_000,
  minChars: JOB_TEXT_MIN_CHARS,
} as const satisfies ExtractionLimits;

/** Versões que cada extrator de plataforma devolve quando acha uma raiz dela (ADR-023 D11 e D12). */
const PLATFORM_VERSIONS = {
  linkedin: ["li2", "li1"],
  gupy: ["gu1"],
  solides: ["so1"],
} as const satisfies Record<Exclude<ExtractorPlatform, "generico">, readonly ExtractorVersion[]>;

/**
 * Plataforma pelo host da URL da aba, que o activeTab entrega no clique (ADR-023 D11). Só o host é
 * lido; a URL não é guardada nem registrada (T23). Qualquer dúvida cai no genérico, que é o lado
 * seguro: a plataforma só escolhe a raiz, e as regras de descarte são as mesmas.
 */
export function platformForUrl(url: string | undefined): ExtractorPlatform {
  if (url === undefined) return "generico";
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return "generico";
    host = parsed.hostname;
  } catch {
    return "generico";
  }
  if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
  if (host.endsWith(".gupy.io")) return "gupy";
  if (host === "vagas.solides.com.br" || host.endsWith(".vagas.solides.com.br")) return "solides";
  return "generico";
}

/** `extractorVersion` do texto colado (`AnalyzeJobRequest.source`). */
export const PASTED_EXTRACTOR_VERSION = "colado-1";

const DISCARD_REASONS = [
  "naoTexto",
  "ruido",
  "naoRenderizado",
  "ariaHidden",
  "opacidade",
  "recorte",
  "visibilidade",
  "fonteMinuscula",
  "tamanhoZero",
  "foraDaTela",
  "cortado",
  "corDoFundo",
] as const satisfies readonly DiscardReason[];
// Falha de tipo se o extrator ganhar um contador que a validação não conhece.
type MissingReason = Exclude<DiscardReason, (typeof DISCARD_REASONS)[number]>;
export const DISCARD_REASONS_EXHAUSTIVE: [MissingReason] extends [never] ? true : MissingReason = true;

const discardCount = z.int().min(0).max(EXTRACTION_LIMITS.maxNodes);
const ExtractorVersionSchema = z.enum(["ge1", "li1", "li2", "gu1", "so1"] satisfies ExtractorVersion[]);

/** Retorno do extrator: vem da aba, então é validado como entrada hostil (forma e tamanho, estrito). */
export const ExtractorResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    versao: ExtractorVersionSchema,
    raiz: z.enum(["plataforma", "main", "article", "body"]),
    texto: z.string().max(EXTRACTION_LIMITS.maxChars),
    truncado: z.boolean(),
    descartes: z.strictObject(Object.fromEntries(DISCARD_REASONS.map((r) => [r, discardCount])) as Record<DiscardReason, typeof discardCount>),
  }),
  z.strictObject({ ok: z.literal(false), versao: ExtractorVersionSchema, motivo: z.enum(["limites_invalidos", "texto_insuficiente"]) }),
]);
type ExtractorResult = z.infer<typeof ExtractorResultSchema>;

/**
 * A versão tem de bater com a plataforma pedida: o genérico (`ge1`, raiz `main`/`article`/`body`)
 * vale para todas; as versões da plataforma, só para ela e só com a raiz `plataforma`.
 */
function matchesPlatform(result: ExtractorResult, platform: ExtractorPlatform): boolean {
  if (result.versao === "ge1") return !result.ok || result.raiz !== "plataforma";
  const own: readonly ExtractorVersion[] = platform === "generico" ? [] : PLATFORM_VERSIONS[platform];
  return own.includes(result.versao) && (!result.ok || result.raiz === "plataforma");
}

/** Só o frame principal: exatamente um resultado, do frame 0. As outras chaves do Chrome não importam. */
const InjectionResultsSchema = z.tuple([z.object({ frameId: z.literal(0), result: z.unknown() })]);

/** Vaga capturada, guardada em `storage.session` para o "Reanalisar com IA" não reler a página. */
export const CapturedJobSchema = z.strictObject({
  /** Aba de origem; `null` no texto colado. */
  tabId: z.int().min(0).nullable(),
  capturedAt: z.int().min(0),
  platform: z.enum(["generico", "linkedin", "gupy", "solides", "texto_colado"] satisfies Platform[]),
  extractorVersion: VersionTagSchema,
  text: z.string().refine((t) => {
    const n = countCodePoints(t);
    return n >= JOB_TEXT_MIN_CHARS && n <= JOB_TEXT_MAX_CHARS;
  }),
  truncated: z.boolean(),
});
export type CapturedJob = z.infer<typeof CapturedJobSchema>;

export const CaptureFailureSchema = z.enum(["sem_acesso", "texto_insuficiente", "erro"]);
export type CaptureFailure = z.infer<typeof CaptureFailureSchema>;

export type CaptureOutcome = { readonly ok: true; readonly job: CapturedJob } | { readonly ok: false; readonly motivo: CaptureFailure };

/** O mínimo de `browser.scripting` que a captura usa. */
export interface ScriptingApi {
  executeScript(injection: {
    target: { tabId: number };
    world: "ISOLATED";
    injectImmediately: false;
    func: typeof extractJobText;
    args: [ExtractionLimits, ExtractorPlatform];
  }): Promise<unknown>;
}

export type ExtractorRunner = (tabId: number, platform: ExtractorPlatform) => Promise<unknown>;

/**
 * Só o frame principal (sem `allFrames` nem `frameIds`) e no mundo ISOLATED, onde a página não troca
 * os protótipos nativos (ADR-023 D2). A função vai serializada: nada do módulo a acompanha.
 */
export function extractorRunner(scripting: ScriptingApi): ExtractorRunner {
  return (tabId, platform) =>
    scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      injectImmediately: false,
      func: extractJobText,
      args: [{ ...EXTRACTION_LIMITS }, platform],
    });
}

function finish(raw: string, alreadyTruncated: boolean, platform: CapturedJob["platform"], extractorVersion: string, tabId: number | null, now: number): CaptureOutcome {
  const { text, truncated } = cleanJobText(raw);
  if (countCodePoints(text) < JOB_TEXT_MIN_CHARS) return { ok: false, motivo: "texto_insuficiente" };
  return { ok: true, job: { tabId, capturedAt: now, platform, extractorVersion, text, truncated: alreadyTruncated || truncated } };
}

/**
 * Roda o extrator da plataforma na aba. A rejeição do `executeScript` (página restrita ou concessão do activeTab
 * ausente) vira `sem_acesso` sem ler a mensagem, que pode trazer a URL da aba. Retorno nulo (o
 * extrator lançou), fora da forma ou com versão de outra plataforma vira `erro`. Em todos os casos o
 * painel oferece colar o texto.
 */
export async function captureFromTab(tabId: number, platform: ExtractorPlatform, run: ExtractorRunner, now: number): Promise<CaptureOutcome> {
  let raw: unknown;
  try {
    raw = await run(tabId, platform);
  } catch {
    return { ok: false, motivo: "sem_acesso" };
  }
  const frames = InjectionResultsSchema.safeParse(raw);
  if (!frames.success) return { ok: false, motivo: "erro" };
  const result = ExtractorResultSchema.safeParse(frames.data[0].result);
  if (!result.success || !matchesPlatform(result.data, platform)) return { ok: false, motivo: "erro" };
  if (!result.data.ok) return { ok: false, motivo: result.data.motivo === "texto_insuficiente" ? "texto_insuficiente" : "erro" };
  return finish(result.data.texto, result.data.truncado, platform, result.data.versao, tabId, now);
}

/** Texto colado no painel (D10 do ADR-001): mesma limpeza e mesmo mínimo do texto extraído. */
export function capturePasted(raw: string, now: number): CaptureOutcome {
  return finish(raw, false, "texto_colado", PASTED_EXTRACTOR_VERSION, null, now);
}
