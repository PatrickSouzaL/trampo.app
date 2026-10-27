// Extrator genérico de texto de vaga (S-2; ADR-023; ADR-001 §5.0 passos 2 a 4; threat-model T2).
// AUTOCONTIDO: o Chrome serializa esta função (scripting.executeScript) e a roda no mundo ISOLATED
// da aba. Nada do escopo do módulo pode ser usado aqui dentro: auxiliares e constantes são internos.
// Só lê o `data` de nós de texto que o usuário vê; nunca atributo como conteúdo, nunca decodifica,
// nunca muda a página (lint em eslint.config.js, ADR-023 D8).

export interface ExtractionLimits {
  /** Teto do texto em unidades UTF-16; o Service Worker trunca de novo em code points. */
  maxChars: number;
  /** Teto de nós visitados por raiz (DOM hostil gigante). */
  maxNodes: number;
  /** Abaixo disso o resultado é `texto_insuficiente` e o painel oferece colar o texto. */
  minChars: number;
}

export type DiscardReason =
  | "naoTexto"
  | "ruido"
  | "naoRenderizado"
  | "ariaHidden"
  | "opacidade"
  | "recorte"
  | "visibilidade"
  | "fonteMinuscula"
  | "tamanhoZero"
  | "foraDaTela"
  | "cortado"
  | "corDoFundo";

export type DiscardCounts = Record<DiscardReason, number>;

export type ExtractionResult =
  | {
      ok: true;
      versao: "ge1";
      raiz: "main" | "article" | "body";
      texto: string;
      truncado: boolean;
      descartes: DiscardCounts;
    }
  | { ok: false; versao: "ge1"; motivo: "limites_invalidos" | "texto_insuficiente" };

