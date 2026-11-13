import type { NextConfig } from "next";

import { SECURITY_HEADERS } from "./src/server/headers";

const nextConfig: NextConfig = {
  // Não gerar AGENTS.md: instruções para agentes são governança humana (HITL-011).
  agentRules: false,
  // `cacheComponents` (e o `partialPrefetching` que o acompanha) ficam desligados: o PPR é incompatível com a CSP com
  // nonce (documentação do Next 16.4.2, `content-security-policy.md`), e toda página do portal já é dinâmica (lê o
  // cookie). Religar exige outra estratégia de CSP e novo [APPSEC] (ADR-027 D8).
  poweredByHeader: false,
  // Os cabeçalhos fixos, uma vez cada, em todo caminho; a CSP com nonce vem do proxy (ADR-027 D8).
  async headers() {
    return [{ source: "/:path*", headers: [...SECURITY_HEADERS] }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
