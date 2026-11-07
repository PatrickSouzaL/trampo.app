// F1-API-07 07e (ADR-004 D8 item 4 e §4.2 "Limitador local" e "Proxy"; emenda ao ADR-014, D10): o limitador em memória
// das duas rotas públicas de auth, antes do JWT. Nenhuma rota real o usa antes do 07g (ADR-004 §6.3, condição 1): o
// hook é provado numa rota de prova, como o auth.test.ts faz com /probe.
import { randomBytes } from "node:crypto";

import { ApiErrorSchema } from "@trampo/contracts/api";
import { afterEach, describe, expect, test } from "vitest";

import type { Clock } from "../src/application/ports/clock.js";
import { createHmacKeyPseudonymizer, type KeyPseudonymizer, type PseudonymDomain } from "../src/infrastructure/crypto/hmac-key-pseudonymizer.js";
import { buildApp } from "../src/presentation/build-app.js";
import {
  PRE_AUTH_LIMIT_POLICY,
  createPreAuthLimitHook,
  createPreAuthLimiter,
  type PreAuthLimitClass,
  type PreAuthLimiter,
} from "../src/presentation/edge/pre-auth-limit.js";
import { TEST_AUTHORIZATION, fakeVerifier } from "./auth-fakes.js";
import { openLimits } from "./limit-fakes.js";

// Gerado em runtime: nenhum literal de segredo no repositório (gitleaks).
const PEPPER = randomBytes(32).toString("base64url");
const MINUTE = PRE_AUTH_LIMIT_POLICY.windowMs;

class ManualClock implements Clock {
  constructor(public now = 10 * 60_000) {}
  nowMs(): number {
    return this.now;
  }
  sleep(): Promise<void> {
    return Promise.resolve();
  }
}

/** Pseudonimizador que registra o que recebe e devolve um pseudônimo opaco (ou o mesmo para todos). */
function recordingPseudonymizer(collapse = false) {
  const seen: { domain: PseudonymDomain; value: string }[] = [];
  const pseudonymizer: KeyPseudonymizer = {
    pseudonym(domain, value) {
      seen.push({ domain, value });
      return collapse ? "mesmo" : `p-${Buffer.from(value).toString("hex")}`;
    },
  };
  return { pseudonymizer, seen };
}

function limiterWith(pseudonymizer: KeyPseudonymizer = createHmacKeyPseudonymizer(PEPPER)) {
  const clock = new ManualClock();
  return { clock, limiter: createPreAuthLimiter(clock, pseudonymizer) };
}

function countPassing(limiter: PreAuthLimiter, limitClass: PreAuthLimitClass, ip: string, n: number): number {
  let passed = 0;
  for (let i = 0; i < n; i += 1) if (limiter.check(limitClass, ip).ok) passed += 1;
  return passed;
}

const ipv4 = (n: number): string => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

describe("limites por classe (ADR-004 D4 e D8 item 4)", () => {
  test("a política é a do ADR: 10/min na troca, 30/min na renovação, 10.000 baldes", () => {
    expect(PRE_AUTH_LIMIT_POLICY).toEqual({ windowMs: 60_000, limits: { auth_troca: 10, auth_renovacao: 30 }, maxBuckets: 10_000 });
  });

  test("a 11ª troca no mesmo minuto é negada com Retry-After até o fim da janela", () => {
    const { clock, limiter } = limiterWith();
    clock.now = 10 * MINUTE + 15_000;
    expect(countPassing(limiter, "auth_troca", "198.51.100.7", 10)).toBe(10);
    expect(limiter.check("auth_troca", "198.51.100.7")).toEqual({ ok: false, retryAfterSeconds: 45 });
  });

  test("a 31ª renovação no mesmo minuto é negada", () => {
    const { limiter } = limiterWith();
    expect(countPassing(limiter, "auth_renovacao", "198.51.100.7", 30)).toBe(30);
    expect(limiter.check("auth_renovacao", "198.51.100.7")).toMatchObject({ ok: false });
  });

  test("as classes e os IPs têm baldes próprios", () => {
    const { limiter } = limiterWith();
    expect(countPassing(limiter, "auth_troca", "198.51.100.7", 11)).toBe(10);
    expect(countPassing(limiter, "auth_renovacao", "198.51.100.7", 30)).toBe(30);
    expect(countPassing(limiter, "auth_troca", "198.51.100.8", 10)).toBe(10);
  });

  test("a negada também conta: quem insiste continua bloqueado na janela seguinte", () => {
    const { clock, limiter } = limiterWith();
    clock.now = 10 * MINUTE;
    expect(countPassing(limiter, "auth_troca", "198.51.100.7", 30)).toBe(10);
    clock.now = 11 * MINUTE + 30_000;
    // Anterior = 30 pesando metade (15) + 1 > 10.
    expect(limiter.check("auth_troca", "198.51.100.7")).toMatchObject({ ok: false });
  });
});

