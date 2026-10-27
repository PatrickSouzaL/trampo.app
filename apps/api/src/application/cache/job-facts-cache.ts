// JobFactsCache, E3 do funil (ADR-001 §5.4, C8; ADR-015; threat-model T11, SR-08).
//
// Escrita: só a saída da guarda (JobFacts antes da fusão, sem dado do usuário), e só se a análise não foi
// degradada, a Camada 1 deu injection `baixa`, a guarda não removeu nada de injection, a confiança efetiva
// passa de 0,5, o provedor é de produção e está na cadeia, e os fatos são ponto fixo da guarda. Depois,
// SET NX EX: ninguém sobrescreve.
// Leitura: parse sem __proto__, schema estrito, coerência com a chave, idade, ponto fixo da guarda e modelo
// ainda na cadeia. Qualquer dúvida é miss (com DEL da entrada ruim); nada não conferido vira hit.
// Nunca rejeita, não tem logger e o resultado só carrega motivos de enum (SR-12).
import type { LlmProviderId } from "@trampo/contracts";
import {
  JOB_FACTS_SCHEMA_VERSION,
  type JobFacts,
  type JobFactsCacheEntry,
  JobFactsCacheEntrySchema,
} from "@trampo/contracts/job-facts";
import { Sha256HexSchema } from "@trampo/contracts/primitives";

import type { InjectionLevel } from "../../domain/ports/deterministic-signals.js";
import { isEpochMs } from "../limits/windows.js";
import { LlmOutputGuard, type LlmOutputSanitization, parseJsonWithoutPrototypeKeys } from "../llm/llm-output-guard.js";
import { PRODUCTION_PROVIDERS } from "../llm/provider-chain.js";
import type { Clock } from "../ports/clock.js";
import type { JobFactsCacheStore } from "../ports/job-facts-cache-store.js";
import { withDeadline } from "../shared/with-deadline.js";
import { CACHE_KEY_PREFIX, CACHE_POLICY, CacheConfigError } from "./cache-policy.js";

export interface AcceptedModel {
  readonly provider: LlmProviderId;
  readonly model: string;
}

export interface JobFactsCacheDeps {
  readonly store: JobFactsCacheStore;
  /** Relógio monotônico, para os prazos. */
  readonly clock: Clock;
  /** Relógio de parede em ms, para o `extractedAt` e a idade da entrada. */
  readonly now: () => number;
  /** Saída de `extractorVersionTag` (ADR-015 D2). */
  readonly extractorVersion: string;
  /** Pares provedor e modelo da cadeia atual. Os de dev (Ollama) nunca valem para o cache. */
  readonly acceptedModels: readonly AcceptedModel[];
  readonly guard?: LlmOutputGuard;
  /**
   * Prazos da leitura e da escrita. Só os testes de socket real passam um prazo maior (QA-02), como o `timeoutMs`
   * dos guardas de limite; o composeApp não passa, e valem os do CACHE_POLICY.
   */
  readonly deadlines?: { readonly lookupMs: number; readonly storeMs: number };
}

export type CacheMissReason = "ausente" | "corrompido" | "obsoleto" | "indisponivel";

export type CacheLookup =
  | { readonly hit: true; readonly entry: JobFactsCacheEntry }
  | { readonly hit: false; readonly reason: CacheMissReason };

export type CacheWriteRefusal =
  | "degradada"
  | "injecao_no_texto"
  | "injecao_na_saida"
  | "baixa_confianca"
  | "provedor_nao_permitido"
  | "fatos_fora_do_contrato";

export type CacheStoreOutcome =
  | { readonly written: true }
  | { readonly written: false; readonly reason: CacheWriteRefusal | "ja_existia" | "indisponivel" };

