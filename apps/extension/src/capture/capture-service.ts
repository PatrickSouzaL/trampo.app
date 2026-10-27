// Estado da captura no Service Worker (F1-EXT-03 parte 1; ADR-024 D4). Guarda a última captura em
// storage.session e avisa as portas do painel com uma VISÃO sem o texto da vaga.
import { z } from "zod";

import { createPanelHub } from "../messaging/panel-hub";
import type { CaptureView } from "../messaging/protocol";
import type { SessionStore } from "../messaging/session-store";
import type { PanelPort } from "../messaging/worker-port";
import { CaptureFailureSchema, CapturedJobSchema, captureFromTab, capturePasted, type CaptureFailure, type CaptureOutcome, type ExtractorRunner } from "./capture";
import { countCodePoints } from "./job-text";

/** Chave única em storage.session: só a última captura existe (ADR-001 §5.0 passo 5). */
export const CAPTURE_STORAGE_KEY = "trampo/captura/v1";

export const CaptureStateSchema = z.discriminatedUnion("estado", [
  z.strictObject({ estado: z.literal("lendo"), tabId: z.int().min(0) }),
  z.strictObject({ estado: z.literal("pronto"), vaga: CapturedJobSchema }),
  z.strictObject({ estado: z.literal("falhou"), tabId: z.int().min(0).nullable(), motivo: CaptureFailureSchema }),
]);
export type CaptureState = z.infer<typeof CaptureStateSchema>;

/** A visão do painel: estado e metadados, nunca o texto. */
export function captureView(state: CaptureState | undefined): CaptureView {
  if (state === undefined) return { estado: "ocioso" };
  switch (state.estado) {
    case "lendo":
      return { estado: "lendo" };
    case "pronto":
      return {
        estado: "pronto",
        origem: state.vaga.platform === "texto_colado" ? "texto_colado" : "pagina",
        caracteres: countCodePoints(state.vaga.text),
        truncado: state.vaga.truncated,
      };
    case "falhou":
      return { estado: "falhou", motivo: state.motivo };
  }
}

function tabOf(state: CaptureState): number | null {
  return state.estado === "pronto" ? state.vaga.tabId : state.tabId;
}

export interface CaptureServiceDeps {
  readonly store: SessionStore<typeof CaptureStateSchema>;
  readonly runExtractor: ExtractorRunner;
  readonly now: () => number;
  /** Registra só o motivo, nunca texto de vaga nem mensagem de erro do navegador (T23). */
  readonly logFailure: (motivo: CaptureFailure) => void;
}

export interface CaptureService {
  /** Clique no ícone (gesto do usuário, activeTab concedido): lê a aba. */
  captureTab(tabId: number): Promise<void>;
  /** Texto colado no painel. */
  paste(texto: string): Promise<void>;
  /** Porta confiável do painel: recebe o estado atual e as mudanças seguintes. */
  attach(port: PanelPort): Promise<void>;
  /** Aba fechada: a captura dela sai da memória. */
  tabClosed(tabId: number): Promise<void>;
}

export function createCaptureService(deps: CaptureServiceDeps): CaptureService {
  const hub = createPanelHub();
  // Dois cliques seguidos: só a captura mais recente grava o resultado.
  let generation = 0;

  const broadcast = (state: CaptureState | undefined): void => {
    hub.broadcast({ kind: "captura", captura: captureView(state) });
  };
  const publish = async (state: CaptureState): Promise<void> => {
    await deps.store.set(state);
    broadcast(state);
  };
  const settle = async (outcome: CaptureOutcome, tabId: number | null): Promise<void> => {
    if (outcome.ok) {
      await publish({ estado: "pronto", vaga: outcome.job });
      return;
    }
    deps.logFailure(outcome.motivo);
    await publish({ estado: "falhou", tabId, motivo: outcome.motivo });
  };

  return {
    async captureTab(tabId) {
      generation += 1;
      const mine = generation;
      await publish({ estado: "lendo", tabId });
      const outcome = await captureFromTab(tabId, deps.runExtractor, deps.now());
      if (mine !== generation) return;
      await settle(outcome, tabId);
    },
    async paste(texto) {
      generation += 1;
      await settle(capturePasted(texto, deps.now()), null);
    },
    async attach(port) {
      hub.add(port);
      const state = await deps.store.get();
      if (hub.has(port)) hub.send(port, { kind: "captura", captura: captureView(state) });
    },
    async tabClosed(tabId) {
      const state = await deps.store.get();
      if (state === undefined || tabOf(state) !== tabId) return;
      generation += 1;
      await deps.store.remove();
      broadcast(undefined);
    },
  };
}
