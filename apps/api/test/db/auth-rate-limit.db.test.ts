// Em que balde do limite por IP caem o `grant_type=pkce` e o `/logout`, no GoTrue local (ADR-004 D8 item 5 e §6.3,
// condição 3 do [APPSEC]; F1-API-07 07h). O simulado só repetiria a nossa hipótese: aqui é o GoTrue de verdade. Roda
// no último grupo do test:db, depois do contrato, e não chama nada além da pilha local.
//
// Hipótese, pelo código do GoTrue (supabase/auth, master em 2026-11-07; texto na emenda do 07h do ADR-004 D8 item 5):
// - `pkce`, `password` e `refresh_token` dividem um balde só, o `Token` (`token_refresh`: 150 por 5 min, rajada de 30);
//   o `pkce` não conta no `sign_in_sign_ups`, que limita o `/signup`;
// - o `/logout` não passa por limitador nenhum;
// - o limitador só roda se o GoTrue tiver de onde tirar o IP (`GOTRUE_RATE_LIMIT_HEADER` ou `Sb-Forwarded-For`). Sem
//   isso, nenhum limite por IP vale, e a CLI local pode não configurar nenhum dos dois.
// A sonda primeiro descobre se o limitador local está ativo. Ativo: confere a rajada e os baldes. Inativo: registra
// que a pilha local não tem como provar o balde, e o número do D8 item 5 fica pelo código-fonte e pelo P19.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { describe, expect, test } from "vitest";

import { parseLocalStackEnv, type LocalStack } from "./support/local-stack-env.js";
import { flood, GOTRUE_TOKEN_BUCKET, matchesBucket, onlyRefusals } from "./support/rate-limit-probe.js";

const stack: LocalStack = parseLocalStackEnv(process.env);
/** Mais que a rajada (30) com folga para a reposição durante a própria rajada. */
const MAX = 45;
/** A rajada inteira volta em 60 s (0,5 ficha por segundo). */
const REFILL_MS = 62_000;
/** Um JWS bem formado e sem assinatura válida: o logout recusa sem tocar em sessão. */
const FORGED_BEARER = `${Buffer.from('{"alg":"ES256","kid":"sonda"}').toString("base64url")}.${Buffer.from("{}").toString("base64url")}.c29uZGE`;

async function post(path: string, headers: Record<string, string>, body: unknown): Promise<number> {
  const response = await fetch(new URL(path, stack.apiUrl), {
    method: "POST",
    headers: { apikey: stack.publishableKey, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  return response.status;
}

const json = { "content-type": "application/json" };
const refreshCall = (): Promise<number> =>
  post("/auth/v1/token?grant_type=refresh_token", json, { refresh_token: `trampo-sonda-${randomUUID()}` });
const pkceCall = (): Promise<number> =>
  post("/auth/v1/token?grant_type=pkce", json, { auth_code: randomUUID(), code_verifier: "v".repeat(64) });
const logoutCall = (): Promise<number> => post("/auth/v1/logout?scope=global", { authorization: `Bearer ${FORGED_BEARER}` }, undefined);
const signupCall = (): Promise<number> =>
  post("/auth/v1/signup", json, { email: `trampo-sonda-${randomUUID()}@example.com`, password: randomUUID() });

function report(line: string): void {
  process.stdout.write(`[sonda do limite por IP] ${line}\n`);
}

describe("D8 item 5: o balde do pkce e do /logout no GoTrue local", () => {
  test("mede o limitador e fixa os baldes", { timeout: 300_000 }, async () => {
    const detect = await flood(refreshCall, MAX);

    if (detect.firstLimitedAt === null) {
      // Inativo: nenhum 429 em 45 renovações seguidas. O pkce e o logout também passam, e todas as respostas são
      // recusas do próprio GoTrue (nada de 5xx nem do gateway).
      const pkce = await flood(pkceCall, MAX);
      const logout = await flood(logoutCall, MAX);
      report(`inativo: ${MAX} renovações, ${MAX} trocas e ${MAX} logouts sem 429`);
      expect(onlyRefusals(detect)).toBe(true);
      expect(onlyRefusals(pkce)).toBe(true);
      expect(onlyRefusals(logout)).toBe(true);
      return;
    }

    // Ativo. Balde cheio de novo, e a rajada do pkce é a do balde Token.
    await sleep(REFILL_MS);
    const pkce = await flood(pkceCall, MAX);
    report(`ativo: rajada do pkce = ${String((pkce.firstLimitedAt ?? 0) - 1)} em ${String(pkce.elapsedMs)} ms`);
    expect(matchesBucket(pkce, GOTRUE_TOKEN_BUCKET)).toBe(true);
    // Mesmo balde: a renovação logo depois também é limitada.
    expect(await refreshCall()).toBe(429);
    // O pkce não conta no sign_in_sign_ups: o signup passa.
    expect(await signupCall()).not.toBe(429);

    // O logout não conta em balde nenhum: 45 seguidos sem 429, e o balde Token continua cheio depois deles.
    await sleep(REFILL_MS);
    const logout = await flood(logoutCall, MAX);
    expect(logout.firstLimitedAt).toBeNull();
    expect(onlyRefusals(logout)).toBe(true);
    expect(await refreshCall()).not.toBe(429);
  });
});
