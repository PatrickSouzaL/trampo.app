// F1-API-07 07e (ADR-004 D8 item 4 e §4.2 "Proxy"): `API_BEHIND_PROXY` em falha fechada. A leitura no boot entra no
// 07g, com a primeira rota pública; aqui só a regra.
import { describe, expect, test } from "vitest";

import { BehindProxyConfigError, readApiBehindProxy } from "../src/presentation/edge/behind-proxy-env.js";
import { EdgeEnvSchema } from "../src/presentation/edge/edge-env.js";

const HOPS = ["173.245.48.0/20"] as const;

describe("API_BEHIND_PROXY concorda com o TRUST_PROXY", () => {
  test("true com os saltos do proxy", () => {
    expect(readApiBehindProxy({ API_BEHIND_PROXY: "true" }, HOPS)).toBe(true);
  });

  test("false sem proxy", () => {
    expect(readApiBehindProxy({ API_BEHIND_PROXY: "false" }, false)).toBe(false);
  });

  test("true com TRUST_PROXY vazio derruba o boot (o limite viraria global no balde do proxy)", () => {
    const trustProxy = EdgeEnvSchema.parse({ TRUST_PROXY: "" }).TRUST_PROXY;
    expect(() => readApiBehindProxy({ API_BEHIND_PROXY: "true" }, trustProxy)).toThrow(BehindProxyConfigError);
  });

  test("false com saltos configurados é contradição e derruba o boot", () => {
    expect(() => readApiBehindProxy({ API_BEHIND_PROXY: "false" }, HOPS)).toThrow(BehindProxyConfigError);
  });
});

describe("obrigatória fora de NODE_ENV=test exato", () => {
  test.each([[{}], [{ NODE_ENV: "production" }], [{ NODE_ENV: "development" }], [{ NODE_ENV: "Test" }], [{ NODE_ENV: "test ", API_BEHIND_PROXY: "" }]])(
    "ausente com %j derruba o boot",
    (source) => {
      expect(() => readApiBehindProxy(source, false)).toThrow(BehindProxyConfigError);
    },
  );

  test("ausente em NODE_ENV=test segue o TRUST_PROXY", () => {
    expect(readApiBehindProxy({ NODE_ENV: "test" }, false)).toBe(false);
    expect(readApiBehindProxy({ NODE_ENV: "test", API_BEHIND_PROXY: "" }, HOPS)).toBe(true);
  });

  test("em NODE_ENV=test, o valor declarado ainda precisa concordar", () => {
    expect(() => readApiBehindProxy({ NODE_ENV: "test", API_BEHIND_PROXY: "true" }, false)).toThrow(BehindProxyConfigError);
  });
});

describe("só true ou false, exatos", () => {
  test.each(["TRUE", "True", "1", "yes", " true", "true ", "false,", "on"])("%j derruba o boot sem ecoar o valor", (raw) => {
    expect(() => readApiBehindProxy({ API_BEHIND_PROXY: raw }, HOPS)).toThrow(
      /^API_BEHIND_PROXY precisa ser true ou false e concordar com o TRUST_PROXY \(true exige os saltos do proxy\)$/,
    );
  });
});
