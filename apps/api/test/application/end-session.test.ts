// F1-API-07 07f (ADR-004 D4, `EndSession`; D7; §4.2 "Logout"): logout global pelo *bulkhead*, 204 ou 503.
import { describe, expect, test } from "vitest";

import { EndSession, type EndSessionOutcome } from "../../src/application/auth/end-session.js";
import { GOTRUE_EGRESS_POLICY } from "../../src/application/auth/gotrue-egress.js";

import { AuthHarness } from "./fakes/auth-session-harness.js";

const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ0ZXN0ZSJ9.c2lnbmF0dXJh";
const PROVIDER_DOWN = { kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: null } as const;

function setup() {
  const h = new AuthHarness();
  const end = new EndSession({ gateway: h.gateway, egress: h.egress });
  const run = (): Promise<EndSessionOutcome> => end.execute({ accessToken: TOKEN });
  return { h, run };
}

describe("EndSession", () => {
  test("GoTrue ok (2xx, ou 401 de sessão já revogada no adapter): encerrada (204), 1 chamada com o Bearer", async () => {
    const { h, run } = setup();
    expect(await run()).toEqual({ kind: "encerrada" });
    expect(h.calls).toEqual([{ method: "logout", args: [TOKEN], signal: undefined }]);
    expect(h.egressRuns).toEqual(["logout"]);
    expect(h.events).toEqual(["egress:logout", "gotrue:logout"]);
  });

  test("o logout não consome o orçamento do /token (só o bulkhead, até o 07h)", async () => {
    const { h, run } = setup();
    for (let i = 0; i < 100; i += 1) await run();
    await h.spend("troca", GOTRUE_EGRESS_POLICY.trocaMax);
  });

  test.each(["recusado", "nao_recebido", "pode_ter_rotacionado"] as const)("GoTrue %s: 503, 1 chamada", async (reason) => {
    const { h, run } = setup();
    h.logoutSteps.push(() => ({ ok: false, reason }));
    expect(await run()).toEqual(PROVIDER_DOWN);
    expect(h.calls).toHaveLength(1);
  });

  test("gateway que rejeita: 503", async () => {
    const { h, run } = setup();
    h.logoutSteps.push(() => Promise.reject(new Error("quebrou")));
    expect(await run()).toEqual(PROVIDER_DOWN);
  });

  test("bulkhead cheio: 503 com retryAfterSeconds 5 e 0 chamadas", async () => {
    const { h, run } = setup();
    const release: (() => void)[] = [];
    const hold = Array.from({ length: GOTRUE_EGRESS_POLICY.maxConcurrent }, () =>
      h.realEgress.run("troca", () => new Promise<void>((resolve) => release.push(resolve))),
    );
    expect(await run()).toEqual({ kind: "indisponivel", reason: "auth_provedor_indisponivel", retryAfterSeconds: 5 });
    expect(h.calls).toEqual([]);
    for (const done of release) done();
    await Promise.all(hold);
  });
});
