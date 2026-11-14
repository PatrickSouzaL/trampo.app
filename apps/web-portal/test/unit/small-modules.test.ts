import { describe, expect, it } from "vitest";

import { COOKIE_NAMES, cookieClear, cookieWrite, hasCookie, readCookie, replaceCookie, serializeCookie } from "../../src/server/cookies";
import { SECURITY_HEADERS, buildCsp } from "../../src/server/headers";
import { CRITERIA_FIELDS } from "../../src/server/criteria-form";
import { CRITERIA_FIELD_ERRORS, CRITERIA_NOTICES, CRITERIA_PAGE_TEXTS, DRAFT_NOTICES, NOTICES, parseCriteriaNotice, parseNotice } from "../../src/server/notices";

describe("cookies (ADR-027 D3)", () => {
  it("nomes com o prefixo __Host-", () => {
    expect(COOKIE_NAMES).toEqual({ sessao: "__Host-trampo-sessao", fluxo: "__Host-trampo-fluxo", rascunho: "__Host-trampo-rascunho" });
  });

  it("Set-Cookie com os atributos exatos, na ordem", () => {
    expect(serializeCookie(cookieWrite(COOKIE_NAMES.fluxo, "f1.a.b.c.d", 300))).toBe("__Host-trampo-fluxo=f1.a.b.c.d; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Lax");
    expect(serializeCookie(cookieClear(COOKIE_NAMES.sessao))).toBe("__Host-trampo-sessao=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  });

  it("Max-Age inteiro e nunca negativo", () => {
    expect(cookieWrite(COOKIE_NAMES.sessao, "v", 12.9).maxAge).toBe(12);
    expect(cookieWrite(COOKIE_NAMES.sessao, "v", -5).maxAge).toBe(0);
  });

  it("lê um cookie do cabeçalho Cookie, só pelo nome exato", () => {
    const header = "a=1; __Host-trampo-sessao=s1.x; __Host-trampo-sessao-x=2";
    expect(readCookie(header, COOKIE_NAMES.sessao)).toBe("s1.x");
    expect(readCookie(header, COOKIE_NAMES.fluxo)).toBeUndefined();
    expect(readCookie(null, COOKIE_NAMES.fluxo)).toBeUndefined();
    expect(readCookie("__Host-trampo-fluxo", COOKIE_NAMES.fluxo)).toBeUndefined();
  });

  it("hasCookie acha o nome uma ou mais vezes, com qualquer valor (para apagar)", () => {
    expect(hasCookie(`a=1; ${COOKIE_NAMES.rascunho}=r1.x`, COOKIE_NAMES.rascunho)).toBe(true);
    expect(hasCookie(`${COOKIE_NAMES.rascunho}=a; ${COOKIE_NAMES.rascunho}=b`, COOKIE_NAMES.rascunho)).toBe(true);
    expect(hasCookie(`${COOKIE_NAMES.rascunho}`, COOKIE_NAMES.rascunho)).toBe(true);
    expect(hasCookie(`${COOKIE_NAMES.rascunho}-x=1`, COOKIE_NAMES.rascunho)).toBe(false);
    expect(hasCookie(null, COOKIE_NAMES.rascunho)).toBe(false);
  });

  it("o cookie repetido no cabeçalho não vale (plantado por outra origem)", () => {
    expect(readCookie("__Host-trampo-sessao=a; __Host-trampo-sessao=b", COOKIE_NAMES.sessao)).toBeUndefined();
  });

  it("troca ou tira o cookie do pedido sem mexer nos outros", () => {
    expect(replaceCookie("a=1; __Host-trampo-sessao=velho", cookieWrite(COOKIE_NAMES.sessao, "novo", 10))).toBe("a=1; __Host-trampo-sessao=novo");
    expect(replaceCookie("a=1; __Host-trampo-sessao=velho", cookieClear(COOKIE_NAMES.sessao))).toBe("a=1");
    expect(replaceCookie(null, cookieWrite(COOKIE_NAMES.sessao, "novo", 10))).toBe("__Host-trampo-sessao=novo");
    expect(replaceCookie(null, cookieClear(COOKIE_NAMES.sessao))).toBe("");
  });
});

describe("CSP e cabeçalhos (ADR-027 D8)", () => {
  it("CSP com nonce, strict-dynamic e frame-ancestors 'none'", () => {
    expect(buildCsp({ nonce: "N", https: true, dev: false })).toBe(
      "default-src 'self'; script-src 'self' 'nonce-N' 'strict-dynamic'; style-src 'self' 'nonce-N'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
    );
  });

  it("upgrade-insecure-requests só em https; unsafe-eval só em desenvolvimento", () => {
    const local = buildCsp({ nonce: "N", https: false, dev: false });
    expect(local).not.toContain("upgrade-insecure-requests");
    expect(local).not.toContain("unsafe-eval");
    expect(buildCsp({ nonce: "N", https: false, dev: true })).toContain("script-src 'self' 'nonce-N' 'strict-dynamic' 'unsafe-eval';");
  });

  it("os demais cabeçalhos, uma vez cada", () => {
    expect(SECURITY_HEADERS).toEqual([
      { key: "X-Frame-Options", value: "DENY" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      // `same-origin`: nenhum Referer para outra origem, e o POST do "Sair" leva o `Origin` exato (ADR-027 §7).
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
      { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    ]);
  });
});

describe("avisos (ADR-027 D7)", () => {
  it("catálogo fechado; valor fora dele é ignorado", () => {
    expect(Object.keys(NOTICES).sort()).toEqual(["entrada_recusada", "login_falhou", "saiu", "saiu_local", "servico_indisponivel", "sessao_expirada"]);
    expect(parseNotice("saiu")).toBe("saiu");
    expect(parseNotice("<script>")).toBeNull();
    expect(parseNotice("toString")).toBeNull();
    expect(parseNotice(undefined)).toBeNull();
    expect(parseNotice(["saiu"])).toBeNull();
  });

  it("nenhum texto com link ou marcação", () => {
    for (const text of Object.values(NOTICES)) expect(text).not.toMatch(/[<>]|https?:/);
  });
});

describe("avisos dos critérios (ADR-028 D5 e D7)", () => {
  it("catálogo fechado próprio; valor fora dele é ignorado", () => {
    expect(Object.keys(CRITERIA_NOTICES).sort()).toEqual([
      "criterios_indisponiveis",
      "criterios_invalidos",
      "criterios_nao_confirmados",
      "criterios_recusados",
      "criterios_salvos",
      "formulario_recusado",
    ]);
    expect([...DRAFT_NOTICES].sort()).toEqual(["criterios_indisponiveis", "criterios_invalidos", "criterios_nao_confirmados", "criterios_recusados"]);
    expect(parseCriteriaNotice("criterios_salvos")).toBe("criterios_salvos");
    for (const value of ["saiu", "toString", "<script>", undefined, ["criterios_salvos"]]) expect(parseCriteriaNotice(value)).toBeNull();
  });

  it("um texto de erro por campo do contrato, e nenhum texto com link ou marcação", () => {
    expect(Object.keys(CRITERIA_FIELD_ERRORS)).toEqual([...CRITERIA_FIELDS]);
    for (const text of [...Object.values(CRITERIA_NOTICES), ...Object.values(CRITERIA_FIELD_ERRORS), ...Object.values(CRITERIA_PAGE_TEXTS)]) {
      expect(text).not.toMatch(/[<>]|https?:/);
      expect(text.length).toBeGreaterThan(5);
    }
  });
});

describe("estado da página (ADR-027 D6 e D7)", () => {
  it("o aviso explícito vem primeiro; sem ele, o estado do proxy", async () => {
    const { homeFor, noticeFor } = await import("../../src/server/page-state");
    expect(noticeFor("saiu", "expirada")).toBe("saiu");
    expect(noticeFor("lixo", "expirada")).toBe("sessao_expirada");
    expect(noticeFor(undefined, "indisponivel")).toBe("servico_indisponivel");
    expect(noticeFor(undefined, "ativa")).toBeNull();
    expect(noticeFor(undefined, null)).toBeNull();
    expect(homeFor("expirada")).toBe("/?aviso=sessao_expirada");
    expect(homeFor("ausente")).toBe("/");
  });
});
