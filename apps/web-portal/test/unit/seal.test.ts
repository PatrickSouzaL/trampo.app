import { createCipheriv, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { SEAL_PURPOSES, SealKeyringError, createSealer, parseSealKeyring } from "../../src/server/seal";

// Material de chave montado em tempo de execução (cuidado 14 do TRILHAS): nada com cara de chave no git.
const material = (): string => randomBytes(32).toString("base64url");
const ORIGIN = "https://portal.exemplo.invalid";

function ring(extra: readonly string[] = []) {
  const a = material();
  return { a, keyring: parseSealKeyring(["a1:" + a, ...extra].join(","), "a1") };
}

describe("parseSealKeyring (ADR-027 D4)", () => {
  it("aceita de 1 a 4 chaves e escolhe a ativa", () => {
    const keys = ["a1", "b2", "c3", "d4"].map((kid) => `${kid}:${material()}`).join(",");
    const parsed = parseSealKeyring(keys, "c3");
    expect(parsed.active.kid).toBe("c3");
    expect([...parsed.byKid.keys()]).toEqual(["a1", "b2", "c3", "d4"]);
    expect(parsed.active.key).toHaveLength(32);
  });

  it.each([
    ["vazio", "", "a1"],
    ["5 chaves", ["a1", "b2", "c3", "d4", "e5"].map((k) => `${k}:${"A".repeat(43)}`).join(","), "a1"],
    ["sem dois-pontos", "a1" + "A".repeat(43), "a1"],
    ["kid maiúsculo", `A1:${"A".repeat(43)}`, "A1"],
    ["kid longo", `${"a".repeat(17)}:${"A".repeat(43)}`, "a".repeat(17)],
    ["chave curta", `a1:${"A".repeat(42)}`, "a1"],
    ["chave longa", `a1:${"A".repeat(44)}`, "a1"],
    ["base64 com padding", `a1:${"A".repeat(42)}=`, "a1"],
    ["base64url não canônica", `a1:${"A".repeat(42)}B`, "a1"],
    ["espaço", ` a1:${"A".repeat(43)}`, "a1"],
    ["ativa fora do anel", `a1:${"A".repeat(43)}`, "b2"],
    ["entrada vazia no meio", `a1:${"A".repeat(43)},,b2:${"B".repeat(43)}`, "a1"],
  ])("recusa %s", (_caso, keys, active) => {
    expect(() => parseSealKeyring(keys, active)).toThrow(SealKeyringError);
  });

  it("recusa kid repetido e material repetido", () => {
    const m = material();
    expect(() => parseSealKeyring(`a1:${m},a1:${material()}`, "a1")).toThrow(SealKeyringError);
    expect(() => parseSealKeyring(`a1:${m},b2:${m}`, "a1")).toThrow(SealKeyringError);
  });

  it("a mensagem nunca repete o valor recebido", () => {
    const m = material();
    try {
      parseSealKeyring(`a1:${m}`, "zz");
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain(m);
      expect(String((error as Error).message)).not.toContain("zz");
    }
  });
});

describe("createSealer", () => {
  it("sela e abre de volta, com a forma <versão>.<kid>.<iv>.<cifrado>.<tag>", () => {
    const { keyring } = ring();
    const sealer = createSealer(keyring, SEAL_PURPOSES.sessao, ORIGIN);
    const envelope = sealer.seal('{"x":1}');
    expect(envelope).toMatch(/^s1\.a1\.[\w-]{16}\.[\w-]+\.[\w-]{22}$/);
    expect(sealer.open(envelope as string)).toBe('{"x":1}');
    // IV novo a cada selagem.
    expect(sealer.seal('{"x":1}')).not.toBe(envelope);
  });

  it("o fluxo usa a versão f1", () => {
    const { keyring } = ring();
    expect(createSealer(keyring, SEAL_PURPOSES.fluxo, ORIGIN).seal("{}")).toMatch(/^f1\.a1\./);
    // ADR-028 D8: o rascunho dos critérios tem versão e finalidade próprias.
    expect(createSealer(keyring, SEAL_PURPOSES.rascunho, ORIGIN).seal("{}")).toMatch(/^r1\.a1\./);
  });

  it("finalidades e origens não se misturam (AAD)", () => {
    const { keyring } = ring();
    const sessao = createSealer(keyring, SEAL_PURPOSES.sessao, ORIGIN);
    const fluxo = createSealer(keyring, SEAL_PURPOSES.fluxo, ORIGIN);
    const outraOrigem = createSealer(keyring, SEAL_PURPOSES.sessao, "https://outro.exemplo.invalid");
    const envelope = sessao.seal("{}") as string;
    expect(fluxo.open(envelope)).toBeNull();
    expect(fluxo.open(envelope.replace(/^s1/, "f1"))).toBeNull();
    expect(outraOrigem.open(envelope)).toBeNull();
  });

  it("abre com uma chave antiga do anel e recusa kid desconhecido", () => {
    const { a, keyring } = ring();
    const antigo = createSealer(keyring, SEAL_PURPOSES.sessao, ORIGIN).seal("{}") as string;
    const novo = parseSealKeyring(`b2:${material()},a1:${a}`, "b2");
    expect(createSealer(novo, SEAL_PURPOSES.sessao, ORIGIN).open(antigo)).toBe("{}");
    const semA = parseSealKeyring(`b2:${material()}`, "b2");
    expect(createSealer(semA, SEAL_PURPOSES.sessao, ORIGIN).open(antigo)).toBeNull();
  });

  it("recusa cada parte adulterada", () => {
    const { keyring } = ring();
    const sealer = createSealer(keyring, SEAL_PURPOSES.sessao, ORIGIN);
    const envelope = sealer.seal('{"conteudo":"qualquer"}') as string;
    const parts = envelope.split(".");
    for (const index of [2, 3, 4]) {
      const part = parts[index] as string;
      const flipped = (part[0] === "A" ? "B" : "A") + part.slice(1);
      const copy = [...parts];
      copy[index] = flipped;
      expect(sealer.open(copy.join("."))).toBeNull();
    }
  });

  it.each([
    ["vazio", ""],
    ["partes a menos", "s1.a1.AAAAAAAAAAAAAAAA.AAAA"],
    ["partes a mais", "s1.a1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA.x"],
    ["versão errada", "s2.a1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA"],
    ["iv curto", "s1.a1.AAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA"],
    ["tag curta", "s1.a1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAA"],
    ["caractere fora do alfabeto", "s1.a1.AAAAAAAAAAAAAAAA.AA+A.AAAAAAAAAAAAAAAAAAAAAA"],
  ])("recusa envelope fora da forma: %s", (_caso, envelope) => {
    const { keyring } = ring();
    expect(createSealer(keyring, SEAL_PURPOSES.sessao, ORIGIN).open(envelope)).toBeNull();
  });

  it("recusa base64url não canônica (bits sobrando no último caractere)", () => {
    const { keyring } = ring();
    const sealer = createSealer(keyring, SEAL_PURPOSES.sessao, ORIGIN);
    const envelope = sealer.seal("{}") as string;
    const parts = envelope.split(".");
    // 16 bytes de tag = 22 caracteres; o último carrega 2 bits de enchimento. Trocar por um vizinho que só muda esses
    // bits decodifica para os mesmos bytes: a forma canônica é que barra.
    const tag = parts[4] as string;
    const last = tag.at(-1) as string;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const index = alphabet.indexOf(last);
    const sibling = alphabet[(index & ~3) | ((index + 1) & 3)] as string;
    parts[4] = tag.slice(0, -1) + sibling;
    expect(Buffer.from(parts[4], "base64url")).toEqual(Buffer.from(tag, "base64url"));
    expect(sealer.open(parts.join("."))).toBeNull();
  });

  it("não sela texto acima do teto da finalidade e recusa cifrado acima do teto", () => {
    const { keyring } = ring();
    const fluxo = createSealer(keyring, SEAL_PURPOSES.fluxo, ORIGIN);
    expect(fluxo.seal("x".repeat(SEAL_PURPOSES.fluxo.maxPlaintextBytes))).not.toBeNull();
    expect(fluxo.seal("x".repeat(SEAL_PURPOSES.fluxo.maxPlaintextBytes + 1))).toBeNull();
    // Teto em bytes, não em caracteres.
    expect(fluxo.seal("é".repeat(SEAL_PURPOSES.fluxo.maxPlaintextBytes / 2 + 1))).toBeNull();
    const sessao = createSealer(keyring, SEAL_PURPOSES.sessao, ORIGIN);
    const grande = sessao.seal("x".repeat(SEAL_PURPOSES.fluxo.maxPlaintextBytes + 1)) as string;
    expect(fluxo.open(grande.replace(/^s1/, "f1"))).toBeNull();
  });

  it("o rascunho dos critérios não abre como sessão nem como fluxo, e vice-versa (ADR-028 D8)", () => {
    const { keyring } = ring();
    const rascunho = createSealer(keyring, SEAL_PURPOSES.rascunho, ORIGIN);
    const sessao = createSealer(keyring, SEAL_PURPOSES.sessao, ORIGIN);
    const envelope = rascunho.seal("{}") as string;
    expect(rascunho.open(envelope)).toBe("{}");
    expect(sessao.open(envelope)).toBeNull();
    expect(sessao.open(envelope.replace(/^r1/, "s1"))).toBeNull();
    expect(rascunho.open((sessao.seal("{}") as string).replace(/^s1/, "r1"))).toBeNull();
    expect(createSealer(keyring, SEAL_PURPOSES.rascunho, "https://outro.exemplo.invalid").open(envelope)).toBeNull();
  });

  it("o AAD do rascunho é exatamente o do ADR-028 D8 (trampo:portal.rascunho:r1:<origem>)", () => {
    const { a, keyring } = ring();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(a, "base64url"), iv);
    cipher.setAAD(Buffer.from(`trampo:portal.rascunho:r1:${ORIGIN}`, "utf8"));
    const body = Buffer.concat([cipher.update(Buffer.from("{}", "utf8")), cipher.final()]);
    const envelope = ["r1", "a1", iv.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
    expect(createSealer(keyring, SEAL_PURPOSES.rascunho, ORIGIN).open(envelope)).toBe("{}");
  });

  it("o rascunho no teto cabe num cookie, com o kid mais longo", () => {
    const keyring = parseSealKeyring(`${"k".repeat(16)}:${material()}`, "k".repeat(16));
    const sealer = createSealer(keyring, SEAL_PURPOSES.rascunho, ORIGIN);
    expect(SEAL_PURPOSES.rascunho.maxPlaintextBytes).toBe(2_950);
    const envelope = sealer.seal("x".repeat(SEAL_PURPOSES.rascunho.maxPlaintextBytes)) as string;
    expect(`__Host-trampo-rascunho=${envelope}`.length).toBeLessThanOrEqual(4_096);
    expect(sealer.seal("x".repeat(SEAL_PURPOSES.rascunho.maxPlaintextBytes + 1))).toBeNull();
  });

  it("o envelope da sessão no teto cabe num cookie, com o kid mais longo (ADR-027 D3)", () => {
    const keyring = parseSealKeyring(`${"k".repeat(16)}:${material()}`, "k".repeat(16));
    const envelope = createSealer(keyring, SEAL_PURPOSES.sessao, ORIGIN).seal("x".repeat(SEAL_PURPOSES.sessao.maxPlaintextBytes)) as string;
    expect(`__Host-trampo-sessao=${envelope}`.length).toBeLessThanOrEqual(4_096);
  });

  it("o pior caso da sessão (access no teto, refresh de 512) cabe no selo", () => {
    const worst = JSON.stringify({ at: `${"a".repeat(1_000)}.${"b".repeat(1_000)}.${"c".repeat(298)}`, rt: "r".repeat(512), sid: "00000000-0000-4000-8000-000000000000", sst: 9_999_999_999, iat: 9_999_999_999, ate: 9_999_999_999 });
    expect(Buffer.byteLength(worst)).toBeLessThanOrEqual(SEAL_PURPOSES.sessao.maxPlaintextBytes);
  });

  it("texto que não é UTF-8 válido não abre", () => {
    const { a, keyring } = ring();
    // O selo só aceita string: o envelope com bytes crus é montado aqui, com a mesma chave e o mesmo AAD.
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(a, "base64url"), iv);
    cipher.setAAD(Buffer.from(`trampo:portal.sessao:s1:${ORIGIN}`, "utf8"));
    const body = Buffer.concat([cipher.update(Uint8Array.from([0xc3, 0x28])), cipher.final()]);
    const envelope = ["s1", "a1", iv.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
    expect(createSealer(keyring, SEAL_PURPOSES.sessao, ORIGIN).open(envelope)).toBeNull();
  });
});
