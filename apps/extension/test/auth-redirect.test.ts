// F1-EXT-05a (ADR-004 D3 passos 5 e 7 e §4.1; SR-18): URL do authorize e leitura do retorno em falha
// fechada. O retorno é dado hostil: só a forma exata `<redirectUri>?code=…&st=…` vira troca.
import { describe, expect, test } from "vitest";

import { AUTH_REDIRECT_PATH, STATE_PARAM, buildAuthorizeUrl } from "../src/auth/authorize-url";
import { parseAuthRedirect } from "../src/auth/redirect";

const HOST = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org";
const REDIRECT = `${HOST}/${AUTH_REDIRECT_PATH}`;
const STATE = "q1w2e3r4t5y6u7i8o9p0Aa";
const CODE = "6b7f2c1e-4a3d-4e5f-9a8b-0c1d2e3f4a5b";
const ok = { ok: true, code: CODE } as const;
const recusado = { ok: false, motivo: "recusado" } as const;
const cancelado = { ok: false, motivo: "cancelado" } as const;

const parse = (url: string) => parseAuthRedirect(url, REDIRECT, STATE);

describe("buildAuthorizeUrl", () => {
  const input = {
    supabaseOrigin: "https://projeto.supabase.co",
    provider: "github",
    redirectUri: REDIRECT,
    state: STATE,
    challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  } as const;

  test("parâmetros exatos, nesta ordem e codificados; método s256 e nenhum response_type", () => {
    const url = buildAuthorizeUrl(input);
    expect(url).toBe(
      "https://projeto.supabase.co/auth/v1/authorize?provider=github" +
        `&redirect_to=${encodeURIComponent(`${REDIRECT}?st=${STATE}`)}` +
        "&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=s256",
    );
    const parsed = new URL(url);
    expect([...parsed.searchParams.keys()]).toEqual(["provider", "redirect_to", "code_challenge", "code_challenge_method"]);
    expect(parsed.searchParams.get("redirect_to")).toBe(`${REDIRECT}?${STATE_PARAM}=${STATE}`);
    expect(url).not.toMatch(/response_type|plain|code_verifier|verifier/);
  });

  test("o redirect_to vai codificado: o `?` e o `&` dele não viram parâmetros do authorize", () => {
    const url = buildAuthorizeUrl({ ...input, provider: "google" });
    expect(url).toContain("provider=google&");
    expect(url).toContain("redirect_to=https%3A%2F%2Fabcdefghijklmnopabcdefghijklmnop.chromiumapp.org%2Fauth%3Fst%3D");
  });

  test.each([
    ["http", "http://projeto.supabase.co"],
    ["barra final", "https://projeto.supabase.co/"],
    ["caminho", "https://projeto.supabase.co/x"],
    ["query", "https://projeto.supabase.co?x=1"],
    ["userinfo", "https://u@projeto.supabase.co"],
    ["caixa alta", "https://Projeto.supabase.co"],
    ["vazia", ""],
    ["não é URL", "projeto.supabase.co"],
  ])("origem do Supabase fora da forma (%s) lança", (_nome, supabaseOrigin) => {
    expect(() => buildAuthorizeUrl({ ...input, supabaseOrigin })).toThrow(/TRAMPO_SUPABASE_ORIGIN/);
  });

  test("aceita origem com porta explícita", () => {
    expect(buildAuthorizeUrl({ ...input, supabaseOrigin: "https://127.0.0.1:54321" })).toMatch(/^https:\/\/127\.0\.0\.1:54321\/auth\/v1\/authorize\?/);
  });
});

describe("parseAuthRedirect: a forma exata", () => {
  test("code e st, em qualquer ordem", () => {
    expect(parse(`${REDIRECT}?code=${CODE}&st=${STATE}`)).toEqual(ok);
    expect(parse(`${REDIRECT}?st=${STATE}&code=${CODE}`)).toEqual(ok);
  });

  test("fragmento vazio não muda nada", () => {
    expect(parse(`${REDIRECT}?code=${CODE}&st=${STATE}#`)).toEqual(ok);
  });

  test("código no limite do contrato (8 e 128) passa; fora dele, recusado", () => {
    expect(parse(`${REDIRECT}?code=abcdefgh&st=${STATE}`)).toEqual({ ok: true, code: "abcdefgh" });
    expect(parse(`${REDIRECT}?code=${"a".repeat(128)}&st=${STATE}`)).toEqual({ ok: true, code: "a".repeat(128) });
    expect(parse(`${REDIRECT}?code=abcdefg&st=${STATE}`)).toEqual(recusado);
    expect(parse(`${REDIRECT}?code=${"a".repeat(129)}&st=${STATE}`)).toEqual(recusado);
  });
});

