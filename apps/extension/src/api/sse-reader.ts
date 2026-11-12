// Leitor do SSE do POST /v1/analyze (F1-EXT-04 parte 2, 04b-1; ADR-025 §6 D8). O servidor tem uma forma só
// (ADR-017 D6): `event: <type>\ndata: <json>\n\n`, um `data:` por evento, sem `id:`, `retry:` nem comentário. Qualquer
// outra forma é violação e descarta o stream inteiro. O `stage` sai na hora; o terminal (`result` ou `error`) só sai
// no fim, se nada vier depois dele: "exatamente um terminal no fim" vale também no cliente.
import { type AnalysisStreamEvent, AnalysisStreamEventSchema } from "@trampo/contracts/api";

export type StageEvent = Extract<AnalysisStreamEvent, { type: "stage" }>;
export type TerminalEvent = Exclude<AnalysisStreamEvent, StageEvent>;

export type SseFeed = "seguir" | "violacao";
export type SseEnd = { readonly kind: "completo"; readonly terminal: TerminalEvent } | { readonly kind: "incompleto" | "violacao" };

export interface SseReader {
  /** Um pedaço do corpo já decodificado. `violacao` é definitiva: quem lê derruba o stream. */
  push(text: string): SseFeed;
  /** O servidor fechou o stream. */
  end(): SseEnd;
}

const EVENT_PREFIX = "event: ";
const DATA_PREFIX = "data: ";

/** Esperando o `event:`, o `data:` ou a linha em branco que fecha o evento. */
type Step = { readonly at: "event" } | { readonly at: "data"; readonly name: string } | { readonly at: "fim"; readonly event: AnalysisStreamEvent };

function parseData(name: string, json: string): AnalysisStreamEvent | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return undefined;
  }
  const parsed = AnalysisStreamEventSchema.safeParse(raw);
  return parsed.success && parsed.data.type === name ? parsed.data : undefined;
}

export function createSseReader(onStage: (event: StageEvent) => void): SseReader {
  let buffer = "";
  let step: Step = { at: "event" };
  let terminal: TerminalEvent | undefined;
  let violated = false;

  /** Uma linha completa, sem o `\n`. `false` é violação. */
  const line = (text: string): boolean => {
    if (terminal !== undefined || text.includes("\r")) return false;
    switch (step.at) {
      case "event":
        if (!text.startsWith(EVENT_PREFIX)) return false;
        step = { at: "data", name: text.slice(EVENT_PREFIX.length) };
        return true;
      case "data": {
        if (!text.startsWith(DATA_PREFIX)) return false;
        const event = parseData(step.name, text.slice(DATA_PREFIX.length));
        if (event === undefined) return false;
        step = { at: "fim", event };
        return true;
      }
      case "fim": {
        if (text !== "") return false;
        const { event } = step;
        step = { at: "event" };
        if (event.type === "stage") onStage(event);
        else terminal = event;
        return true;
      }
    }
  };

  return {
    push(text) {
      if (violated) return "violacao";
      try {
        // Nada pode vir depois do terminal: a linha completa cai no `line`, e o resto sem fim de linha, logo abaixo.
        buffer += text;
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const current = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line(current)) throw new Error("forma fora do servidor");
          newline = buffer.indexOf("\n");
        }
        if (terminal !== undefined && buffer !== "") throw new Error("depois do terminal");
        return "seguir";
      } catch {
        // Inclui o destino do stage que lança: o stream cai, fechado.
        violated = true;
        return "violacao";
      }
    },
    end() {
      if (violated) return { kind: "violacao" };
      // Com o terminal, o buffer está vazio e o passo voltou ao `event:` (o push garante). Sem ele, o corte é da rede.
      if (terminal === undefined) return { kind: "incompleto" };
      return { kind: "completo", terminal };
    },
  };
}
