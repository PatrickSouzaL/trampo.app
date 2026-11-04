// S-2 / ADR-023 §3: o extrator genérico no Edge real, serializado e no mundo isolado.
// Critérios: canário oculto nunca aparece e o contador da técnica sobe (1); controles visíveis
// aparecem (2); atributos, comentários e não-texto nunca aparecem (3); invisíveis Unicode e Base64
// literais (4); página hostil não muda o resultado (5); limites (6); função serializada (7, toda
// execução); cobertura de bloco de 100% medida pelo V8 (8, último teste do arquivo).
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { ExtractionResult } from "../../src/extraction/job-extractor";

import { Bench, LIMITS, page } from "./bench";
import { ALL_REASONS, SYNTHETIC_CASES } from "./synthetic-cases";

const bench = new Bench();
beforeAll(() => bench.open());
afterAll(() => bench.close());

function ok(r: ExtractionResult): Extract<ExtractionResult, { ok: true }> {
  if (!r.ok) throw new Error(`esperava ok, veio ${r.motivo}`);
  return r;
}

describe("fixtures sintéticas: uma por técnica do T2", () => {
  for (const c of SYNTHETIC_CASES) {
    test(`${c.id}: ${c.technique}`, async () => {
      const r = ok(await bench.run(c.html));
      expect(r.versao).toBe("ge1");
      expect(r.raiz).toBe("main");
      expect(r.truncado).toBe(false);
      expect(r.texto).not.toContain("CANARIO");
      expect(r.texto).toContain("VISIVEL-base");
      for (const v of c.visible) expect(r.texto).toContain(v);
      expect(r.descartes).toEqual(Object.fromEntries(ALL_REASONS.map((k) => [k, c.discards[k] ?? 0])));
    });
  }

  test("pagina-hostil: a troca de APIs vale no mundo principal (a prova do isolamento não é vazia)", async () => {
    const hostile = SYNTHETIC_CASES.find((c) => c.id === "pagina-hostil");
    expect(hostile).toBeDefined();
    await bench.run(hostile?.html ?? "");
    const seen = await bench.mainWorld.evaluate(() => {
      const hidden = document.querySelector("main p[style]");
      return { visible: hidden?.checkVisibility(), opacity: getComputedStyle(document.body).opacity, text: document.createTextNode("x").data };
    });
    expect(seen).toEqual({ visible: true, opacity: "1", text: "CANARIO-hostil-3" });
  });
});

describe("montagem do texto (ADR-023 D6)", () => {
  test("blocos, parágrafos, BR, inline, contents, listas, pre e espaços", async () => {
    const r = ok(
      await bench.run(
        page(
          "<main><h1>Título</h1><div>linha a<br>linha b</div><span>in</span><span>line</span> <b>x</b>" +
            '<div style="display:contents">conteúdo</div>\n  <ul>\n    <li>item 1</li>\n    <li>item 2</li>\n  </ul>\n' +
            "<pre>  pre   1\n  pre 2</pre><p>  espaços \t\n  colapsados  </p><div><div><div>fundo</div></div></div></main>",
        ),
      ),
    );
    expect(r.texto).toBe("Título\n\nlinha a\nlinha b\ninline xconteúdo\n\nitem 1\nitem 2\n\npre 1\npre 2\n\nespaços colapsados\n\nfundo");
  });

  test("white-space: break-spaces e pre-line preservam as quebras", async () => {
    const r = ok(
      await bench.run(page('<main><p style="white-space:break-spaces">a\nb</p><p style="white-space:pre-line">c\nd</p></main>')),
    );
    expect(r.texto).toBe("a\nb\n\nc\nd");
  });

  test("BR seguido de parágrafo não passa de uma linha em branco", async () => {
    const r = ok(await bench.run(page("<main>a<br><p>b</p></main>")));
    expect(r.texto).toBe("a\n\nb");
  });

  test("CR e CRLF em pre viram LF", async () => {
    const r = ok(
      await bench.run(page('<main><pre id="p"></pre><script>document.getElementById("p").append("a\\r\\nb\\rc");</script></main>')),
    );
    expect(r.texto).toBe("a\nb\nc");
  });
});

