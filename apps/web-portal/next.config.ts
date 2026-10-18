import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Não gerar AGENTS.md: instruções para agentes são governança humana (HITL-011).
  agentRules: false,
  cacheComponents: true,
  partialPrefetching: true,
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
