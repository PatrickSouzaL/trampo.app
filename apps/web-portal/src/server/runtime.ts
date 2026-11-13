// Composição do servidor do portal: um `PortalAuth` por processo, montado na primeira chamada a partir do ambiente
// (ADR-027 D9). Sem ambiente válido, lança (falha fechada).
import { readPortalConfig } from "./config";
import { createGotrueClient } from "./gotrue";
import { createPortalAuth, type PortalAuth } from "./session";
import { createAccessTokenVerifier } from "./verifier";

let cached: PortalAuth | undefined;

/** O logout da sessão órfã, em segundo plano: o cliente do GoTrue nunca rejeita, então não há rejeição solta. */
export function runInBackground(task: Promise<unknown>): void {
  void task;
}

export function getPortalAuth(): PortalAuth {
  if (cached === undefined) {
    const config = readPortalConfig();
    cached = createPortalAuth({
      config,
      gotrue: createGotrueClient({ supabaseUrl: config.supabaseUrl, publishableKey: config.publishableKey }),
      verifier: createAccessTokenVerifier({ issuer: config.issuer, jwksUrl: config.jwksUrl }),
      now: Date.now,
      defer: runInBackground,
    });
  }
  return cached;
}

/** Só para os testes trocarem o ambiente entre casos. */
export function resetPortalAuthForTests(): void {
  cached = undefined;
}