describe("escolha da raiz (ADR-023 D7)", () => {
  test("o primeiro main visível", async () => {
    const r = ok(await bench.run(page('<main style="display:none">CANARIO-main-oculto</main><main>segundo main</main><article>artigo</article>')));
    expect([r.raiz, r.texto]).toEqual(["main", "segundo main"]);
  });

  test("sem main visível, o article com mais texto", async () => {
    const r = ok(await bench.run(page('<main hidden>CANARIO-main</main><article>curto</article><article>artigo mais longo</article>')));
    expect([r.raiz, r.texto]).toEqual(["article", "artigo mais longo"]);
  });

  test("article empatado fica com o primeiro", async () => {
    const r = ok(await bench.run(page("<article>AAAA</article><article>BBBB</article>")));
    expect(r.texto).toBe("AAAA");
  });

  test("sem main nem article, o body", async () => {
    const r = ok(await bench.run(page("<div>só o corpo</div>")));
    expect([r.raiz, r.texto]).toEqual(["body", "só o corpo"]);
  });

  test("sem body, o documentElement (e o head não conta)", async () => {
    const r = await bench.run(page("<script>document.body.remove();</script>", "<title>CANARIO-titulo</title>"));
    expect(r).toEqual({ ok: false, versao: "ge1", motivo: "texto_insuficiente" });
  });

  test("ancestral da raiz oculto descarta tudo", async () => {
    const html = '<!doctype html><html><body style="opacity:0"><main>CANARIO-ancestral texto longo</main></body></html>';
    expect(await bench.run(html)).toEqual({ ok: false, versao: "ge1", motivo: "texto_insuficiente" });
  });

  test("página rolada: o que ficou acima ou à esquerda da viewport continua visível", async () => {
    const r = ok(
      await bench.run(
        page(
          '<main><p>VISIVEL-topo</p><div style="width:6000px;height:4000px"></div></main>' +
            "<script>window.scrollTo(3000, 2000);</script>",
        ),
      ),
    );
    expect(r.texto).toBe("VISIVEL-topo");
    expect(r.descartes.foraDaTela).toBe(0);
  });
});

