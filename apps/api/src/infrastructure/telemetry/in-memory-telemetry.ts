// Adapter em memória da porta Telemetry (ADR-010 D6): contadores e histogramas por série, para os testes
// e para o dev. O exportador externo depende da hospedagem e fica para o S-5. Valida cada evento com o
// schema estrito: evento inválido (chave extra, enum fora da lista, número fora da faixa) é descartado e
// contado. Nunca lança.
import {
  METRIC_CATALOG,
  TelemetryEventSchema,
  telemetryMetricSamples,
  type MetricName,
  type Telemetry,
  type TelemetryEvent,
} from "../../application/index.js";

export interface HistogramSnapshot {
  readonly count: number;
  readonly sum: number;
  /** Contagem acumulada por limite do catálogo; o último item é o +Inf (igual a `count`). */
  readonly cumulative: readonly number[];
}

function seriesKey(name: MetricName, labels: Readonly<Record<string, string>>): string {
  const sorted = Object.keys(labels)
    .sort()
    .map((label) => [label, labels[label]]);
  return `${name}${JSON.stringify(sorted)}`;
}

export class InMemoryTelemetry implements Telemetry {
  readonly #counters = new Map<string, number>();
  readonly #histograms = new Map<string, HistogramSnapshot>();
  #dropped = 0;

  record(event: TelemetryEvent): void {
    try {
      const parsed = TelemetryEventSchema.safeParse(event);
      if (!parsed.success) {
        this.#dropped += 1;
        return;
      }
      for (const sample of telemetryMetricSamples(parsed.data)) {
        const key = seriesKey(sample.name, sample.labels);
        const definition = METRIC_CATALOG[sample.name];
        if (definition.type === "counter") {
          this.#counters.set(key, (this.#counters.get(key) ?? 0) + sample.value);
          continue;
        }
        // O último limite é o +Inf: a contagem acumulada dele é a contagem total.
        const bounds = [...definition.buckets, Number.POSITIVE_INFINITY];
        const previous = this.#histograms.get(key);
        this.#histograms.set(key, {
          count: (previous?.count ?? 0) + 1,
          sum: (previous?.sum ?? 0) + sample.value,
          cumulative: bounds.map((bound, index) => (previous?.cumulative[index] ?? 0) + (sample.value <= bound ? 1 : 0)),
        });
      }
    } catch {
      // Um evento hostil (getter que lança, Proxy) não derruba a análise.
      this.#dropped += 1;
    }
  }

  counter(name: MetricName, labels: Readonly<Record<string, string>> = {}): number {
    return this.#counters.get(seriesKey(name, labels)) ?? 0;
  }

  histogram(name: MetricName, labels: Readonly<Record<string, string>> = {}): HistogramSnapshot | undefined {
    const histogram = this.#histograms.get(seriesKey(name, labels));
    return histogram === undefined ? undefined : { ...histogram, cumulative: [...histogram.cumulative] };
  }

  /** Séries existentes, para provar que nenhum rótulo fora do catálogo foi criado. */
  seriesKeys(): string[] {
    return [...this.#counters.keys(), ...this.#histograms.keys()];
  }

  get droppedEvents(): number {
    return this.#dropped;
  }
}