describe("janela deslizante, não fixa", () => {
  test("a virada do minuto não zera: a janela anterior pesa pela fração que ainda cabe", () => {
    // Dirigido "janela fixa no lugar da deslizante".
    const { clock, limiter } = limiterWith();
    clock.now = 10 * MINUTE + 59_000;
    expect(countPassing(limiter, "auth_troca", "198.51.100.7", 10)).toBe(10);
    clock.now = 11 * MINUTE + 1_000;
    // floor(10 × 59/60) + 1 = 10: passa uma; a seguinte pesa 11.
    expect(countPassing(limiter, "auth_troca", "198.51.100.7", 5)).toBe(1);
    clock.now = 11 * MINUTE + 30_000;
    // floor(10 × 30/60) + 6 = 11: a janela anterior ainda pesa e nada passa.
    expect(limiter.check("auth_troca", "198.51.100.7")).toMatchObject({ ok: false });
  });

  test("depois de duas janelas sem uso, o balde zera", () => {
    const { clock, limiter } = limiterWith();
    clock.now = 10 * MINUTE;
    expect(countPassing(limiter, "auth_troca", "198.51.100.7", 20)).toBe(10);
    clock.now = 12 * MINUTE;
    expect(countPassing(limiter, "auth_troca", "198.51.100.7", 10)).toBe(10);
  });
});

describe("balde de IP (ADR-014 D4): IPv6 pelo /64", () => {
  test("dois endereços do mesmo /64 dividem o balde; outro /64 tem o seu", () => {
    // Dirigido "IPv6 fora do /64".
    const { limiter } = limiterWith();
    expect(countPassing(limiter, "auth_troca", "2001:db8:1:2::1", 6)).toBe(6);
    expect(countPassing(limiter, "auth_troca", "2001:db8:1:2:ffff:ffff:ffff:9", 6)).toBe(4);
    expect(countPassing(limiter, "auth_troca", "2001:db8:1:3::1", 10)).toBe(10);
  });

  test("IPv4 mapeado em IPv6 é o mesmo balde do IPv4", () => {
    const { limiter } = limiterWith();
    expect(countPassing(limiter, "auth_troca", "203.0.113.9", 5)).toBe(5);
    expect(countPassing(limiter, "auth_troca", "::ffff:203.0.113.9", 10)).toBe(5);
  });
});

describe("chave HMAC (SR-17 por analogia)", () => {
  test("o pseudonimizador recebe o balde no domínio ip, e o IP não entra na chave", () => {
    const { pseudonymizer, seen } = recordingPseudonymizer();
    const { limiter } = limiterWith(pseudonymizer);
    limiter.check("auth_troca", "2001:db8:1:2::1");
    limiter.check("auth_renovacao", "198.51.100.7");
    expect(seen).toEqual([
      { domain: "ip", value: "v6:2001:db8:1:2::/64" },
      { domain: "ip", value: "v4:198.51.100.7" },
    ]);
  });

  test("a chave é o pseudônimo: IPs distintos com o mesmo pseudônimo dividem o balde", () => {
    // Dirigido "chave sem HMAC": com o IP (ou o balde) na chave, os dois teriam baldes próprios.
    const { pseudonymizer } = recordingPseudonymizer(true);
    const { limiter } = limiterWith(pseudonymizer);
    expect(countPassing(limiter, "auth_troca", "198.51.100.7", 6)).toBe(6);
    expect(countPassing(limiter, "auth_troca", "203.0.113.200", 6)).toBe(4);
  });

  test("com o HMAC real, o pepper muda o pseudônimo e o balde continua por IP", () => {
    const other = createHmacKeyPseudonymizer(randomBytes(32).toString("base64url"));
    expect(other.pseudonym("ip", "v4:198.51.100.7")).not.toBe(createHmacKeyPseudonymizer(PEPPER).pseudonym("ip", "v4:198.51.100.7"));
    const { limiter } = limiterWith(other);
    expect(countPassing(limiter, "auth_troca", "198.51.100.7", 11)).toBe(10);
    expect(countPassing(limiter, "auth_troca", "198.51.100.8", 10)).toBe(10);
  });
});