describe("raiz da plataforma (ADR-023 D11)", () => {
  const LIST = "<main><ul><li>CANARIO-lista vaga A</li><li>CANARIO-lista vaga B</li></ul></main>";
  const PANE = '<div class="details-pane__content"><h2>Vaga aberta</h2><p>descrição da vaga</p></div>';

  test("LinkedIn: a vaga aberta, irmã do main que é a lista", async () => {
    const r = ok(await bench.run(page(LIST + PANE), LIMITS, "linkedin"));
    expect([r.versao, r.raiz, r.texto]).toEqual(["li1", "plataforma", "Vaga aberta\n\ndescrição da vaga"]);
  });

  test("LinkedIn: o primeiro painel visível vence", async () => {
    const html = page(`${LIST}<div class="details-pane__content" hidden>CANARIO-painel-oculto</div>${PANE}`);
    const r = ok(await bench.run(html, LIMITS, "linkedin"));
    expect([r.versao, r.texto]).toEqual(["li1", "Vaga aberta\n\ndescrição da vaga"]);
  });

  test("LinkedIn: sem painel visível, o genérico roda (ge1) e a raiz diz qual", async () => {
    const hidden = ok(await bench.run(page(`<main>lista</main><div class="details-pane__content" style="display:none">CANARIO</div>`), LIMITS, "linkedin"));
    expect([hidden.versao, hidden.raiz, hidden.texto]).toEqual(["ge1", "main", "lista"]);
    const absent = ok(await bench.run(page("<article>só o artigo</article>"), LIMITS, "linkedin"));
    expect([absent.versao, absent.raiz, absent.texto]).toEqual(["ge1", "article", "só o artigo"]);
  });

  test("LinkedIn: o painel achado decide mesmo com pouco texto (a lista não entra no lugar)", async () => {
    const html = page(`<main>${"lista longa ".repeat(30)}</main><div class="details-pane__content">curto</div>`);
    expect(await bench.run(html, { ...LIMITS, minChars: 10 }, "linkedin")).toEqual({ ok: false, versao: "li1", motivo: "texto_insuficiente" });
  });

  test("LinkedIn: as regras de descarte valem dentro do painel", async () => {
    const html = page(`${LIST}<div class="details-pane__content"><p>visível</p><p style="opacity:0">CANARIO-opaco</p><nav>CANARIO-nav</nav></div>`);
    const r = ok(await bench.run(html, LIMITS, "linkedin"));
    expect(r.texto).toBe("visível");
    expect([r.descartes.opacidade, r.descartes.ruido]).toEqual([1, 1]);
  });

  test("Gupy: o main#main, mesmo que não seja o primeiro main", async () => {
    const r = ok(await bench.run(page('<main>CANARIO-outro-main</main><main id="main">vaga da Gupy</main>'), LIMITS, "gupy"));
    expect([r.versao, r.raiz, r.texto]).toEqual(["gu1", "plataforma", "vaga da Gupy"]);
  });

  test("Solides: a vaga aberta ao lado da lista de cartões", async () => {
    const html = page('<div><ul><li>CANARIO-cartao outra vaga</li></ul><div id="vacancy-box-details">vaga da Solides</div></div>');
    const r = ok(await bench.run(html, LIMITS, "solides"));
    expect([r.versao, r.raiz, r.texto]).toEqual(["so1", "plataforma", "vaga da Solides"]);
    const sem = ok(await bench.run(page('<div>lista</div><div id="vacancy-box-details" hidden>CANARIO</div>'), LIMITS, "solides"));
    expect([sem.versao, sem.raiz, sem.texto]).toEqual(["ge1", "body", "lista"]);
  });

  test("genérico ignora os seletores das plataformas", async () => {
    const r = ok(await bench.run(page(`<main>lista</main>${PANE}`), LIMITS, "generico"));
    expect([r.versao, r.raiz, r.texto]).toEqual(["ge1", "main", "lista"]);
  });

  const invalid: [string, unknown][] = [
    ["desconhecida", "indeed"],
    ["protótipo", "__proto__"],
    ["construtor", "constructor"],
    ["número", 5],
    ["nula", null],
  ];
  for (const [name, platform] of invalid) {
    test(`plataforma inválida (${name}) não lê o DOM`, async () => {
      expect(await bench.run(page(`<main>texto</main>${PANE}`), LIMITS, platform)).toEqual({ ok: false, versao: "ge1", motivo: "limites_invalidos" });
    });
  }
});

