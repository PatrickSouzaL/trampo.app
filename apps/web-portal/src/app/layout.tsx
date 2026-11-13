// Layout raiz do portal. Sem fonte remota (a CSP só aceita `font-src 'self'`) e sem script próprio: o Next aplica o
// nonce da CSP do pedido aos scripts dele (ADR-027 D8).
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trampo",
  description: "Portal do Trampo",
  referrer: "no-referrer",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="pt-BR" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
