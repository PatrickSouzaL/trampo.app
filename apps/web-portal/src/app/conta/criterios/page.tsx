// Página de critérios (ADR-028 D5): Server Component, sem JS próprio. A DAL verifica a sessão (sem renovar: o proxy já
// renovou), lê os critérios na API a cada pedido e decide entre o salvo, os padrões e o rascunho de uso único. Sem os
// critérios, não mostra o formulário de padrões (salvar por cima apagaria os reais). A pretensão só aparece aqui, para
// o dono, com `no-store` (página dinâmica).
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { COOKIE_NAMES, readCookie } from "../../../server/cookies";
import { SESSION_STATE_HEADER } from "../../../server/edge";
import { CRITERIA_NOTICES, CRITERIA_PAGE_TEXTS } from "../../../server/notices";
import { homeFor } from "../../../server/page-state";
import { getPortalCriteria } from "../../../server/runtime";
import { CriteriaForm } from "./form";

export default async function Criterios({ searchParams }: PageProps<"/conta/criterios">) {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get("cookie");
  const view = await getPortalCriteria().page({
    sessionCookie: readCookie(cookie, COOKIE_NAMES.sessao),
    draftCookie: readCookie(cookie, COOKIE_NAMES.rascunho),
    aviso: (await searchParams)["aviso"],
  });
  if (view.kind === "sem_sessao") redirect(homeFor(requestHeaders.get(SESSION_STATE_HEADER)));

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">Seus critérios</h1>
      {view.notice === null ? null : (
        <p role="status" data-aviso={view.notice} className="rounded border px-3 py-2">
          {CRITERIA_NOTICES[view.notice]}
          {view.kind === "formulario" && view.draftLost ? ` ${CRITERIA_PAGE_TEXTS.rascunhoPerdido}` : null}
        </p>
      )}
      {view.kind === "indisponivel" ? (
        <p data-criterios="indisponivel">{CRITERIA_PAGE_TEXTS.indisponivel}</p>
      ) : (
        <section data-origem={view.origin} className="flex flex-col gap-4">
          {view.origin === "rascunho" ? <p data-rascunho="sim">{CRITERIA_PAGE_TEXTS.rascunho}</p> : null}
          {view.origin === "padroes" ? <p>{CRITERIA_PAGE_TEXTS.padroes}</p> : null}
          <CriteriaForm values={view.values} fields={view.fields} />
        </section>
      )}
      <a href="/conta" className="underline">
        Voltar para a sua conta
      </a>
    </main>
  );
}
