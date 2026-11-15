// Página de confirmação do "Sair de todos os dispositivos" (ADR-027 §9.2): Server Component, sem JS próprio. A DAL
// verifica a sessão (sem renovar: o proxy já renovou) e, sem ela, manda para a página inicial. Abrir esta página nunca
// encerra nada: só o formulário dela posta em `POST /auth/sair-de-tudo`, e o escopo não vem de campo nenhum.
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { COOKIE_NAMES, readCookie } from "../../../server/cookies";
import { SESSION_STATE_HEADER } from "../../../server/edge";
import { LOGOUT_EVERYWHERE_TEXTS } from "../../../server/notices";
import { homeFor } from "../../../server/page-state";
import { getPortalAuth } from "../../../server/runtime";

export default async function SairDeTudo() {
  const requestHeaders = await headers();
  const session = await getPortalAuth().readSession(readCookie(requestHeaders.get("cookie"), COOKIE_NAMES.sessao));
  if (!session.ok) redirect(homeFor(requestHeaders.get(SESSION_STATE_HEADER)));

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">{LOGOUT_EVERYWHERE_TEXTS.titulo}</h1>
      <p data-sair-de-tudo="efeito">{LOGOUT_EVERYWHERE_TEXTS.efeito}</p>
      <p data-sair-de-tudo="prazo">{LOGOUT_EVERYWHERE_TEXTS.prazo}</p>
      <form method="post" action="/auth/sair-de-tudo">
        <button type="submit" className="rounded border px-4 py-2">
          {LOGOUT_EVERYWHERE_TEXTS.confirmar}
        </button>
      </form>
      <a href="/conta" className="underline">
        {LOGOUT_EVERYWHERE_TEXTS.voltar}
      </a>
    </main>
  );
}
