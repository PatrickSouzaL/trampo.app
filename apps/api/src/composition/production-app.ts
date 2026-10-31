// Composição de produção (Trilha L1: F1-LLM-01 parte 2 e F1-LLM-02; ADR-022 D8, ADR-020 D8, ADR-009 D7): o
// composeApp com a cadeia de LLM montada a partir do ambiente. Um adapter por provedor da `LLM_PROVIDER_CHAIN`, na
// ordem dela, com o prompt do código. É o que o main.ts chama, e o que o teste de boot exercita.
//
// Falha fechado no boot: cadeia ausente ou fora da política (o Ollama nunca sobe por aqui), ou credencial ausente ou
// fora da forma de um provedor da cadeia, derrubam a subida antes de abrir a porta. As mensagens citam só o nome da
// variável. Credencial de provedor fora da cadeia não é lida.
import type { LlmProviderId } from "@trampo/contracts";

import {
  EXTRACTION_PROMPT_VERSION,
  ProviderChainConfigError,
  parseLlmProviderChain,
  type JobFactsExtractor,
} from "../application/index.js";
import {
  WORKERS_AI_DEFAULT_MODEL,
  createCloudflareWorkersAiExtractor,
} from "../infrastructure/llm/cloudflare-workers-ai-extractor.js";
import { createGroqExtractor } from "../infrastructure/llm/groq-extractor.js";

import {
  composeApp,
  type ComposedApp,
  type ComposeOptions,
  type Environment,
  type LlmComposition,
} from "./compose-app.js";

/**
 * Origem de cada provedor, só para os testes (o Groq e a Workers AI simulados em socket real). O main.ts não passa
 * nada: a URL de produção é a fixa de cada adapter, conferida no boot (ADR-022 D3, ADR-020 D3).
 */
export interface ProductionLlmTestHooks {
  readonly baseUrls?: Readonly<Partial<Record<LlmProviderId, URL>>>;
}

/**
 * O adapter de produção de um provedor. Só o Groq e a Workers AI têm adapter de produção; qualquer outro id lança
 * (o `parseLlmProviderChain` já os recusa antes, então este é o segundo cadeado).
 */
export function createProductionExtractor(
  provider: LlmProviderId,
  source: Environment,
  hooks: ProductionLlmTestHooks = {},
): JobFactsExtractor {
  const baseUrl = hooks.baseUrls?.[provider];
  const origin = baseUrl === undefined ? {} : { baseUrl };
  switch (provider) {
    case "groq":
      return createGroqExtractor({ apiKey: source["GROQ_API_KEY"] ?? "", ...origin });
    case "cloudflare_workers_ai":
      return createCloudflareWorkersAiExtractor({
        accountId: source["CLOUDFLARE_ACCOUNT_ID"] ?? "",
        apiToken: source["CLOUDFLARE_API_TOKEN"] ?? "",
        model: workersAiModel(source["CLOUDFLARE_WORKERS_AI_MODEL"]),
        ...origin,
      });
    default:
      throw new ProviderChainConfigError("provedor sem adapter de produção nesta fase");
  }
}

/** Vazia ou ausente: o modelo medido no S-1 (ADR-020 D10; spike-metrics §2.8). Outro valor passa pela forma do D3. */
function workersAiModel(value: string | undefined): string {
  return value === undefined || value === "" ? WORKERS_AI_DEFAULT_MODEL : value;
}

/** A cadeia de produção: `LLM_PROVIDER_CHAIN` validada, um adapter por provedor e o prompt do código (p3). */
export function productionLlmComposition(source: Environment, hooks: ProductionLlmTestHooks = {}): LlmComposition {
  const chain = parseLlmProviderChain(source["LLM_PROVIDER_CHAIN"], { allowDevOnlyProviders: false });
  return {
    extractors: chain.map((provider) => createProductionExtractor(provider, source, hooks)),
    promptVersion: EXTRACTION_PROMPT_VERSION,
  };
}

/**
 * A API de produção: sem cadeia de LLM válida e completa, não sobe. A análise só cai no determinístico em tempo de
 * requisição (cota, circuito aberto, falha do provedor), nunca por configuração esquecida.
 */
export function composeProductionApp(
  source: Environment,
  options: Omit<ComposeOptions, "llm"> = {},
  hooks: ProductionLlmTestHooks = {},
): ComposedApp {
  return composeApp(source, { ...options, llm: productionLlmComposition(source, hooks) });
}