export function extractGenericJobText(limites: ExtractionLimits): ExtractionResult {
  const versao = "ge1";
  const inteiroEm = (v: unknown, min: number, max: number): boolean =>
    Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
  if (
    typeof limites !== "object" ||
    limites === null ||
    !inteiroEm(limites.maxChars, 1, 1_000_000) ||
    !inteiroEm(limites.maxNodes, 1, 10_000_000) ||
    !inteiroEm(limites.minChars, 0, limites.maxChars)
  ) {
    return { ok: false, versao, motivo: "limites_invalidos" };
  }

  type Rgba = [number, number, number, number];
  type Corte = { l: number; r: number; t: number; b: number };
  type Contexto = {
    opacidade: number;
    fundo: Rgba | null;
    cortes: Corte[];
    st: CSSStyleDeclaration;
    /** `<details>` fechado: o texto solto direto nele tem caixa, mas não é renderizado. Não herda. */
    textoDiretoOculto: boolean;
  };

  const HTML_NS = "http://www.w3.org/1999/xhtml";
  const SEM_TEXTO = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "OBJECT", "EMBED", "CANVAS", "TEXTAREA", "SELECT", "BUTTON", "HEAD",
  ]);
  const RUIDO = new Set(["NAV", "ASIDE", "FOOTER"]);
  const PARAGRAFO = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "TABLE", "BLOCKQUOTE", "PRE", "SECTION", "HEADER"]);
  const CORTA = /^(hidden|clip)$/;

  // Cor computada pode vir em oklch/lab/color(): o canvas devolve sRGB em bytes para qualquer formato.
  const pincel = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  const cores = new Map<string, Rgba>();
  const rgba = (css: string): Rgba => {
    const salva = cores.get(css);
    if (salva !== undefined) return salva;
    pincel.clearRect(0, 0, 1, 1);
    pincel.fillStyle = css;
    pincel.fillRect(0, 0, 1, 1);
    const px = Array.from(pincel.getImageData(0, 0, 1, 1).data);
    const cor = [px[0], px[1], px[2], (px[3] as number) / 255] as Rgba;
    cores.set(css, cor);
    return cor;
  };
  const sobre = (cima: Rgba, baixo: Rgba): Rgba => {
    const a = cima[3];
    return [cima[0] * a + baixo[0] * (1 - a), cima[1] * a + baixo[1] * (1 - a), cima[2] * a + baixo[2] * (1 - a), 1];
  };
  const luminancia = (c: Rgba): number => {
    const canal = (v: number): number => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * canal(c[0]) + 0.7152 * canal(c[1]) + 0.0722 * canal(c[2]);
  };

  /** Contexto do elemento a partir do pai, ou o motivo do descarte da subárvore inteira (ADR-023 D4). */
  const entrar = (el: Element, pai: Contexto, abaixoDaRaiz: boolean): Contexto | DiscardReason => {
    if (el.namespaceURI !== HTML_NS || SEM_TEXTO.has(el.tagName)) return "naoTexto";
    if (abaixoDaRaiz && RUIDO.has(el.tagName)) return "ruido";
    const st = getComputedStyle(el);
    // display:contents não tem caixa (checkVisibility é falso), mas os filhos são renderizados.
    // content-visibility:hidden mantém a caixa e esconde o conteúdo, inclusive o texto solto direto.
    if ((st.display !== "contents" && !el.checkVisibility()) || st.contentVisibility === "hidden") return "naoRenderizado";
    if (el.ariaHidden === "true") return "ariaHidden";
    const opacidade = pai.opacidade * Number(st.opacity);
    if (opacidade < 0.1) return "opacidade";
    if (st.clipPath !== "none" || st.clip !== "auto") return "recorte";

    let cortes = pai.cortes;
    const ox = st.overflowX;
    const oy = st.overflowY;
    if (ox !== "visible" || oy !== "visible") {
      const caixa = el.getBoundingClientRect();
      // O que transborda para a esquerda ou para cima nunca é alcançável, nem rolando. Para a direita
      // e para baixo, o rolável com área positiva não corta: o usuário rola até o texto.
      const cx = CORTA.test(ox) || caixa.width === 0;
      const cy = CORTA.test(oy) || caixa.height === 0;
      cortes = [
        ...cortes,
        {
          l: ox !== "visible" ? caixa.left : -Infinity,
          r: ox !== "visible" && cx ? caixa.right : Infinity,
          t: oy !== "visible" ? caixa.top : -Infinity,
          b: oy !== "visible" && cy ? caixa.bottom : Infinity,
        },
      ];
    }

    const cor = rgba(st.backgroundColor);
    const fundo = st.backgroundImage !== "none" ? null : cor[3] === 1 ? cor : pai.fundo === null ? null : sobre(cor, pai.fundo);
    // `open` é lido só para decidir (propriedade refletida), nunca emitido (ADR-023 D3).
    const textoDiretoOculto = el instanceof HTMLDetailsElement && !el.open;
    return { opacidade, fundo, cortes, st, textoDiretoOculto };
  };

  /** Motivo do descarte de um nó de texto com conteúdo, ou null se o usuário o vê (ADR-023 D4). */
  const invisivel = (no: Text, ctx: Contexto): DiscardReason | null => {
    if (ctx.textoDiretoOculto) return "naoRenderizado";
    const st = ctx.st;
    if (st.visibility !== "visible") return "visibilidade";
    if (parseFloat(st.fontSize) < 6) return "fonteMinuscula";
    const faixa = document.createRange();
    faixa.selectNodeContents(no);
    const caixas = Array.from(faixa.getClientRects()).filter((c) => c.width > 0 && c.height > 0);
    if (caixas.length === 0) return "tamanhoZero";
    const l = Math.min(...caixas.map((c) => c.left));
    const r = Math.max(...caixas.map((c) => c.right));
    const t = Math.min(...caixas.map((c) => c.top));
    const b = Math.max(...caixas.map((c) => c.bottom));
    if (r + window.scrollX <= 0 || b + window.scrollY <= 0) return "foraDaTela";
    for (const c of ctx.cortes) {
      if (!(r > c.l && l < c.r && b > c.t && t < c.b)) return "cortado";
    }
    const preenchimento = rgba(st.webkitTextFillColor);
    if (preenchimento[3] === 0) return st.backgroundClip === "text" ? null : "corDoFundo";
    if (ctx.fundo === null) return null;
    const lt = luminancia(sobre(preenchimento, ctx.fundo));
    const lf = luminancia(ctx.fundo);
    return (Math.max(lt, lf) + 0.05) / (Math.min(lt, lf) + 0.05) < 1.2 ? "corDoFundo" : null;
  };

  const aparar = (s: string, ch: string): string => {
    let i = 0;
    let j = s.length;
    while (i < j && s[i] === ch) i += 1;
    while (j > i && s[j - 1] === ch) j -= 1;
    return s.slice(i, j);
  };

  const extrair = (raiz: Element): { texto: string; truncado: boolean; descartes: DiscardCounts } => {
    const descartes: DiscardCounts = {
      naoTexto: 0,
      ruido: 0,
      naoRenderizado: 0,
      ariaHidden: 0,
      opacidade: 0,
      recorte: 0,
      visibilidade: 0,
      fonteMinuscula: 0,
      tamanhoZero: 0,
      foraDaTela: 0,
      cortado: 0,
      corDoFundo: 0,
    };
    const partes: string[] = [];
    let tamanho = 0;
    let nos = 0;
    let truncado = false;
    // Fronteira de bloco fica pendente até o próximo texto: dois blocos seguidos não somam quebras.
    let pendente = 0;
    const emitir = (s: string): void => {
      if (pendente > 0) {
        partes.push("\n".repeat(pendente));
        tamanho += pendente;
        pendente = 0;
      }
      partes.push(s);
      tamanho += s.length;
    };
    const quebrar = (n: number): void => {
      pendente = Math.max(pendente, n);
    };

    const texto = (no: Text, ctx: Contexto): void => {
      const pre = /^(pre|break-spaces)/.test(ctx.st.whiteSpace);
      const limpo = pre ? no.data.replace(/\r\n?/g, "\n").replace(/[\t\f ]+/g, " ") : no.data.replace(/[\t\n\f\r ]+/g, " ");
      if (/[^\n ]/.test(limpo)) {
        const motivo = invisivel(no, ctx);
        if (motivo !== null) {
          descartes[motivo] += 1;
          return;
        }
      } else if (limpo === " " && pendente > 0) {
        return; // indentação entre blocos
      }
      emitir(limpo);
    };

    const visitar = (el: Element, ctx: Contexto): void => {
      for (let filho = el.firstChild; filho !== null; filho = filho.nextSibling) {
        // Depois de truncar, a condição continua verdadeira em todo laço acima: a leitura para inteira.
        nos += 1;
        if (nos > limites.maxNodes || tamanho >= limites.maxChars) {
          truncado = true;
          return;
        }
        if (filho.nodeType === Node.TEXT_NODE) texto(filho as Text, ctx);
        else if (filho.nodeType === Node.ELEMENT_NODE) elemento(filho as Element, ctx);
      }
    };

    const elemento = (el: Element, pai: Contexto): void => {
      if (el.tagName === "BR") {
        emitir("\n");
        return;
      }
      const ctx = entrar(el, pai, true);
      if (typeof ctx === "string") {
        descartes[ctx] += 1;
        return;
      }
      const display = ctx.st.display;
      const quebra = PARAGRAFO.has(el.tagName) ? 2 : !display.startsWith("inline") && display !== "contents" ? 1 : 0;
      quebrar(quebra);
      visitar(el, ctx);
      quebrar(quebra);
    };

    // Os ancestrais da raiz também valem: opacidade, fundo e cortes vêm de cima.
    const cadeia: Element[] = [];
    for (let e: Element | null = raiz; e !== null; e = e.parentElement) cadeia.unshift(e);
    const html = document.documentElement;
    let ctx: Contexto | DiscardReason = {
      opacidade: 1,
      fundo: [255, 255, 255, 1],
      cortes: [],
      st: getComputedStyle(html),
      textoDiretoOculto: false,
    };
    for (const e of cadeia) {
      ctx = entrar(e, ctx, false);
      // Ancestral da raiz descartado: nada é lido, e o resultado vira texto_insuficiente.
      if (typeof ctx === "string") return { texto: "", truncado, descartes };
    }
    visitar(raiz, ctx);

    const linhas = partes.join("").split("\n").map((linha) => aparar(linha, " "));
    return { texto: aparar(linhas.join("\n").replace(/\n{3,}/g, "\n\n"), "\n"), truncado, descartes };
  };

  type Raiz = "main" | "article" | "body";
  let raiz: Raiz = "main";
  const principal = Array.from(document.getElementsByTagName("main")).find((m) => m.checkVisibility());
  let melhor = principal === undefined ? undefined : extrair(principal);
  if (melhor === undefined) {
    raiz = "article";
    for (const artigo of Array.from(document.getElementsByTagName("article"))) {
      const candidato = extrair(artigo);
      if (melhor === undefined || candidato.texto.length > melhor.texto.length) melhor = candidato;
    }
  }
  if (melhor === undefined) {
    raiz = "body";
    melhor = extrair(document.body ?? document.documentElement);
  }

  if (melhor.texto.length < limites.minChars) return { ok: false, versao, motivo: "texto_insuficiente" };
  const cortado = melhor.texto.length > limites.maxChars;
  return {
    ok: true,
    versao,
    raiz,
    texto: cortado ? melhor.texto.slice(0, limites.maxChars) : melhor.texto,
    truncado: melhor.truncado || cortado,
    descartes: melhor.descartes,
  };
}