describe("10.000 baldes, transbordo sem despejo", () => {
  test("cheio, os novos dividem um balde de transbordo por classe", () => {
    const { limiter } = limiterWith(recordingPseudonymizer().pseudonymizer);
    for (let n = 0; n < PRE_AUTH_LIMIT_POLICY.maxBuckets; n += 1) expect(limiter.check("auth_troca", ipv4(n)).ok).toBe(true);
    const fresh = Array.from({ length: 12 }, (_, i) => `172.16.0.${i}`);
    // 12 IPs novos, uma troca cada: no transbordo, só 10 passam.
    expect(fresh.filter((ip) => limiter.check("auth_troca", ip).ok)).toHaveLength(10);
    // O transbordo da renovação é outro balde, e a renovação ainda tem a própria tabela cheia de troca.
    expect(countPassing(limiter, "auth_renovacao", "172.16.1.1", 31)).toBe(30);
  });

  test("nenhum balde vivo é despejado: o IP no limite continua bloqueado depois da tabela encher", () => {
    // Dirigido "transbordo que despeja": despejando o mais antigo, o IP voltaria com o balde zerado.
    const { limiter } = limiterWith(recordingPseudonymizer().pseudonymizer);
    expect(countPassing(limiter, "auth_troca", "198.51.100.7", 10)).toBe(10);
    for (let n = 0; n < PRE_AUTH_LIMIT_POLICY.maxBuckets - 1; n += 1) limiter.check("auth_troca", ipv4(n));
    expect(countPassing(limiter, "auth_troca", "172.16.0.1", 3)).toBe(3);
    expect(limiter.check("auth_troca", "198.51.100.7")).toMatchObject({ ok: false });
    expect(countPassing(limiter, "auth_troca", ipv4(5), 9)).toBe(9);
  });

  test("os baldes vencidos saem da tabela, e o IP novo volta a ter balde próprio", () => {
    const { clock, limiter } = limiterWith(recordingPseudonymizer().pseudonymizer);
    clock.now = 10 * MINUTE;
    for (let n = 0; n < PRE_AUTH_LIMIT_POLICY.maxBuckets; n += 1) limiter.check("auth_troca", ipv4(n));
    expect(countPassing(limiter, "auth_troca", "172.16.0.1", 11)).toBe(10);
    // Na janela seguinte, os 10.000 ainda pesam: o novo continua no transbordo, onde as 11 contadas pesam floor(11 × 59/60).
    clock.now = 11 * MINUTE + 1_000;
    expect(limiter.check("auth_troca", "172.16.0.2")).toMatchObject({ ok: false });
    clock.now = 12 * MINUTE;
    expect(countPassing(limiter, "auth_troca", "172.16.0.2", 11)).toBe(10);
    expect(countPassing(limiter, "auth_troca", "172.16.0.3", 11)).toBe(10);
  });

  test("o transbordo também zera depois de duas janelas sem uso, com a tabela ainda cheia", () => {
    const { clock, limiter } = limiterWith(recordingPseudonymizer().pseudonymizer);
    clock.now = 10 * MINUTE;
    for (let n = 0; n < PRE_AUTH_LIMIT_POLICY.maxBuckets; n += 1) limiter.check("auth_troca", ipv4(n));
    expect(countPassing(limiter, "auth_troca", "172.16.0.1", 11)).toBe(10);
    clock.now = 11 * MINUTE;
    for (let n = 0; n < PRE_AUTH_LIMIT_POLICY.maxBuckets; n += 1) limiter.check("auth_troca", ipv4(n));
    clock.now = 12 * MINUTE;
    // A tabela segue cheia de baldes vivos: o novo cai no transbordo, que não carrega as 11 de duas janelas atrás.
    expect(countPassing(limiter, "auth_troca", "172.16.0.5", 11)).toBe(10);
  });

  test("a varredura para no 1º balde vivo: o reusado vai para o fim e não sai antes da hora", () => {
    const { clock, limiter } = limiterWith(recordingPseudonymizer().pseudonymizer);
    clock.now = 10 * MINUTE;
    for (let n = 0; n < PRE_AUTH_LIMIT_POLICY.maxBuckets; n += 1) limiter.check("auth_troca", ipv4(n));
    clock.now = 11 * MINUTE;
    // O 1º da tabela é reusado na janela seguinte e passa a ser o último.
    expect(countPassing(limiter, "auth_troca", ipv4(0), 9)).toBe(9);
    clock.now = 12 * MINUTE;
    // Os outros 9.999 venceram; o ipv4(0) ainda pesa floor(9 × 1) + 1 = 10 e passa uma só.
    expect(countPassing(limiter, "auth_troca", ipv4(0), 2)).toBe(1);
    // Os vencidos saíram (o reusado não travou a varredura): dois IPs novos têm baldes próprios, fora do transbordo.
    expect(countPassing(limiter, "auth_troca", "172.16.0.9", 10)).toBe(10);
    expect(countPassing(limiter, "auth_troca", "172.16.0.10", 10)).toBe(10);
  });
});

