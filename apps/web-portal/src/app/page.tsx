// Página inicial (ADR-027 D2 e D7): os dois botões de entrada e o aviso do catálogo fechado. Server Component, sem
// JS de cliente; o texto vem só do catálogo.
import { headers } from "next/headers";

import { COOKIE_NAMES, readCookie } from "../server/cookies";
import { SESSION_STATE_HEADER } from "../server/edge";
import { NOTICES } from "../server/notices";
import { noticeFor } from "../server/page-state";
import { getPortalAuth } from "../server/runtime";

export default async function Home({ searchParams }: PageProps<"/">) {
  const requestHeaders = await headers();
  const notice = noticeFor((await searchParams)["aviso"], requestHeaders.get(SESSION_STATE_HEADER));
  const session = await getPortalAuth().readSession(readCookie(requestHeaders.get("cookie"), COOKIE_NAMES.sessao));

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">Trampo</h1>
      {notice === null ? null : (
        <p role="status" data-aviso={notice} className="rounded border px-3 py-2">
          {NOTICES[notice]}
        </p>
      )}
      {session.ok ? (
        <a href="/conta" className="underline">
          Ir para a sua conta
        </a>
      ) : (
        <ul className="flex flex-col gap-3">
          <li>
            <a href="/auth/entrar?provedor=google" className="block rounded border px-4 py-2 text-center">
              Entrar com Google
            </a>
          </li>
          <li>
            <a href="/auth/entrar?provedor=github" className="block rounded border px-4 py-2 text-center">
              Entrar com GitHub
            </a>
          </li>
        </ul>
      )}
    </main>
  );
}
