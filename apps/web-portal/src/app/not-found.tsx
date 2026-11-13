// 404 dinâmico: página estática não recebe o nonce da CSP (documentação do Next 16.4.2, `content-security-policy.md`,
// "Forcing dynamic rendering"), e os scripts dela seriam bloqueados (ADR-027 D8).
import Link from "next/link";
import { connection } from "next/server";

export default async function NotFound() {
  await connection();
  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 px-6 py-16">
      <h1 className="text-2xl font-semibold">Página não encontrada</h1>
      <Link href="/" prefetch={false} className="underline">
        Voltar ao início
      </Link>
    </main>
  );
}
