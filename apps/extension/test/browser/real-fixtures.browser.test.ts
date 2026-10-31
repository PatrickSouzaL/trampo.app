// S-2 real, parte 1 (Trilha D2a): as 21 páginas reais anonimizadas (runbook fixtures-dom §3) carregam
// na bancada, com o CSS local servido e a rede bloqueada, e o extrator genérico `ge1` roda nelas sem
// erro. É só a medição inicial: os trechos obrigatórios e proibidos viram gate nos extratores da D2b.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { Bench, FIXTURES_DIR } from "./bench";

interface FixtureMeta {
  plataforma: "linkedin" | "gupy" | "geekhunter";
  coletadoEm: string;
  modoDeSalvamento: "completa" | "somente-html";
  cssDaPlataforma: boolean;
  raizEsperada: string;
  raizDaPlataforma: string;
  trechosObrigatorios: string[];
  trechosProibidos: string[];
  anonimizacao: Record<string, number>;
}

const FIXTURES = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({
    id: f.slice(0, -".json".length),
    meta: JSON.parse(readFileSync(join(FIXTURES_DIR, f), "utf8")) as FixtureMeta,
  }));

const bench = new Bench();
const rows: string[] = [];
beforeAll(() => bench.open());
afterAll(async () => {
  await bench.close();
  // Medição para o spike-metrics §3.3 (uma linha por fixture).
  console.info(["id | raiz | nós | ms | chars | obrigatórios | proibidos | descartes", ...rows].join("\n"));
});

test("inventário: 7 páginas por plataforma, todas no modo completo", () => {
  const count = (p: string): number => FIXTURES.filter((f) => f.meta.plataforma === p).length;
  expect([count("linkedin"), count("gupy"), count("geekhunter")]).toEqual([7, 7, 7]);
  for (const { meta } of FIXTURES) expect(meta.modoDeSalvamento).toBe("completa");
});

describe("extrator genérico nas fixtures reais", () => {
  for (const { id, meta } of FIXTURES) {
    test(`${id}: carrega e extrai sem erro`, async () => {
      const { result, ms, nodes } = await bench.runFixture(id);
      if (!result.ok) throw new Error(`esperava ok, veio ${result.motivo}`);
      expect(result.versao).toBe("ge1");
      expect(result.raiz).toBe(meta.raizEsperada);
      // Minimização: o marcador de pessoa nunca chega ao texto (bloco de pessoas fora).
      if (meta.trechosProibidos.includes("[PESSOA]")) expect(result.texto).not.toContain("[PESSOA]");
      const has = (s: string): boolean => result.texto.includes(s);
      const discards = Object.entries(result.descartes)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}=${n}`)
        .join(" ");
      rows.push(
        `${id} | ${result.raiz} | ${nodes} | ${ms.toFixed(1)} | ${result.texto.length} | ` +
          `${meta.trechosObrigatorios.filter(has).length}/${meta.trechosObrigatorios.length} | ` +
          `${meta.trechosProibidos.filter(has).length}/${meta.trechosProibidos.length} | ${discards}`,
      );
    });
  }
});
