// S-2 real (Trilhas D2a, D2b e D2c): as 28 páginas reais anonimizadas (runbook fixtures-dom §3)
// carregam na bancada, com o CSS local servido e a rede bloqueada.
// - Gate do extrator da plataforma (ADR-023 D11 e D12): o LinkedIn (logado e público), a Gupy e a
//   Solides acham a raiz deles, e a GeekHunter usa o genérico. Os trechos obrigatórios aparecem, os
//   proibidos não, e cada proibido existe na página fora da raiz (o gate não é vazio). Com o "ver
//   mais" fechado, os trechos recolhidos existem na página e ficam de fora (D4, `cortado`).
// - Descarte, só onde a página trouxe o CSS da plataforma (`cssDaPlataforma`): nenhuma linha do texto
//   fica fora do `innerText` da raiz, que o navegador monta só com o que renderiza.
// - O genérico medido nas quatro plataformas, para o spike-metrics §3.3 a §3.5.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { ExtractionResult, ExtractorPlatform } from "../../src/extraction/job-extractor";

import { Bench, FIXTURES_DIR, LIMITS } from "./bench";

interface FixtureMeta {
  plataforma: "linkedin" | "gupy" | "geekhunter" | "solides";
  coletadoEm: string;
  modoDeSalvamento: "completa" | "somente-html";
  cssDaPlataforma: boolean;
  /** Só no LinkedIn da D2c; sem o campo, a página é a pública. */
  sessao?: "publica" | "logada";
  verMais?: "aberto" | "fechado";
  raizEsperada: string;
  raizDaPlataforma: string;
  trechosObrigatorios: string[];
  trechosProibidos: string[];
  /** Com o "ver mais" fechado: texto da vaga escondido pelo clamp, que fica de fora. */
  trechosRecolhidos?: string[];
  anonimizacao: Record<string, number>;
}

const FIXTURES = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => ({
    id: f.slice(0, -".json".length),
    meta: JSON.parse(readFileSync(join(FIXTURES_DIR, f), "utf8")) as FixtureMeta,
  }));

/** O extrator que o Service Worker escolhe pelo host de cada plataforma (platformForUrl). */
function extractorFor(meta: FixtureMeta): { platform: ExtractorPlatform; versao: string; raiz: string } {
  switch (meta.plataforma) {
    case "linkedin":
      return { platform: "linkedin", versao: meta.sessao === "logada" ? "li2" : "li1", raiz: "plataforma" };
    case "gupy":
      return { platform: "gupy", versao: "gu1", raiz: "plataforma" };
    case "solides":
      return { platform: "solides", versao: "so1", raiz: "plataforma" };
    case "geekhunter":
      return { platform: "generico", versao: "ge1", raiz: "main" };
  }
}

const bench = new Bench();
const rows: string[] = [];
const genericRows: string[] = [];
beforeAll(() => bench.open());
afterAll(async () => {
  await bench.close();
  // Medição para o spike-metrics §3.3 (uma linha por fixture).
  console.info(["extrator da plataforma", "id | versão | raiz | elementos | nós | ms | chars | obrigatórios | proibidos | descartes", ...rows].join("\n"));
  console.info(["genérico (ge1)", "id | raiz | ms | chars | obrigatórios | proibidos", ...genericRows].join("\n"));
});

