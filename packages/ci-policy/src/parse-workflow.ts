// Leitura do YAML do workflow (ADR-019 D7). CORE_SCHEMA do YAML 1.2: `on` continua string (no 1.1
// viraria booleano) e nenhuma tag customizada é aceita. Chave duplicada lança.
import { CORE_SCHEMA, load } from "js-yaml";

export function parseWorkflow(text: string, filename: string): unknown {
  return load(text, { schema: CORE_SCHEMA, filename });
}