export interface CacheWriteCandidate {
  readonly textHash: string;
  /** A saída da guarda (antes da fusão): não depende do usuário. */
  readonly facts: JobFacts;
  readonly sanitization: LlmOutputSanitization;
  /** Nível de injection da Camada 1 sobre o texto da vaga. */
  readonly injectionLevel: InjectionLevel;
  /** Do FactResolver. O usuário só consegue impedir a escrita, nunca mudar o que é gravado. */
  readonly effectiveConfidence: number;
  /** Fallback ou qualquer etapa com falha: não vai ao cache (C5). */
  readonly degraded: boolean;
  readonly provider: LlmProviderId;
  readonly model: string;
}

const PRODUCTION: ReadonlySet<LlmProviderId> = new Set(PRODUCTION_PROVIDERS);
const MISS_UNAVAILABLE: CacheLookup = { hit: false, reason: "indisponivel" };
const WRITE_UNAVAILABLE: CacheStoreOutcome = { written: false, reason: "indisponivel" };

const pairKey = (provider: string, model: string): string => `${provider}\u0000${model}`;

export class JobFactsCache {
  readonly #store: JobFactsCacheStore;
  readonly #clock: Clock;
  readonly #now: () => number;
  readonly #extractorVersion: string;
  readonly #accepted: ReadonlySet<string>;
  readonly #guard: LlmOutputGuard;
  readonly #lookupTimeoutMs: number;
  readonly #storeTimeoutMs: number;

