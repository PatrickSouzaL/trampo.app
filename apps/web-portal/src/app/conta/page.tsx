// Área logada (ADR-027 D5): a DAL verifica o access a cada pedido e nunca confia no cookie nem no estado do proxy.
// Nesta trilha só mostra que há sessão e o "Sair" (POST, ADR-027 D7); nenhum e-mail ou nome vai à tela (D12).
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { COOKIE_NAMES, readCookie } from "../../server/cookies";
import { SESSION_STATE_HEADER } from "../../server/edge";
import { homeFor } from "../../server/page-state";
import { getPortalAuth } from "../../server/runtime";

export default async function Conta() {
  const requestHeaders = await headers();
  const session = await getPortalAuth().readSession(readCookie(requestHeaders.get("cookie"), COOKIE_NAMES.sessao));
  if (!session.ok) redirect(homeFor(requestHeaders.get(SESSION_STATE_HEADER)));

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">Sua conta</h1>
      <p data-sessao="ativa">Você está conectado.</p>
      <form method="post" action="/auth/sair">
        <button type="submit" className="rounded border px-4 py-2">
          Sair
        </button>
      </form>
    </main>
  );
}
