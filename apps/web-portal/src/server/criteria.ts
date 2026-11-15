// A DAL dos critérios no portal (ADR-028 D4 a D8): a leitura da página e a gravação, sem Next.js. Recebe o que o pedido
// traz (cookies, `Origin`, `Sec-Fetch-Site`, o corpo) e devolve a vista da página ou a intenção HTTP (destino e
// cookies), que a página e a rota só traduzem.
//
// - Nenhum destino sai do pedido: só `/conta/criterios` com um aviso do catálogo, ou a página inicial.
// - A gravação confere o `Origin` e o `Sec-Fetch-Site` antes de qualquer coisa, valida o formulário antes da rede e
//   chama o `PUT` uma vez. O 401 da API só apaga a sessão depois de o GoTrue recusar a renovação forçada (T30).
// - O rascunho que falhou vai num cookie selado de uso único, preso ao `sid` e com 120 s (D8). A pretensão nunca vai a
//   URL, aviso ou log.
import { z } from "zod";

import type { ApiClient } from "./api-client";
import type { PortalConfig } from "./config";
import { COOKIE_NAMES, cookieWrite, type CookieWrite } from "./cookies";
import { CRITERIA_FIELDS, checkFormPairs, criteriaToForm, formPairs, formToCriteria, readFormBody, type CriteriaField, type FormValues } from "./criteria-form";
import { DRAFT_NOTICES, parseCriteriaNotice, type CriteriaNotice } from "./notices";
import { SEAL_PURPOSES, createSealer } from "./seal";
import type { ApiAccess, Forbidden, PortalAuth, Redirect } from "./session";

export const DRAFT_POLICY = Object.freeze({
  /** O rascunho só serve para a página logo depois da gravação que falhou. */
  maxAgeSeconds: 120,
});

export type CriteriaPageView =
  | { readonly kind: "sem_sessao" }
  /** Sem os critérios salvos e sem rascunho: a página não mostra o formulário de padrões (ADR-028 D5). */
  | { readonly kind: "indisponivel"; readonly notice: CriteriaNotice | null }
  | {
      readonly kind: "formulario";
      readonly values: FormValues;
      readonly origin: "salvos" | "padroes" | "rascunho";
      readonly notice: CriteriaNotice | null;
      readonly fields: readonly CriteriaField[];
      /** O aviso é de uma gravação que falhou, mas o rascunho não veio (grande demais, vencido ou de outra sessão). */
      readonly draftLost: boolean;
    };

export interface CriteriaPageInput {
  readonly sessionCookie: string | undefined;
  readonly draftCookie: string | undefined;
  /** O `?aviso=` da página: só escolhe um texto do catálogo. */
  readonly aviso: unknown;
}

export interface CriteriaSaveInput {
  readonly origin: string | null;
  readonly secFetchSite: string | null;
  readonly contentType: string | null;
  readonly body: ReadableStream<Uint8Array> | null;
  readonly sessionCookie: string | undefined;
}

export interface CriteriaDal {
  page(input: CriteriaPageInput): Promise<CriteriaPageView>;
  save(input: CriteriaSaveInput): Promise<Redirect | Forbidden>;
}

export interface CriteriaDalDeps {
  readonly config: PortalConfig;
  readonly auth: PortalAuth;
  readonly api: ApiClient;
  /** Relógio em milissegundos. */
  readonly now: () => number;
}

const DraftNoticeSchema = z.enum(["criterios_invalidos", "criterios_recusados", "criterios_indisponiveis", "criterios_nao_confirmados"]);
type DraftNotice = z.infer<typeof DraftNoticeSchema>;

const DraftSchema = z.strictObject({
  /** A sessão que gravou: o rascunho só abre nela. */
  sid: z.uuid(),
  iat: z.int(),
  a: DraftNoticeSchema,
  c: z.array(z.enum(CRITERIA_FIELDS)).max(CRITERIA_FIELDS.length),
  p: z.array(z.tuple([z.string(), z.string()])),
});

