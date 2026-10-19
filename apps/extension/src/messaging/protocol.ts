// Contrato PRIVADO da extensão entre o Side Panel e o Service Worker (F1-EXT-02).
// Fica fora do @trampo/contracts porque não cruza a rede. Estrito dos dois lados: chave extra,
// tipo desconhecido ou versão errada derrubam a porta (SR-10).
import { AnalysisStreamEventSchema } from "@trampo/contracts/api";
import { z } from "zod";

/** Nome fixo da única porta aceita pelo Service Worker. */
export const PANEL_PORT_NAME = "trampo/sidepanel/v1";

/** Página da extensão autorizada a abrir a porta. */
export const PANEL_PAGE_PATH = "/sidepanel.html";

export const PROTOCOL_VERSION = 1 as const;

export const PanelToWorkerSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("hello"), protocolVersion: z.literal(PROTOCOL_VERSION) }),
]);
export type PanelToWorker = z.infer<typeof PanelToWorkerSchema>;

export const WorkerToPanelSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready"), protocolVersion: z.literal(PROTOCOL_VERSION) }),
  // O que o painel renderiza vem do contrato público e é revalidado antes de qualquer render.
  z.strictObject({ kind: z.literal("stream"), event: AnalysisStreamEventSchema }),
]);
export type WorkerToPanel = z.infer<typeof WorkerToPanelSchema>;
