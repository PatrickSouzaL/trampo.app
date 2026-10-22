// Ponto de entrada: compõe a API a partir do ambiente, sobe o servidor e encerra limpo em SIGINT/SIGTERM.
// Toda a ligação (e a falha fechado do boot) está em composition/compose-app.ts, que o teste de boot exercita.
import { composeApp } from "./composition/compose-app.js";

// Ambiente inválido, chave do Supabase que não é publishable ou anel da pretensão ausente derrubam o processo na
// subida, antes de abrir a porta. A extração por LLM entra com os adapters do F1-LLM-02.
const { app, host, port } = composeApp(process.env);

const shutdown = (signal: string): void => {
  app.log.info({ signal }, "encerrando");
  void app.close().then(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await app.listen({ host, port });
