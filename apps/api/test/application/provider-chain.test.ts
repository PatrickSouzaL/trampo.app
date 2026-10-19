// LLM_PROVIDER_CHAIN validada no boot (ADR-009 D7; HITL-012): Gemini recusado, Ollama só em dev.
import { describe, expect, test } from "vitest";

import { ProviderChainConfigError, parseLlmProviderChain } from "../../src/application/index.js";

const PROD = { allowDevOnlyProviders: false } as const;
const DEV = { allowDevOnlyProviders: true } as const;

describe("parseLlmProviderChain", () => {
  test("a cadeia do .env.example passa, na ordem dada, e sai congelada", () => {
    const chain = parseLlmProviderChain("groq,cloudflare_workers_ai", PROD);
    expect(chain).toEqual(["groq", "cloudflare_workers_ai"]);
    expect(Object.isFrozen(chain)).toBe(true);
    expect(parseLlmProviderChain(" cloudflare_workers_ai , groq ", PROD)).toEqual(["cloudflare_workers_ai", "groq"]);
  });

  test("ollama só com allowDevOnlyProviders", () => {
    expect(() => parseLlmProviderChain("groq,ollama", PROD)).toThrow(ProviderChainConfigError);
    expect(parseLlmProviderChain("ollama", DEV)).toEqual(["ollama"]);
    expect(parseLlmProviderChain("groq,cloudflare_workers_ai,ollama", DEV)).toHaveLength(3);
  });

  test.each([
    ["Gemini recusado nas Fases 0 e 1 (HITL-012)", "groq,google_ai_studio"],
    ["Gemini sozinho", "google_ai_studio"],
    ["ausente", undefined],
    ["vazia", ""],
    ["só espaços", "  "],
    ["item vazio", "groq,,cloudflare_workers_ai"],
    ["vírgula sobrando", "groq,"],
    ["repetido", "groq,groq"],
    ["desconhecido", "openai"],
    ["caixa diferente", "Groq"],
    ["longa demais (só cabe repetindo)", "groq,cloudflare_workers_ai,ollama,groq"],
  ])("%s: lança no boot, sem ecoar o valor", (_label, raw) => {
    expect(() => parseLlmProviderChain(raw, DEV)).toThrow(ProviderChainConfigError);
    try {
      parseLlmProviderChain(raw, DEV);
    } catch (error) {
      expect((error as Error).name).toBe("ProviderChainConfigError");
      if (raw !== undefined && raw.trim() !== "") expect((error as Error).message).not.toContain(raw);
    }
  });

  test("Gemini é recusado mesmo com allowDevOnlyProviders", () => {
    expect(() => parseLlmProviderChain("google_ai_studio", DEV)).toThrow(ProviderChainConfigError);
  });
});
