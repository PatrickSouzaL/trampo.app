// Contrato PRIVADO da extensão entre o Side Panel e o Service Worker (F1-EXT-02).
// Fica fora do @trampo/contracts porque não cruza a rede. Estrito dos dois lados: chave extra,
// tipo desconhecido ou versão errada derrubam a porta (SR-10).
import { AnalysisStreamEventSchema } from "@trampo/contracts/api";
import { JOB_TEXT_MAX_CHARS } from "@trampo/contracts/limits";
import { z } from "zod";

/** Nome fixo da única porta aceita pelo Service Worker. */
export const PANEL_PORT_NAME = "trampo/sidepanel/v1";

/** Página da extensão autorizada a abrir a porta. */
export const PANEL_PAGE_PATH = "/sidepanel.html";

export const PROTOCOL_VERSION = 1 as const;

/**
 * Teto do texto colado em unidades UTF-16 (o `maxLength` do campo usa a mesma unidade). O dobro do
 * teto em code points: o Service Worker corta em JOB_TEXT_MAX_CHARS code points depois da limpeza.
 */
export const PASTE_MAX_UTF16 = 2 * JOB_TEXT_MAX_CHARS;

/**
 * Versão do aviso de envio (Limited Use; ADR-001 §5.0 passo 7). Mudou o texto do aviso, muda a versão:
 * o consentimento guardado com a versão antiga deixa de valer (ADR-025 D2).
 */
export const CONSENT_VERSION = "aviso-1";

/**
 * Provedores do login (HITL-004; ADR-004 D2 e D12): só GitHub e Google. Fica aqui, e não em src/auth,
 * porque o painel também precisa da lista e nunca importa src/auth (ADR-004 D10 B3).
 */
export const AUTH_PROVIDERS = ["github", "google"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

export const PanelToWorkerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("hello"), protocolVersion: z.literal(PROTOCOL_VERSION) }),
  // Fallback "colar o texto" (ADR-001 D10; ADR-024 D5). O texto é dado, nunca comando.
  z.strictObject({ kind: z.literal("colar"), texto: z.string().max(PASTE_MAX_UTF16) }),
  // Consentimento antes da 1ª transmissão (ADR-025 D2). Só a versão do aviso que o painel mostrou.
  z.strictObject({ kind: z.literal("consentir"), versao: z.literal(CONSENT_VERSION) }),
  z.strictObject({ kind: z.literal("revogar") }),
]);
export type PanelToWorker = z.infer<typeof PanelToWorkerSchema>;

/**
 * O que o painel sabe da captura: só o estado e metadados, NUNCA o texto da vaga, que fica no
 * Service Worker (ADR-024 D4). `falhou` sempre oferece colar o texto.
 */
export const CaptureViewSchema = z.discriminatedUnion("estado", [
  z.strictObject({ estado: z.literal("ocioso") }),
  z.strictObject({ estado: z.literal("lendo") }),
  z.strictObject({
    estado: z.literal("pronto"),
    origem: z.enum(["pagina", "texto_colado"]),
    caracteres: z.int().min(0).max(JOB_TEXT_MAX_CHARS),
    truncado: z.boolean(),
  }),
  z.strictObject({ estado: z.literal("falhou"), motivo: z.enum(["sem_acesso", "texto_insuficiente", "erro"]) }),
]);
export type CaptureView = z.infer<typeof CaptureViewSchema>;

export const WorkerToPanelSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready"), protocolVersion: z.literal(PROTOCOL_VERSION) }),
  z.strictObject({ kind: z.literal("captura"), captura: CaptureViewSchema }),
  z.strictObject({ kind: z.literal("consentimento"), dado: z.boolean() }),
  // O que o painel renderiza vem do contrato público e é revalidado antes de qualquer render.
  z.strictObject({ kind: z.literal("stream"), event: AnalysisStreamEventSchema }),
]);
export type WorkerToPanel = z.infer<typeof WorkerToPanelSchema>;
