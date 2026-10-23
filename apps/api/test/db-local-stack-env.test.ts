// Guarda do test:db (ADR-019 D8): o teste de RLS só fala com a pilha local do runner. Roda no `pnpm test`, sem
// Docker. Prova a forma exata que o `supabase status -o env` imprime e cada recusa: outro host (inclusive os que
// enganam um parser de URL ou o libpq), outro protocolo, chave que não é publishable e credencial do projeto real.
import { describe, expect, test } from "vitest";

import {
  LocalStackEnvError,
  REMOTE_CREDENTIAL_VARIABLES,
  parseLocalStackEnv,
  type LocalStackEnvReason,
} from "./db/support/local-stack-env.js";

// Chaves montadas em tempo de execução (ADR-019 D6): nenhuma fixture nova com cara de segredo no git.
const PUBLISHABLE = `sb_publishable_${"Ab1-_".repeat(6)}`;
const SECRET = `sb_secret_${"Ab1-_".repeat(6)}`;
const LEGACY_JWT = ["eyJhbGciOiJIUzI1NiJ9", "e30", "c2ln"].join(".");

const LOCAL = Object.freeze({
  API_URL: "http://127.0.0.1:54321",
  DB_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  PUBLISHABLE_KEY: PUBLISHABLE,
});

function refusal(env: Readonly<Record<string, string | undefined>>): LocalStackEnvReason | "aceito" {
  try {
    parseLocalStackEnv(env);
    return "aceito";
  } catch (error) {
    expect(error).toBeInstanceOf(LocalStackEnvError);
    return (error as LocalStackEnvError).reason;
  }
}

describe("pilha local", () => {
  test("aceita a saída do supabase status e devolve a configuração congelada", () => {
    const stack = parseLocalStackEnv(LOCAL);
    expect(stack.apiUrl.href).toBe("http://127.0.0.1:54321/");
    expect(stack.dbUrl).toBe(LOCAL.DB_URL);
    expect(stack.publishableKey).toBe(LOCAL.PUBLISHABLE_KEY);
    expect(Object.isFrozen(stack)).toBe(true);
  });

  test("aceita o esquema postgres:// e ignora as outras variáveis do status", () => {
    const env = { ...LOCAL, DB_URL: "postgres://postgres:postgres@127.0.0.1:54322/postgres", ANON_KEY: LEGACY_JWT, SECRET_KEY: SECRET };
    expect(refusal(env)).toBe("aceito");
  });
});

describe("API_URL só em 127.0.0.1, http e sem caminho", () => {
  test.each([
    ["ausente", undefined],
    ["vazia", ""],
    ["projeto real", "https://abcdefghijklmnop.supabase.co"],
    ["localhost (fora da lista)", "http://localhost:54321"],
    ["https", "https://127.0.0.1:54321"],
    ["sem porta", "http://127.0.0.1"],
    ["127.1 abreviado", "http://127.1:54321"],
    ["outro loopback", "http://127.0.0.2:54321"],
    ["ponto trocado por outro caractere", "http://127x0x0x1:54321"],
    ["IPv6", "http://[::1]:54321"],
    ["subdomínio que começa com 127.0.0.1", "http://127.0.0.1.nip.io:54321"],
    ["credencial antes do host", "http://evil.example@127.0.0.1:54321"],
    ["host depois do @", "http://127.0.0.1:54321@evil.example"],
    ["com caminho", "http://127.0.0.1:54321/rest/v1"],
    ["com barra final", "http://127.0.0.1:54321/"],
    ["com query", "http://127.0.0.1:54321?x=1"],
    ["porta com 6 dígitos", "http://127.0.0.1:543210"],
    ["espaço antes", " http://127.0.0.1:54321"],
    ["quebra de linha depois", "http://127.0.0.1:54321\n"],
  ])("recusa %s", (_label, value) => {
    expect(refusal({ ...LOCAL, API_URL: value })).toBe("api_url");
  });
});