// LinkedIn logado (ADR-023 D12): o `main#workspace` junta a lista e o painel da vaga, e o painel traz
// blocos tirados do perfil e da rede do usuário. Só a descrição entra.
describe("LinkedIn logado (ADR-023 D12)", () => {
  const SCREEN = "com.linkedin.sdui.flagshipnav.jobs.SemanticJobDetails";
  const DESC = '<span data-testid="expandable-text-box">descrição da vaga logada</span>';
  const logged = (pane: string, screen = SCREEN): string =>
    page(
      '<main id="workspace"><ul><li>CANARIO-lista outra vaga</li></ul>' +
        `<div data-sdui-screen="${screen}"><p>CANARIO-perfil: algumas qualificações não constam do seu perfil</p>${pane}</div></main>`,
    );

  test("só a descrição do painel (li2): nem a lista nem os blocos do perfil", async () => {
    const r = ok(await bench.run(logged(DESC), LIMITS, "linkedin"));
    expect([r.versao, r.raiz, r.texto]).toEqual(["li2", "plataforma", "descrição da vaga logada"]);
  });

  test("a primeira descrição visível vence (a da empresa vem depois)", async () => {
    const pane = '<span data-testid="expandable-text-box" hidden>CANARIO-oculta</span>' + DESC + '<span data-testid="expandable-text-box">CANARIO-sobre a empresa</span>';
    const r = ok(await bench.run(logged(pane), LIMITS, "linkedin"));
    expect(r.texto).toBe("descrição da vaga logada");
  });

  test("o painel é reconhecido pelo sufixo do nome da tela", async () => {
    const r = ok(await bench.run(logged(DESC, "x.SemanticJobDetails"), LIMITS, "linkedin"));
    expect(r.versao).toBe("li2");
  });

  const closed: [string, string][] = [
    ["sem a descrição", logged("")],
    ["descrição fora do painel da vaga", page(`<main id="workspace"><ul><li>CANARIO-lista</li></ul>${DESC}</main>`)],
    ["outra tela", logged(DESC, "x.SemanticJobDetailsV2")],
  ];
  for (const [name, html] of closed) {
    test(`layout logado ${name}: nada é lido (o genérico pegaria a lista e o perfil)`, async () => {
      expect(await bench.run(html, LIMITS, "linkedin")).toEqual({ ok: false, versao: "li2", motivo: "texto_insuficiente" });
    });
  }

  test("layout logado oculto não fecha: o genérico roda", async () => {
    const r = ok(await bench.run(page('<main id="workspace" hidden>CANARIO</main><main>lista</main>'), LIMITS, "linkedin"));
    expect([r.versao, r.raiz, r.texto]).toEqual(["ge1", "main", "lista"]);
  });

  test("a raiz pública achada vence o layout logado sem descrição", async () => {
    const html = page('<main id="workspace">CANARIO-lista</main><div class="details-pane__content">vaga pública</div>');
    const r = ok(await bench.run(html, LIMITS, "linkedin"));
    expect([r.versao, r.texto]).toEqual(["li1", "vaga pública"]);
  });

  test("com as duas raízes, a logada (li2) vem primeiro", async () => {
    const html = page(`<div class="details-pane__content">CANARIO-publica</div><div data-sdui-screen="${SCREEN}">${DESC}</div>`);
    const r = ok(await bench.run(html, LIMITS, "linkedin"));
    expect([r.versao, r.texto]).toEqual(["li2", "descrição da vaga logada"]);
  });

  // ADR-023 D13: o clamp de linhas da própria descrição não corta. As outras regras do D4 continuam
  // valendo dentro dela, e o clamp em qualquer outro lugar continua cortando.
  const CLAMP = "display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden";
  const box = (inner: string, style = CLAMP): string => `<span data-testid="expandable-text-box" style="${style}">${inner}</span>`;

  test('"ver mais" fechado: o que o clamp da descrição recolhe entra (D13)', async () => {
    const r = ok(await bench.run(logged(box("linha 1<br>linha 2<br>recolhida linha 3<br>recolhida linha 4")), LIMITS, "linkedin"));
    expect([r.versao, r.texto, r.descartes.cortado]).toEqual(["li2", "linha 1\nlinha 2\nrecolhida linha 3\nrecolhida linha 4", 0]);
  });

  test('"ver mais" fechado: o oculto dentro do recolhido continua de fora', async () => {
    const hidden =
      '<span style="display:none">CANARIO-none</span><span style="color:#fff">CANARIO-branco</span>' +
      '<span style="font-size:0">CANARIO-zero</span><span style="opacity:0">CANARIO-opaco</span>' +
      '<span style="position:relative;left:-9999px">CANARIO-esquerda</span>';
    const r = ok(await bench.run(logged(box(`linha 1<br>linha 2<br>recolhida ${hidden}linha 3`)), LIMITS, "linkedin"));
    expect(r.texto).toBe("linha 1\nlinha 2\nrecolhida linha 3");
    expect(r.descartes).toMatchObject({ naoRenderizado: 1, corDoFundo: 1, fonteMinuscula: 1, opacidade: 1, foraDaTela: 1, cortado: 0 });
  });

  test('"ver mais" fechado: o clamp aninhado na descrição continua cortando', async () => {
    const r = ok(await bench.run(logged(box(`linha 1<br><span style="${CLAMP}">aninhada 1<br>aninhada 2<br>CANARIO-aninhada 3</span>`)), LIMITS, "linkedin"));
    expect([r.texto, r.descartes.cortado]).toEqual(["linha 1\n\naninhada 1\naninhada 2", 1]);
  });

  test("a descrição com corte de altura sem clamp continua cortando", async () => {
    const r = ok(await bench.run(logged(box("linha 1<br>CANARIO-altura linha 2", "display:block;height:1.4em;overflow:hidden")), LIMITS, "linkedin"));
    expect([r.texto, r.descartes.cortado]).toEqual(["linha 1", 1]);
  });

  test("o clamp de um ancestral da descrição continua cortando: só a própria raiz abre", async () => {
    const pane = `<div style="${CLAMP}">${box("linha 1<br>linha 2<br>CANARIO-ancestral linha 3", "display:block")}</div>`;
    const r = ok(await bench.run(logged(pane), LIMITS, "linkedin"));
    expect([r.texto, r.descartes.cortado]).toEqual(["linha 1\nlinha 2", 1]);
  });

  test("clamp sem corte vertical na descrição: as linhas transbordam, e o corte de fora continua valendo", async () => {
    // overflow-x: clip deixa o eixo vertical visível: nada a abrir, e o corte de altura de fora vale.
    const style = "display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-x:clip";
    const pane = `<div style="height:2.8em;overflow:hidden">${box("linha 1<br>linha 2<br>CANARIO-transbordo linha 3", style)}</div>`;
    const r = ok(await bench.run(logged(pane), LIMITS, "linkedin"));
    expect([r.texto, r.descartes.cortado]).toEqual(["linha 1\nlinha 2", 1]);
  });

  test("a descrição com clamp rolável não estende duas vezes: o rolável já alcança o resto", async () => {
    const style = "display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:auto;height:2.8em";
    const r = ok(await bench.run(logged(box("linha 1<br>linha 2<br>linha 3", style)), LIMITS, "linkedin"));
    expect([r.texto, r.descartes.cortado]).toEqual(["linha 1\nlinha 2\nlinha 3", 0]);
  });

  test('"ver mais" fechado num rolável: abrir empurra o fim da rolagem, e o recolhido além dele entra', async () => {
    // O rolável (100 px) só alcança o que está nele; as 40 linhas recolhidas (~900 px) ficam além do
    // fim da rolagem até o "ver mais" abrir. O que vem depois da descrição no rolável não é lido.
    const lines = Array.from({ length: 40 }, (_, i) => `recolhida ${i + 3}`).join("<br>");
    const pane = `<div style="height:100px;overflow:auto">${box(`linha 1<br>linha 2<br>${lines}`)}<p>CANARIO-depois</p></div>`;
    const r = ok(await bench.run(logged(pane), LIMITS, "linkedin"));
    expect(r.texto.split("\n")).toHaveLength(42);
    expect(r.texto.endsWith("recolhida 42")).toBe(true);
  });

  test("o clamp da raiz de outra plataforma e do genérico continua cortando (T2)", async () => {
    const inner = "linha 1<br>linha 2<br>CANARIO-recolhido linha 3";
    const linkedinPublic = ok(await bench.run(page(`<div class="details-pane__content" style="${CLAMP}">${inner}</div>`), LIMITS, "linkedin"));
    const generic = ok(await bench.run(logged(box(inner)), LIMITS, "generico"));
    expect([linkedinPublic.versao, linkedinPublic.texto]).toEqual(["li1", "linha 1\nlinha 2"]);
    expect(generic.versao).toBe("ge1");
    expect(generic.texto).not.toContain("CANARIO-recolhido");
  });

  test("DOM Clobbering: <form> que sombreia scrollHeight não estende o clamp (NaN corta tudo)", async () => {
    const form = `<form data-testid="expandable-text-box" style="${CLAMP}">linha 1<br>linha 2<br>CANARIO-recolhido<input name="scrollHeight"><input name="clientHeight"></form>`;
    const r = await bench.run(logged(form), LIMITS, "linkedin");
    expect(r).toEqual({ ok: false, versao: "li2", motivo: "texto_insuficiente" });
  });
});