describe("hook numa rota de prova (nenhuma rota real antes do 07g)", () => {
  let app: ReturnType<typeof buildApp> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function probeApp(options: { trustProxy?: false | readonly string[]; lines?: string[] } = {}) {
    const { limiter } = limiterWith();
    let handled = 0;
    const instance = buildApp({
      accessTokenVerifier: fakeVerifier().verifier,
      limits: openLimits,
      trustProxy: options.trustProxy ?? false,
      logger: options.lines === undefined ? false : { level: "trace", stream: { write: (line) => void options.lines?.push(line) } },
    });
    instance.post("/probe/troca", { onRequest: createPreAuthLimitHook(limiter, "auth_troca") }, async () => {
      handled += 1;
      return { ok: true };
    });
    app = instance;
    return { app: instance, handled: () => handled };
  }

  const post = (instance: ReturnType<typeof buildApp>, headers: Record<string, string> = {}, remoteAddress?: string) =>
    instance.inject({
      method: "POST",
      url: "/probe/troca",
      headers: { authorization: TEST_AUTHORIZATION, "content-type": "application/json", ...headers },
      payload: "{}",
      ...(remoteAddress === undefined ? {} : { remoteAddress }),
    });

  test("a 11ª troca dá 429 LIMITE_DE_TAXA com Retry-After, sem chegar ao handler", async () => {
    const { app: instance, handled } = probeApp();
    for (let i = 0; i < 10; i += 1) expect((await post(instance)).statusCode).toBe(200);
    const res = await post(instance);
    expect(res.statusCode).toBe(429);
    const body = ApiErrorSchema.parse(res.json());
    expect(body.code).toBe("LIMITE_DE_TAXA");
    expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(res.headers["retry-after"]).toBe(String(body.retryAfterSeconds));
    expect(handled()).toBe(10);
  });

  test("com o proxy confiável, dois X-Forwarded-For distintos caem em baldes distintos", async () => {
    const { app: instance } = probeApp({ trustProxy: ["127.0.0.1"] });
    for (const client of ["198.51.100.1", "198.51.100.2"]) {
      for (let i = 0; i < 10; i += 1) expect((await post(instance, { "x-forwarded-for": client })).statusCode).toBe(200);
      expect((await post(instance, { "x-forwarded-for": client })).statusCode).toBe(429);
    }
  });

  test("X-Forwarded-For vindo de IP não confiável é ignorado: o balde é o do remetente", async () => {
    // Dirigido "X-Forwarded-For de IP não confiável aceito".
    const { app: instance } = probeApp({ trustProxy: ["127.0.0.1"] });
    for (let i = 0; i < 10; i += 1) {
      expect((await post(instance, { "x-forwarded-for": `198.51.100.${i}` }, "203.0.113.50")).statusCode).toBe(200);
    }
    expect((await post(instance, { "x-forwarded-for": "198.51.100.200" }, "203.0.113.50")).statusCode).toBe(429);
  });

  test("sem TRUST_PROXY, o X-Forwarded-For não muda o balde (limite global atrás de proxy, por isso o API_BEHIND_PROXY)", async () => {
    const { app: instance } = probeApp();
    for (let i = 0; i < 10; i += 1) expect((await post(instance, { "x-forwarded-for": `198.51.100.${i}` })).statusCode).toBe(200);
    expect((await post(instance, { "x-forwarded-for": "198.51.100.250" })).statusCode).toBe(429);
  });

  test("SR-12: nem o IP do cliente nem o do proxy aparecem no log, inclusive no 429", async () => {
    const lines: string[] = [];
    const { app: instance } = probeApp({ trustProxy: ["127.0.0.1"], lines });
    for (let i = 0; i < 11; i += 1) await post(instance, { "x-forwarded-for": "198.51.100.77" });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain("198.51.100.77");
      expect(line).not.toContain("127.0.0.1");
    }
  });
});
