// Página "Seus dados" (ADR-029 D9): Server Component, sem JS próprio. A DAL verifica a sessão (sem renovar: o proxy já
// renovou). O formulário de baixar posta em `POST /conta/dados/exportar` (os dados nunca passam por URL), e a exclusão
// é só um link para a página de confirmação: daqui nada posta na rota que exclui.
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { COOKIE_NAMES, readCookie } from "../../../server/cookies";
import { SESSION_STATE_HEADER } from "../../../server/edge";
import { ACCOUNT_NOTICES, ACCOUNT_PAGE_TEXTS } from "../../../server/notices";
import { homeFor } from "../../../server/page-state";
import { getPortalAccount } from "../../../server/runtime";

export default async function Dados({ searchParams }: PageProps<"/conta/dados">) {
  const requestHeaders = await headers();
  const view = await getPortalAccount().page({
    sessionCookie: readCookie(requestHeaders.get("cookie"), COOKIE_NAMES.sessao),
    aviso: (await searchParams)["aviso"],
  });
  if (view.kind === "sem_sessao") redirect(homeFor(requestHeaders.get(SESSION_STATE_HEADER)));

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">{ACCOUNT_PAGE_TEXTS.titulo}</h1>
      {view.notice === null ? null : (
        <p role="status" data-aviso={view.notice} className="rounded border px-3 py-2">
          {ACCOUNT_NOTICES[view.notice]}
        </p>
      )}
      <section className="flex flex-col gap-3">
        <p data-dados="exportar">{ACCOUNT_PAGE_TEXTS.exportar}</p>
        <p data-dados="exportar-fora">{ACCOUNT_PAGE_TEXTS.exportarFora}</p>
        <form method="post" action="/conta/dados/exportar">
          <button type="submit" className="rounded border px-4 py-2">
            {ACCOUNT_PAGE_TEXTS.baixar}
          </button>
        </form>
      </section>
      <a href="/conta/dados/excluir" className="underline">
        {ACCOUNT_PAGE_TEXTS.excluirLink}
      </a>
      <a href="/conta" className="underline">
        {ACCOUNT_PAGE_TEXTS.voltarConta}
      </a>
    </main>
  );
}