describe("DB_URL só em 127.0.0.1, na forma exata do CLI", () => {
  test.each([
    ["ausente", undefined],
    ["projeto real (pooler)", "postgresql://postgres.abcdefghijklmnop:x@aws-0-us-east-1.pooler.supabase.com:6543/postgres"],
    ["localhost (fora da lista)", "postgresql://postgres:postgres@localhost:54322/postgres"],
    ["outro protocolo", "mysql://postgres:postgres@127.0.0.1:54322/postgres"],
    ["multi-host do libpq", "postgresql://postgres:postgres@127.0.0.1:54322,evil.example:5432/postgres"],
    ["host no parâmetro (libpq)", "postgresql://postgres:postgres@127.0.0.1:54322/postgres?host=evil.example"],
    ["hostaddr no parâmetro (libpq)", "postgresql://postgres:postgres@127.0.0.1:54322/postgres?hostaddr=10.0.0.1"],
    ["socket no host", "postgresql://postgres:postgres@%2Ftmp:54322/postgres"],
    ["sem senha", "postgresql://postgres@127.0.0.1:54322/postgres"],
    ["sem porta", "postgresql://postgres:postgres@127.0.0.1/postgres"],
    ["sem banco", "postgresql://postgres:postgres@127.0.0.1:54322"],
    ["outro loopback", "postgresql://postgres:postgres@127.0.0.2:54322/postgres"],
    ["subdomínio que começa com 127.0.0.1", "postgresql://postgres:postgres@127.0.0.1.nip.io:54322/postgres"],
    ["string de conexão chave=valor", "host=127.0.0.1 port=54322 dbname=postgres"],
    ["texto antes", "host=evil.example postgresql://postgres:postgres@127.0.0.1:54322/postgres"],
    ["quebra de linha depois", "postgresql://postgres:postgres@127.0.0.1:54322/postgres\n"],
  ])("recusa %s", (_label, value) => {
    expect(refusal({ ...LOCAL, DB_URL: value })).toBe("db_url");
  });
});

describe("só a chave publishable", () => {
  test.each([
    ["ausente", undefined],
    ["secret", SECRET],
    ["legada (JWT)", LEGACY_JWT],
    ["prefixo sem corpo", "sb_publishable_"],
    ["texto antes", `x${PUBLISHABLE}`],
    ["caractere fora da lista", "sb_publishable_abc.def"],
    ["quebra de linha depois", "sb_publishable_abc\n"],
    ["acima de 256 caracteres no corpo", `sb_publishable_${"a".repeat(257)}`],
  ])("recusa %s", (_label, value) => {
    expect(refusal({ ...LOCAL, PUBLISHABLE_KEY: value })).toBe("publishable_key");
  });

  test("aceita o corpo de exatamente 256 caracteres", () => {
    expect(refusal({ ...LOCAL, PUBLISHABLE_KEY: `sb_publishable_${"a".repeat(256)}` })).toBe("aceito");
  });
});

describe("nenhuma credencial do projeto real no ambiente", () => {
  test("a lista cobre o token da CLI, a senha do banco e a referência do projeto", () => {
    expect(REMOTE_CREDENTIAL_VARIABLES).toEqual([
      "SUPABASE_ACCESS_TOKEN",
      "SUPABASE_DB_PASSWORD",
      "SUPABASE_PROJECT_ID",
      "SUPABASE_PROJECT_REF",
    ]);
    expect(Object.isFrozen(REMOTE_CREDENTIAL_VARIABLES)).toBe(true);
  });

  test.each(REMOTE_CREDENTIAL_VARIABLES.map((name) => [name]))("recusa com %s presente, mesmo vazia", (name) => {
    expect(refusal({ ...LOCAL, [name]: "" })).toBe("credencial_remota");
  });

  test("a credencial é conferida antes das URLs", () => {
    expect(refusal({ SUPABASE_ACCESS_TOKEN: "token-de-teste" })).toBe("credencial_remota");
  });
});

describe("ordem e mensagem", () => {
  test("API_URL é conferida antes de DB_URL, e DB_URL antes da chave", () => {
    expect(refusal({})).toBe("api_url");
    expect(refusal({ API_URL: LOCAL.API_URL })).toBe("db_url");
    expect(refusal({ API_URL: LOCAL.API_URL, DB_URL: LOCAL.DB_URL })).toBe("publishable_key");
  });

  test("a mensagem é fixa e nunca repete o valor recebido", () => {
    const leaked = "https://segredo-do-projeto.supabase.co";
    try {
      parseLocalStackEnv({ ...LOCAL, API_URL: leaked });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LocalStackEnvError);
      const { message, name } = error as LocalStackEnvError;
      expect(name).toBe("LocalStackEnvError");
      expect(message).toBe(
        "test:db recusado (api_url): só a pilha local do Supabase em 127.0.0.1, com as chaves do supabase status",
      );
      expect(message).not.toContain("segredo");
    }
  });
});
