// Leitor do .gitleaks.toml e a semântica mínima do gitleaks 8 que as regras próprias usam (ADR-004 §4.8; ADR-019
// D6 e emenda do 07h). Não é um parser de TOML: lê só o subconjunto que o repositório escreve e recusa o resto, de
// propósito. Uma regra própria não pode ganhar allowlist, `entropy` nem `secretGroup` sem mudar este arquivo (e o
// teste), e toda regex precisa ser lida igual pelo RE2 do gitleaks e pelo V8 do teste.

export class GitleaksConfigError extends Error {
  constructor(detail: string) {
    super(`.gitleaks.toml fora do subconjunto aceito: ${detail}`);
    this.name = "GitleaksConfigError";
  }
}

export interface GitleaksRule {
  readonly id: string;
  readonly description: string;
  readonly regex?: string;
  readonly path?: string;
  readonly keywords: readonly string[];
}

export interface GitleaksConfig {
  readonly useDefault: boolean;
  /** Regex das `[[allowlists]]` globais, que valem para todas as regras (inclusive as próprias). */
  readonly allowlistRegexes: readonly string[];
  readonly rules: readonly GitleaksRule[];
}

export interface ScannedFragment {
  /** Caminho com `/`, como o gitleaks o vê no modo `git`. */
  readonly path: string;
  readonly content: string;
}

/** Lookaround, referência para trás, flag solta e o grupo nomeado do Go: um dos dois motores leria diferente. */
const NOT_PORTABLE = /\(\?[=!]|\(\?<[=!]|\\[1-9]|\(\?[a-zA-Z]+\)|\(\?P</;
const SECTION = /^\[\[?([\w.]+)\]\]?$/;
const ASSIGNMENT = /^(\w+) = (.*)$/;
const LITERAL = /^'''(.*)'''$/;
const BASIC = /^"([^"\\]*)"$/;
const LIST_ITEM = /^'''(.*)''',$/;
const KEYWORDS = /^\[((?:"[^"\\]*"(?:, )?)*)\]$/;

export function portableRegExp(source: string): RegExp {
  if (NOT_PORTABLE.test(source)) throw new GitleaksConfigError("regex que o RE2 e o V8 não leem igual");
  try {
    return new RegExp(source);
  } catch {
    throw new GitleaksConfigError("regex inválida");
  }
}

function stringValue(raw: string): string {
  const match = LITERAL.exec(raw) ?? BASIC.exec(raw);
  if (match === null) throw new GitleaksConfigError("valor que não é string");
  return match[1] as string;
}

function keywordList(raw: string): string[] {
  const match = KEYWORDS.exec(raw);
  if (match === null) throw new GitleaksConfigError("keywords fora da forma");
  return [...(match[1] as string).matchAll(/"([^"\\]*)"/g)].map((item) => item[1] as string);
}

type RuleDraft = Record<string, string | readonly string[]>;
type Section = "extend" | "allowlists" | "rules";

const RULE_KEYS: ReadonlySet<string> = new Set(["id", "description", "regex", "path", "keywords"]);

function finishRule(draft: RuleDraft, seen: Set<string>): GitleaksRule {
  const { id, description, regex, path, keywords } = draft as {
    id?: string;
    description?: string;
    regex?: string;
    path?: string;
    keywords?: readonly string[];
  };
  if (id === undefined || description === undefined) throw new GitleaksConfigError("regra sem id ou descrição");
  if (regex === undefined && path === undefined) throw new GitleaksConfigError("regra sem regex nem path");
  if (seen.has(id)) throw new GitleaksConfigError("id de regra repetido");
  seen.add(id);
  for (const source of [regex, path]) if (source !== undefined) portableRegExp(source);
  return {
    id,
    description,
    ...(regex === undefined ? {} : { regex }),
    ...(path === undefined ? {} : { path }),
    keywords: keywords ?? [],
  };
}

export function parseGitleaksConfig(text: string): GitleaksConfig {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let useDefault = false;
  const allowlistRegexes: string[] = [];
  const rules: GitleaksRule[] = [];
  const ids = new Set<string>();
  let section: Section | null = null;
  let draft: RuleDraft | null = null;

  const closeRule = (): void => {
    if (draft !== null) rules.push(finishRule(draft, ids));
    draft = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] as string).trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = SECTION.exec(line);
    if (header !== null) {
      closeRule();
      const name = header[1] as string;
      if (line === "[extend]") section = "extend";
      else if (line === "[[allowlists]]") section = "allowlists";
      else if (line === "[[rules]]") {
        section = "rules";
        draft = {};
      } else throw new GitleaksConfigError(`seção ${name}`);
      continue;
    }
    const assignment = ASSIGNMENT.exec(line);
    if (assignment === null) throw new GitleaksConfigError("linha que não é chave = valor");
    const key = assignment[1] as string;
    const raw = assignment[2] as string;
    if (section === "rules") {
      const rule = draft as unknown as RuleDraft;
      if (!RULE_KEYS.has(key) || key in rule) throw new GitleaksConfigError(`chave ${key} numa regra`);
      rule[key] = key === "keywords" ? keywordList(raw) : stringValue(raw);
    } else if (section === "extend") {
      if (key !== "useDefault" || (raw !== "true" && raw !== "false")) throw new GitleaksConfigError(`chave ${key} no extend`);
      useDefault = raw === "true";
    } else if (section === "allowlists") {
      if (key === "description") {
        stringValue(raw);
      } else if (key === "regexes" && raw === "[") {
        for (index += 1; ; index += 1) {
          if (index >= lines.length) throw new GitleaksConfigError("lista de regexes sem fechar");
          const item = (lines[index] as string).trim();
          if (item === "]") break;
          if (item === "" || item.startsWith("#")) continue;
          const match = LIST_ITEM.exec(item);
          if (match === null) throw new GitleaksConfigError("item da lista de regexes");
          portableRegExp(match[1] as string);
          allowlistRegexes.push(match[1] as string);
        }
      } else {
        throw new GitleaksConfigError(`chave ${key} na allowlist`);
      }
    } else {
      throw new GitleaksConfigError("chave fora de seção");
    }
  }
  closeRule();
  return { useDefault, allowlistRegexes, rules };
}

/**
 * O gitleaks acharia algo com esta regra neste fragmento? Palavra-chave (sem caixa) antes da regex; regra só de
 * `path` acha pelo caminho; com regex e `path`, os dois casam; a allowlist global olha o trecho casado (as regras
 * próprias não têm grupo de captura, então o segredo é o trecho inteiro).
 */
export function findsSecret(config: GitleaksConfig, ruleId: string, fragment: ScannedFragment): boolean {
  const rule = config.rules.find((candidate) => candidate.id === ruleId);
  if (rule === undefined) throw new GitleaksConfigError(`regra ${ruleId} não existe`);
  if (rule.path !== undefined && !portableRegExp(rule.path).test(fragment.path)) return false;
  if (rule.regex === undefined) return true;
  const lower = fragment.content.toLowerCase();
  if (rule.keywords.length > 0 && !rule.keywords.some((keyword) => lower.includes(keyword))) return false;
  const match = portableRegExp(rule.regex).exec(fragment.content);
  if (match === null) return false;
  return !config.allowlistRegexes.some((source) => portableRegExp(source).test(match[0]));
}
