// Composição do servidor do portal: um `PortalAuth` e uma DAL de critérios por processo, montado na primeira chamada a partir do ambiente
// (ADR-027 D9). Sem ambiente válido, lança (falha fechada).
import { createApiClient } from "./api-client";
import { readPortalConfig } from "./config";
import { createCriteriaDal, type CriteriaDal } from "./criteria";
import { createGotrueClient } from "./gotrue";
import { createPortalAuth, type PortalAuth } from "./session";
import { createAccessTokenVerifier } from "./verifier";

let cached: PortalAuth | undefined;
let cachedCriteria: CriteriaDal | undefined;

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

/** A DAL dos critérios (ADR-028), com a mesma sessão do processo e o cliente da API do `API_ORIGIN`. */
export function getPortalCriteria(): CriteriaDal {
  if (cachedCriteria === undefined) {
    const config = readPortalConfig();
    cachedCriteria = createCriteriaDal({ config, auth: getPortalAuth(), api: createApiClient({ apiOrigin: config.apiOrigin }), now: Date.now });
  }
  return cachedCriteria;
}

/** Só para os testes trocarem o ambiente entre casos. */
export function resetPortalAuthForTests(): void {
  cached = undefined;
  cachedCriteria = undefined;
}
