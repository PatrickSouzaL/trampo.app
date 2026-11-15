// Página de confirmação da exclusão da conta (ADR-029 D9): Server Component, sem JS próprio. Diz o que some e que não
// há volta, e tem o único formulário que posta em `POST /conta/dados/excluir/confirmar`, com a frase a digitar. Com a
// sessão mais velha que 10 minutos, mostra o aviso do login recente no lugar do formulário (o banco recusaria de
// qualquer jeito). Abrir esta página nunca exclui nada.
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ACCOUNT_POLICY } from "../../../../server/account";
import { COOKIE_NAMES, readCookie } from "../../../../server/cookies";
import { SESSION_STATE_HEADER } from "../../../../server/edge";
import { ACCOUNT_NOTICES, ACCOUNT_PAGE_TEXTS } from "../../../../server/notices";
import { homeFor } from "../../../../server/page-state";
import { getPortalAccount } from "../../../../server/runtime";

export default async function ExcluirConta({ searchParams }: PageProps<"/conta/dados/excluir">) {
  const requestHeaders = await headers();
  const view = await getPortalAccount().confirmPage({
    sessionCookie: readCookie(requestHeaders.get("cookie"), COOKIE_NAMES.sessao),
    aviso: (await searchParams)["aviso"],
  });
  if (view.kind === "sem_sessao") redirect(homeFor(requestHeaders.get(SESSION_STATE_HEADER)));

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">{ACCOUNT_PAGE_TEXTS.excluirTitulo}</h1>
      {view.notice === null ? null : (
        <p role="status" data-aviso={view.notice} className="rounded border px-3 py-2">
          {ACCOUNT_NOTICES[view.notice]}
        </p>
      )}
      <p data-excluir="efeito">{ACCOUNT_PAGE_TEXTS.excluirEfeito}</p>
      <p data-excluir="sem-volta">{ACCOUNT_PAGE_TEXTS.excluirSemVolta}</p>
      <p data-excluir="prazo">{ACCOUNT_PAGE_TEXTS.excluirPrazo}</p>
      {view.recent ? (
        <form method="post" action="/conta/dados/excluir/confirmar" className="flex flex-col gap-3">
          <label className="flex flex-col gap-2">
            {ACCOUNT_PAGE_TEXTS.excluirInstrucao}
            <input type="text" name={ACCOUNT_POLICY.confirmationField} autoComplete="off" maxLength={64} className="rounded border px-3 py-2" />
          </label>
          <button type="submit" className="rounded border px-4 py-2">
            {ACCOUNT_PAGE_TEXTS.excluirBotao}
          </button>
        </form>
      ) : (
        <p data-excluir="login-antigo">{ACCOUNT_PAGE_TEXTS.loginAntigo}</p>
      )}
      <a href="/conta/dados" className="underline">
        {ACCOUNT_PAGE_TEXTS.voltarDados}
      </a>
    </main>
  );
}