describe("parseAuthRedirect: host e caminho, byte a byte", () => {
  test.each([
    ["raiz do host (Site URL da opção A, emenda do HITL-035)", `${HOST}/?code=${CODE}&st=${STATE}`],
    ["raiz sem barra", `${HOST}?code=${CODE}&st=${STATE}`],
    ["barra final", `${REDIRECT}/?code=${CODE}&st=${STATE}`],
    ["caminho mais longo", `${REDIRECT}x?code=${CODE}&st=${STATE}`],
    ["subcaminho", `${REDIRECT}/x?code=${CODE}&st=${STATE}`],
    ["caminho com ..", `${HOST}/x/../auth?code=${CODE}&st=${STATE}`],
    ["caminho codificado", `${HOST}/%61uth?code=${CODE}&st=${STATE}`],
    ["caixa alta no caminho", `${HOST}/Auth?code=${CODE}&st=${STATE}`],
    ["caixa alta no host", `${REDIRECT.replace("abcdefgh", "ABCDEFGH")}?code=${CODE}&st=${STATE}`],
    ["outro ID de chromiumapp", `https://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.chromiumapp.org/auth?code=${CODE}&st=${STATE}`],
    ["outro host", `https://evil.example/auth?code=${CODE}&st=${STATE}`],
    ["host como sufixo", `${HOST}.evil.example/auth?code=${CODE}&st=${STATE}`],
    ["userinfo", `https://u@${HOST.slice(8)}/auth?code=${CODE}&st=${STATE}`],
    ["porta explícita", `${HOST}:443/auth?code=${CODE}&st=${STATE}`],
    ["http", `${REDIRECT.replace("https:", "http:")}?code=${CODE}&st=${STATE}`],
    ["prefixo do redirect noutra URL", `https://evil.example/?u=${REDIRECT}?code=${CODE}&st=${STATE}`],
    ["vazio", ""],
  ])("recusa %s", (_nome, url) => {
    expect(parse(url)).toEqual(recusado);
  });

  test("um redirectUri que não é URL recusa tudo, inclusive a própria string", () => {
    expect(parseAuthRedirect("auth?code=x&st=y", "auth", "y")).toEqual(recusado);
  });
});

describe("parseAuthRedirect: fragmento e downgrade para implicit", () => {
  test.each([
    ["access_token no fragmento", `${REDIRECT}?code=${CODE}&st=${STATE}#access_token=eyJ.x.y`],
    ["fragmento só com token, sem query", `${REDIRECT}#access_token=eyJ.x.y&refresh_token=r&token_type=bearer`],
    ["code no fragmento", `${REDIRECT}?st=${STATE}#code=${CODE}`],
    ["chave vazia no fragmento", `${REDIRECT}?code=${CODE}&st=${STATE}#=x`],
    ["erro com token junto", `${REDIRECT}#error=access_denied&access_token=eyJ.x.y`],
  ])("recusa %s", (_nome, url) => {
    expect(parse(url)).toEqual(recusado);
  });

  test("error_description sozinho no fragmento não é erro nem atalho: a query ainda decide", () => {
    expect(parse(`${REDIRECT}?code=${CODE}&st=${STATE}#error_description=x`)).toEqual(ok);
    expect(parse(`${REDIRECT}#error_description=x`)).toEqual(recusado);
  });
});

describe("parseAuthRedirect: erro do IdP é cancelamento, sem ecoar o texto", () => {
  test.each([
    ["error na query", `${REDIRECT}?error=access_denied&error_description=%3Cscript%3E`],
    ["error_code na query", `${REDIRECT}?error_code=bad_oauth_state&st=${STATE}`],
    ["error no fragmento", `${REDIRECT}#error=access_denied&error_code=401&error_description=texto+do+atacante`],
    ["error_code no fragmento, com código na query", `${REDIRECT}?code=${CODE}&st=${STATE}#error_code=x`],
  ])("%s", (_nome, url) => {
    const result = parse(url);
    expect(result).toEqual(cancelado);
    expect(JSON.stringify(result)).not.toMatch(/access_denied|script|atacante|bad_oauth/);
  });
});

describe("parseAuthRedirect: query só com code e st, cada um uma vez", () => {
  test.each([
    ["sem code", `${REDIRECT}?st=${STATE}`],
    ["sem st", `${REDIRECT}?code=${CODE}`],
    ["sem query", REDIRECT],
    ["parâmetro extra", `${REDIRECT}?code=${CODE}&st=${STATE}&x=1`],
    ["code repetido", `${REDIRECT}?code=${CODE}&code=${CODE}&st=${STATE}`],
    ["st repetido", `${REDIRECT}?code=${CODE}&st=${STATE}&st=${STATE}`],
    ["code repetido no lugar do st", `${REDIRECT}?code=${CODE}&code=${CODE}`],
    ["st divergente", `${REDIRECT}?code=${CODE}&st=outro`],
    ["st vazio", `${REDIRECT}?code=${CODE}&st=`],
    ["st com prefixo do state", `${REDIRECT}?code=${CODE}&st=${STATE.slice(0, 21)}`],
    ["st com o state e mais", `${REDIRECT}?code=${CODE}&st=${STATE}x`],
    ["code fora do formato", `${REDIRECT}?code=abc_def_ghi&st=${STATE}`],
    ["code com espaço (+)", `${REDIRECT}?code=abcd+efgh&st=${STATE}`],
    ["code vazio", `${REDIRECT}?code=&st=${STATE}`],
  ])("recusa %s", (_nome, url) => {
    expect(parse(url)).toEqual(recusado);
  });

  test("o state do fluxo é exigido mesmo quando o código é válido", () => {
    expect(parseAuthRedirect(`${REDIRECT}?code=${CODE}&st=${STATE}`, REDIRECT, "outro-state-do-fluxo-x")).toEqual(recusado);
  });
});