describe("limites (ADR-023 D1 e D7)", () => {
  const invalid: [string, unknown][] = [
    ["null", null],
    ["string", "x"],
    ["maxChars fracionário", { ...LIMITS, maxChars: 1.5 }],
    ["maxChars zero", { ...LIMITS, maxChars: 0, minChars: 0 }],
    ["maxChars acima do teto", { ...LIMITS, maxChars: 1_000_001 }],
    ["maxChars ausente", { maxNodes: 10, minChars: 0 }],
    ["maxNodes zero", { ...LIMITS, maxNodes: 0 }],
    ["maxNodes acima do teto", { ...LIMITS, maxNodes: 10_000_001 }],
    ["minChars negativo", { ...LIMITS, minChars: -1 }],
    ["minChars acima de maxChars", { ...LIMITS, maxChars: 10, minChars: 11 }],
  ];
  for (const [name, limits] of invalid) {
    test(`inválido: ${name}`, async () => {
      expect(await bench.run(page("<main>texto</main>"), limits)).toEqual({ ok: false, versao: "ge1", motivo: "limites_invalidos" });
    });
  }

  test("tetos aceitos nos extremos", async () => {
    const r = ok(await bench.run(page("<main>abcde</main>"), { maxChars: 1_000_000, maxNodes: 10_000_000, minChars: 0 }));
    expect(r.texto).toBe("abcde");
    const exact = ok(await bench.run(page("<main>abcde</main>"), { maxChars: 5, maxNodes: 2, minChars: 5 }));
    expect([exact.texto, exact.truncado]).toEqual(["abcde", false]);
  });

  test("minChars: abaixo do mínimo é texto_insuficiente", async () => {
    expect(await bench.run(page("<main>abcde</main>"), { ...LIMITS, minChars: 6 })).toEqual({
      ok: false,
      versao: "ge1",
      motivo: "texto_insuficiente",
    });
  });

  test("maxChars corta o texto final", async () => {
    const r = ok(await bench.run(page("<main>abcde</main>"), { ...LIMITS, maxChars: 4 }));
    expect([r.texto, r.truncado]).toEqual(["abcd", true]);
  });

  test("maxChars para a leitura", async () => {
    const r = ok(await bench.run(page("<main><p>abcdef</p><p>CANARIO-depois-do-teto</p></main>"), { ...LIMITS, maxChars: 8 }));
    expect([r.texto, r.truncado]).toEqual(["abcdef", true]);
  });

  test("maxNodes para a leitura", async () => {
    const r = ok(await bench.run(page("<main><p>um</p><p>dois</p><p>CANARIO-tres</p></main>"), { ...LIMITS, maxNodes: 4 }));
    expect([r.texto, r.truncado]).toEqual(["um\n\ndois", true]);
  });

  test("o teto atingido num nível interno para também os níveis de cima", async () => {
    const html = page("<main><div><p>um</p><p>CANARIO-a</p></div><p>CANARIO-b</p><div><p>CANARIO-c</p></div></main>");
    const r = ok(await bench.run(html, { ...LIMITS, maxNodes: 4 }));
    expect([r.texto, r.truncado]).toEqual(["um", true]);
  });
});

// Precisa ser o último: une a cobertura de bloco de todas as execuções acima.
test("cobertura de bloco do V8: 100% do extrator", () => {
  expect(bench.uncovered()).toEqual([]);
});
