// Captura da vaga pelo Service Worker (F1-EXT-03 parte 1; ADR-024; ADR-001 §5.0 passos 2 a 5).
// Injeta o extrator genérico (ADR-023) na aba, valida o retorno como dado hostil e limpa o texto.
// O texto colado pelo usuário passa pela mesma limpeza.
import type { AnalyzeJobRequest } from "@trampo/contracts/api";
import { JOB_TEXT_MAX_CHARS, JOB_TEXT_MIN_CHARS } from "@trampo/contracts/limits";
import { VersionTagSchema } from "@trampo/contracts/primitives";
import { z } from "zod";

import { extractGenericJobText, type DiscardReason, type ExtractionLimits } from "../extraction/generic-extractor";
import { cleanJobText, countCodePoints } from "./job-text";

type Platform = AnalyzeJobRequest["source"]["platform"];

/**
 * Limites passados ao extrator. `maxChars` é em UTF-16: o dobro do teto em code points garante que o
 * corte do Service Worker, e não o do extrator, decide o que fica. `minChars` é refeito em code points
 * depois da limpeza.
 */
export const GENERIC_LIMITS = {
  maxChars: 2 * JOB_TEXT_MAX_CHARS,
  maxNodes: 50_000,
  minChars: JOB_TEXT_MIN_CHARS,
} as const satisfies ExtractionLimits;

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

const discardCount = z.int().min(0).max(GENERIC_LIMITS.maxNodes);

/** Retorno do extrator: vem da aba, então é validado como entrada hostil (forma e tamanho, estrito). */
export const GenericResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    versao: z.literal("ge1"),
    raiz: z.enum(["main", "article", "body"]),
    texto: z.string().max(GENERIC_LIMITS.maxChars),
    truncado: z.boolean(),
    descartes: z.strictObject(Object.fromEntries(DISCARD_REASONS.map((r) => [r, discardCount])) as Record<DiscardReason, typeof discardCount>),
  }),
  z.strictObject({ ok: z.literal(false), versao: z.literal("ge1"), motivo: z.enum(["limites_invalidos", "texto_insuficiente"]) }),
]);

/** Só o frame principal: exatamente um resultado, do frame 0. As outras chaves do Chrome não importam. */
const InjectionResultsSchema = z.tuple([z.object({ frameId: z.literal(0), result: z.unknown() })]);

/** Vaga capturada, guardada em `storage.session` para o "Reanalisar com IA" não reler a página. */
export const CapturedJobSchema = z.strictObject({
  /** Aba de origem; `null` no texto colado. */
  tabId: z.int().min(0).nullable(),
  capturedAt: z.int().min(0),
  platform: z.enum(["generico", "texto_colado"] satisfies Platform[]),
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
    func: typeof extractGenericJobText;
    args: [ExtractionLimits];
  }): Promise<unknown>;
}

export type ExtractorRunner = (tabId: number) => Promise<unknown>;

/**
 * Só o frame principal (sem `allFrames` nem `frameIds`) e no mundo ISOLATED, onde a página não troca
 * os protótipos nativos (ADR-023 D2). A função vai serializada: nada do módulo a acompanha.
 */
export function genericExtractorRunner(scripting: ScriptingApi): ExtractorRunner {
  return (tabId) =>
    scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      injectImmediately: false,
      func: extractGenericJobText,
      args: [{ ...GENERIC_LIMITS }],
    });
}

function finish(raw: string, alreadyTruncated: boolean, platform: CapturedJob["platform"], extractorVersion: string, tabId: number | null, now: number): CaptureOutcome {
  const { text, truncated } = cleanJobText(raw);
  if (countCodePoints(text) < JOB_TEXT_MIN_CHARS) return { ok: false, motivo: "texto_insuficiente" };
  return { ok: true, job: { tabId, capturedAt: now, platform, extractorVersion, text, truncated: alreadyTruncated || truncated } };
}

/**
 * Roda o extrator na aba. A rejeição do `executeScript` (página restrita ou concessão do activeTab
 * ausente) vira `sem_acesso` sem ler a mensagem, que pode trazer a URL da aba. Retorno nulo (o
 * extrator lançou) ou fora da forma vira `erro`. Em todos os casos o painel oferece colar o texto.
 */
export async function captureFromTab(tabId: number, run: ExtractorRunner, now: number): Promise<CaptureOutcome> {
  let raw: unknown;
  try {
    raw = await run(tabId);
  } catch {
    return { ok: false, motivo: "sem_acesso" };
  }
  const frames = InjectionResultsSchema.safeParse(raw);
  if (!frames.success) return { ok: false, motivo: "erro" };
  const result = GenericResultSchema.safeParse(frames.data[0].result);
  if (!result.success) return { ok: false, motivo: "erro" };
  if (!result.data.ok) return { ok: false, motivo: result.data.motivo === "texto_insuficiente" ? "texto_insuficiente" : "erro" };
  return finish(result.data.texto, result.data.truncado, "generico", result.data.versao, tabId, now);
}

/** Texto colado no painel (D10 do ADR-001): mesma limpeza e mesmo mínimo do texto extraído. */
export function capturePasted(raw: string, now: number): CaptureOutcome {
  return finish(raw, false, "texto_colado", PASTED_EXTRACTOR_VERSION, null, now);
}