export function createCriteriaDal(deps: CriteriaDalDeps): CriteriaDal {
  const { config, auth, api } = deps;
  const draftSealer = createSealer(config.sealKeys, SEAL_PURPOSES.rascunho, config.portalOrigin);
  const nowSeconds = (): number => Math.floor(deps.now() / 1_000);
  const criteriaPage = (notice: CriteriaNotice): string => `${config.portalOrigin}/conta/criterios?aviso=${notice}`;
  const redirect = (location: string, cookies: ReadonlyArray<CookieWrite | undefined>): Redirect => ({
    kind: "redirect",
    location,
    cookies: cookies.filter((cookie): cookie is CookieWrite => cookie !== undefined),
  });
  /** Sem sessão: a página inicial, com o aviso do estado (o mesmo `homeFor` da `/conta`). */
  const home = (access: ApiAccess & { readonly ok: false }): Redirect =>
    redirect(access.state === "expirada" ? `${config.portalOrigin}/?aviso=sessao_expirada` : `${config.portalOrigin}/`, [access.cookie]);

  /** O rascunho selado; `undefined` sem `sid` ou acima do teto do selo (o aviso segue sem ele). */
  const sealDraft = (sessionId: string | undefined, notice: DraftNotice, fields: readonly CriteriaField[], values: FormValues): CookieWrite | undefined => {
    if (sessionId === undefined) return undefined;
    const sealed = draftSealer.seal(JSON.stringify({ sid: sessionId, iat: nowSeconds(), a: notice, c: fields, p: formPairs(values) }));
    return sealed === null ? undefined : cookieWrite(COOKIE_NAMES.rascunho, sealed, DRAFT_POLICY.maxAgeSeconds);
  };

  const openDraft = (cookie: string | undefined, sessionId: string): { readonly values: FormValues; readonly fields: readonly CriteriaField[] } | null => {
    const text = cookie === undefined ? null : draftSealer.open(cookie);
    if (text === null) return null;
    let parsed: z.infer<typeof DraftSchema>;
    try {
      const result = DraftSchema.safeParse(JSON.parse(text));
      if (!result.success) return null;
      parsed = result.data;
    } catch {
      return null;
    }
    const age = nowSeconds() - parsed.iat;
    if (parsed.sid !== sessionId || age < 0 || age > DRAFT_POLICY.maxAgeSeconds) return null;
    const values = checkFormPairs(parsed.p);
    return values === null ? null : { values, fields: parsed.c };
  };

  return {
    async page({ sessionCookie, draftCookie, aviso }) {
      const access = await auth.apiAccess(sessionCookie, "leitura");
      if (!access.ok) return { kind: "sem_sessao" };
      const notice = parseCriteriaNotice(aviso);
      const draft = openDraft(draftCookie, access.sessionId);
      if (draft !== null) return { kind: "formulario", values: draft.values, origin: "rascunho", notice, fields: draft.fields, draftLost: false };
      const read = await api.readCriteria(access.accessToken);
      // O 401 da leitura também é indisponível: a página não grava cookie, e a sessão morta é o proxy que pega (D4).
      if (!read.ok) return { kind: "indisponivel", notice };
      const draftLost = notice !== null && DRAFT_NOTICES.has(notice);
      return { kind: "formulario", values: criteriaToForm(read.criteria), origin: read.criteria === null ? "padroes" : "salvos", notice, fields: [], draftLost };
    },

    async save({ origin, secFetchSite, contentType, body, sessionCookie }) {
      if (origin !== config.portalOrigin || secFetchSite !== "same-origin") return { kind: "forbidden" };
      const pairs = await readFormBody(contentType, body);
      const values = pairs === null ? null : checkFormPairs(pairs);
      if (values === null) return redirect(criteriaPage("formulario_recusado"), []);

      const access = await auth.apiAccess(sessionCookie, "gravacao");
      if (!access.ok) {
        if (access.state !== "indisponivel") return home(access);
        return redirect(criteriaPage("criterios_indisponiveis"), [access.cookie, sealDraft(access.sessionId, "criterios_indisponiveis", [], values)]);
      }
      const failed = (notice: DraftNotice, fields: readonly CriteriaField[], session: CookieWrite | undefined): Redirect =>
        redirect(criteriaPage(notice), [session, sealDraft(access.sessionId, notice, fields, values)]);

      const parsed = formToCriteria(values);
      if (!parsed.ok) return failed("criterios_invalidos", parsed.fields, access.cookie);

      const written = await api.writeCriteria(access.accessToken, parsed.criteria);
      if (written.ok) return redirect(criteriaPage("criterios_salvos"), [access.cookie]);
      if (written.reason === "invalido") return failed("criterios_recusados", [], access.cookie);
      if (written.reason === "nao_recebido") return failed("criterios_indisponiveis", [], access.cookie);
      if (written.reason === "pode_ter_gravado") return failed("criterios_nao_confirmados", [], access.cookie);

      // 401 da API: a renovação forçada decide, a partir do cookie mais novo. Nada foi gravado, e o PUT não se repete.
      const forced = await auth.apiAccess(access.cookie?.value ?? sessionCookie, "forcada");
      if (!forced.ok && forced.state !== "indisponivel") return home(forced);
      return failed("criterios_indisponiveis", [], forced.cookie ?? access.cookie);
    },
  };
}
