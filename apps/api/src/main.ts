// Ponto de entrada: compõe a API a partir do ambiente, sobe o servidor e encerra limpo em SIGINT/SIGTERM.
// Toda a ligação (e a falha fechado do boot) está em composition/, que o teste de boot exercita.
import { composeProductionApp } from "./composition/production-app.js";

// Ambiente inválido, chave do Supabase que não é publishable, anel da pretensão ausente, LLM_PROVIDER_CHAIN fora da
// política ou credencial de um provedor da cadeia ausente derrubam o processo na subida, antes de abrir a porta.
// A cadeia é Groq → Workers AI → determinístico (HITL-028 1A, HITL-032 1A e 2A).
const { app, host, port } = composeProductionApp(process.env);

const shutdown = (signal: string): void => {
  app.log.info({ signal }, "encerrando");
  void app.close().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await app.listen({ host, port });
