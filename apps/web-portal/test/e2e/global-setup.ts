// Pré-condições do E2E do portal (ADR-027 §7). A pilha sobe em cada arquivo (`support/stack.ts`), porque o portal lê a
// configuração em tempo de execução e o teste controla o GoTrue simulado direto. Aqui só se confere:
// - o build existe e é mais novo que todo arquivo de `src/` e o `next.config.ts`. Depois de uma rodada de mutação, o
//   `.next` pode ter o último mutante (cuidado 33 do TRILHAS), e a restauração deixa a fonte mais nova que o build;
// - o navegador do sistema existe (nenhum download).
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { APP, browserPath } from "./support/stack";

export default function setup(): void {
  const buildId = join(APP, ".next", "BUILD_ID");
  if (!existsSync(buildId)) throw new Error("rode o build do portal antes do E2E: pnpm --filter @trampo/web-portal build");
  const built = statSync(buildId).mtimeMs;
  const sources = [
    join(APP, "next.config.ts"),
    ...readdirSync(join(APP, "src"), { recursive: true, encoding: "utf8" }).map((name) => join(APP, "src", name)),
  ];
  const stale = sources.filter((path) => statSync(path).isFile() && statSync(path).mtimeMs > built);
  if (stale.length > 0) throw new Error(`o build do portal é mais velho que ${stale.length} arquivo(s) da fonte: reconstrua antes do E2E`);
  if (browserPath === undefined || !existsSync(browserPath)) throw new Error("navegador não encontrado: defina TRAMPO_E2E_BROWSER com o caminho do Edge ou do Chrome");
}