  constructor(deps: JobFactsCacheDeps) {
    if (!JobFactsCacheEntrySchema.shape.extractorVersion.safeParse(deps.extractorVersion).success) {
      throw new CacheConfigError("extractorVersion fora do VersionTagSchema");
    }
    this.#store = deps.store;
    this.#clock = deps.clock;
    this.#now = deps.now;
    this.#extractorVersion = deps.extractorVersion;
    this.#accepted = new Set(
      deps.acceptedModels.filter(({ provider }) => PRODUCTION.has(provider)).map(({ provider, model }) => pairKey(provider, model)),
    );
    this.#guard = deps.guard ?? new LlmOutputGuard();
    this.#lookupTimeoutMs = deps.deadlines?.lookupMs ?? CACHE_POLICY.lookupTimeoutMs;
    this.#storeTimeoutMs = deps.deadlines?.storeMs ?? CACHE_POLICY.storeTimeoutMs;
  }

  /** A tag da chave (ADR-015 D2). O AnalyzeJob confere no boot que é a mesma que ele põe no relatório. */
  get extractorVersion(): string {
    return this.#extractorVersion;
  }

  /** `jobfacts:v1:{extractorVersion}:{textHash}`: só versão e hash, nada do usuário. */
  keyFor(textHash: string): string {
    return `${CACHE_KEY_PREFIX}:${this.#extractorVersion}:${textHash}`;
  }

  lookup(textHash: string): Promise<CacheLookup> {
    if (!Sha256HexSchema.safeParse(textHash).success) return Promise.resolve(MISS_UNAVAILABLE);
    const key = this.keyFor(textHash);
    return withDeadline(
      this.#clock,
      this.#lookupTimeoutMs,
      async (signal) => {
        const read = await this.#store.read(key, signal);
        if (!read.ok) return MISS_UNAVAILABLE;
        if (read.value === null) return { hit: false, reason: "ausente" } as const;
        const verdict = this.#validate(read.value, textHash);
        if (verdict.hit) return verdict;
        // Entrada ruim ou de modelo que saiu da cadeia: apaga para o SET NX voltar a ser possível.
        if (verdict.reason !== "indisponivel") this.#removeLater(key);
        return verdict;
      },
      MISS_UNAVAILABLE,
    );
  }

  /** Decide e grava. Recusa sai na hora, sem comando ao Redis. */
  store(candidate: CacheWriteCandidate): Promise<CacheStoreOutcome> {
    const refusal = this.#refusal(candidate);
    if (refusal !== null) return Promise.resolve({ written: false, reason: refusal });
    const now = this.#now();
    if (!isEpochMs(now)) return Promise.resolve(WRITE_UNAVAILABLE);
    const entry = JobFactsCacheEntrySchema.safeParse({
      schemaVersion: JOB_FACTS_SCHEMA_VERSION,
      extractorVersion: this.#extractorVersion,
      textHash: candidate.textHash,
      provider: candidate.provider,
      model: candidate.model,
      extractedAt: new Date(now).toISOString(),
      facts: candidate.facts,
    });
    if (!entry.success) return Promise.resolve({ written: false, reason: "fatos_fora_do_contrato" });
    // O schema limita a entrada bem abaixo do entryMaxChars (um teste fixa isso): o teto só é conferido na leitura.
    const value = JSON.stringify(entry.data);

    const key = this.keyFor(candidate.textHash);
    return withDeadline(
      this.#clock,
      this.#storeTimeoutMs,
      async (signal): Promise<CacheStoreOutcome> => {
        const result = await this.#store.writeIfAbsent(key, value, CACHE_POLICY.ttlSeconds, signal);
        if (result === "gravado") return { written: true };
        return result === "ja_existia" ? { written: false, reason: "ja_existia" } : WRITE_UNAVAILABLE;
      },
      WRITE_UNAVAILABLE,
    );
  }

  /** As condições da ADR-015 D3, na ordem. */
  #refusal(candidate: CacheWriteCandidate): CacheWriteRefusal | null {
    if (candidate.degraded) return "degradada";
    if (candidate.injectionLevel !== "baixa") return "injecao_no_texto";
    if (candidate.sanitization.injectionSignal) return "injecao_na_saida";
    const confidence = candidate.effectiveConfidence;
    if (!Number.isFinite(confidence) || confidence < CACHE_POLICY.minConfidence) return "baixa_confianca";
    if (!this.#accepted.has(pairKey(candidate.provider, candidate.model))) return "provedor_nao_permitido";
    // O textHash e o resto da entrada passam pelo JobFactsCacheEntrySchema logo depois, no store.
    return this.#isGuardFixedPoint(candidate.facts) ? null : "fatos_fora_do_contrato";
  }

  /** A guarda não mudaria nada: o que entra e sai do cache é o que uma resposta limpa do LLM daria hoje (D5). */
  #isGuardFixedPoint(facts: unknown): boolean {
    const serialized = JSON.stringify(facts);
    const result = this.#guard.inspect(serialized);
    return result.ok && JSON.stringify(result.facts) === serialized;
  }

  #validate(raw: string, textHash: string): CacheLookup {
    const corrupted: CacheLookup = { hit: false, reason: "corrompido" };
    if (raw.length > CACHE_POLICY.entryMaxChars) return corrupted;
    const json = parseJsonWithoutPrototypeKeys(raw);
    if (!json.ok) return corrupted;
    const parsed = JobFactsCacheEntrySchema.safeParse(json.value);
    if (!parsed.success) return corrupted;
    const entry = parsed.data;
    if (entry.extractorVersion !== this.#extractorVersion || entry.textHash !== textHash) return corrupted;
    if (!PRODUCTION.has(entry.provider)) return corrupted;

    const now = this.#now();
    if (!isEpochMs(now)) return MISS_UNAVAILABLE;
    const extractedAt = Date.parse(entry.extractedAt);
    const oldest = now - CACHE_POLICY.ttlSeconds * 1_000 - CACHE_POLICY.maxAgeMarginMs;
    if (extractedAt > now + CACHE_POLICY.clockSkewMs || extractedAt < oldest) return corrupted;
    if (!this.#isGuardFixedPoint(entry.facts)) return corrupted;
    if (!this.#accepted.has(pairKey(entry.provider, entry.model))) return { hit: false, reason: "obsoleto" };
    return { hit: true, entry };
  }

  /** DEL em melhor esforço, sem esperar e sem rejeição solta. */
  #removeLater(key: string): void {
    Promise.resolve()
      .then(() => this.#store.remove(key, new AbortController().signal))
      .catch(() => undefined);
  }
}