function ok(r: ExtractionResult): Extract<ExtractionResult, { ok: true }> {
  if (!r.ok) throw new Error(`esperava ok, veio ${r.motivo}`);
  return r;
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();
const discardsOf = (r: Extract<ExtractionResult, { ok: true }>): string =>
  Object.entries(r.descartes)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");

test("inventário: LinkedIn 7 públicas e 3 logadas, Gupy e GeekHunter 7, Solides 4, todas no modo completo", () => {
  const count = (p: string, sessao?: string): number =>
    FIXTURES.filter((f) => f.meta.plataforma === p && (sessao === undefined || (f.meta.sessao ?? "publica") === sessao)).length;
  expect([count("linkedin", "publica"), count("linkedin", "logada"), count("gupy"), count("geekhunter"), count("solides")]).toEqual([7, 3, 7, 7, 4]);
  for (const { meta } of FIXTURES) expect(meta.modoDeSalvamento).toBe("completa");
  // O "ver mais" fechado foi medido em pelo menos uma página logada, e só ela tem trechos recolhidos.
  for (const { meta } of FIXTURES) expect(meta.trechosRecolhidos !== undefined).toBe(meta.verMais === "fechado");
  expect(FIXTURES.some((f) => f.meta.verMais === "fechado")).toBe(true);
});

describe("extrator da plataforma nas fixtures reais (gate)", () => {
  for (const { id, meta } of FIXTURES) {
    const expected = extractorFor(meta);
    test(`${id}: ${expected.versao} acha a vaga, com os obrigatórios e sem os proibidos`, async () => {
      const { result, ms, nodes, allNodes } = await bench.runFixture(id, expected.platform);
      const r = ok(result);
      expect([r.versao, r.raiz, r.truncado]).toEqual([expected.versao, expected.raiz, false]);
      for (const s of meta.trechosObrigatorios) expect(r.texto, `obrigatório ausente: ${s}`).toContain(s);
      for (const s of meta.trechosProibidos) {
        expect(r.texto, `proibido presente: ${s}`).not.toContain(s);
        // O proibido existe na página (o cartão da lista, o banner, o menu): o gate não é vazio.
        if (s !== "[PESSOA]") expect(await bench.pageHas(s), `proibido inexistente na página: ${s}`).toBe(true);
      }
      // "Ver mais" fechado: o texto que o clamp esconde existe na página e fica de fora (D4, cortado).
      for (const s of meta.trechosRecolhidos ?? []) {
        expect(r.texto, `recolhido presente: ${s}`).not.toContain(s);
        expect(await bench.pageHas(s), `recolhido inexistente na página: ${s}`).toBe(true);
      }
      if (meta.verMais === "fechado") expect(r.descartes.cortado).toBeGreaterThan(0);

      if (meta.cssDaPlataforma) {
        // O descarte nunca devolve mais do que o navegador renderiza. O innerText aplica o
        // text-transform, então a comparação ignora a caixa.
        const rendered = collapse(await bench.mainWorld.evaluate((sel) => (document.querySelector(sel) as HTMLElement).innerText, meta.raizDaPlataforma));
        const outside = r.texto.split("\n").map(collapse).filter((line) => line !== "" && !rendered.includes(line));
        expect(outside).toEqual([]);
      }

      rows.push(
        `${id} | ${r.versao} | ${r.raiz} | ${nodes} | ${allNodes} | ${ms.toFixed(1)} | ${r.texto.length} | ` +
          `${meta.trechosObrigatorios.length}/${meta.trechosObrigatorios.length} | 0/${meta.trechosProibidos.length} | ${discardsOf(r)}`,
      );
    });
  }
});

describe("genérico nas quatro plataformas (medição do ge1)", () => {
  for (const { id, meta } of FIXTURES) {
    test(`${id}: ge1`, async () => {
      const { result, ms } = await bench.runFixture(id, "generico");
      const r = ok(result);
      const has = (s: string): boolean => r.texto.includes(s);
      const required = meta.trechosObrigatorios.filter(has).length;
      const forbidden = meta.trechosProibidos.filter(has).length;
      expect([r.versao, r.raiz]).toEqual(["ge1", meta.raizEsperada]);
      if (meta.plataforma === "linkedin" && meta.sessao !== "logada") {
        // A busca pública em dois painéis: o main é a lista. Por isso o LinkedIn tem extrator próprio.
        expect([required, forbidden]).toEqual([0, 1]);
      } else if (meta.plataforma === "linkedin" || meta.plataforma === "solides") {
        // O main#workspace do LinkedIn logado junta a lista, a vaga e os blocos do perfil; a Solides não
        // tem main e cai no body, com a lista inteira. O genérico traz proibidos: daí a raiz própria.
        expect(forbidden).toBeGreaterThan(0);
      } else {
        expect([required, forbidden]).toEqual([meta.trechosObrigatorios.length, 0]);
      }
      genericRows.push(`${id} | ${r.raiz} | ${ms.toFixed(1)} | ${r.texto.length} | ${required}/${meta.trechosObrigatorios.length} | ${forbidden}/${meta.trechosProibidos.length}`);
    });
  }
});

describe("maxNodes (calibração com as páginas reais)", () => {
  test("uma página com o dobro do teto para no teto e marca truncado, em tempo limitado", async () => {
    const paragraphs = LIMITS.maxNodes; // cada <p> é 2 nós (elemento e texto): o dobro do teto
    const html = `<!doctype html><html><body><main id="m"></main><script>
      const m = document.getElementById("m");
      for (let i = 0; i < ${paragraphs}; i += 1) { const p = document.createElement("p"); p.append("linha " + i); m.append(p); }
    </script></body></html>`;
    const r = ok(await bench.run(html, { ...LIMITS, maxChars: 1_000_000 }));
    const ms = bench.lastMs;
    expect(r.truncado).toBe(true);
    // Cada <p> visitado conta 2 nós: o teto deixa ler a metade dos parágrafos.
    expect(r.texto.split("\n\n")).toHaveLength(LIMITS.maxNodes / 2);
    console.info(`maxNodes ${LIMITS.maxNodes}: ${ms.toFixed(0)} ms com a página de ${2 * paragraphs} nós`);
  });
});
