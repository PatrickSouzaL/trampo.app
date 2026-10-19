// Único armazenamento da extensão: `storage.session` (memória, só contextos confiáveis por padrão).
// Nunca `storage.local`, que content scripts leem por padrão, e nunca `setAccessLevel`
// (ADR-001 §5.0.1, "Armazenamento"; threat-model T22). O lint da extensão barra os dois.
import { browser } from "wxt/browser";
import type { z } from "zod";

type SessionArea = Pick<typeof browser.storage.session, "get" | "set" | "remove">;

export interface SessionStore<S extends z.ZodType> {
  get(): Promise<z.output<S> | undefined>;
  set(value: z.input<S>): Promise<void>;
  remove(): Promise<void>;
}

/** Uma chave tipada. A leitura revalida com Zod: valor inválido é apagado e lido como ausente. */
export function sessionStore<S extends z.ZodType>(key: string, schema: S, area: SessionArea = browser.storage.session): SessionStore<S> {
  return {
    async get() {
      const stored: Record<string, unknown> = await area.get(key);
      if (!Object.hasOwn(stored, key)) return undefined;
      const parsed = schema.safeParse(stored[key]);
      if (parsed.success) return parsed.data;
      await area.remove(key);
      return undefined;
    },
    async set(value) {
      await area.set({ [key]: schema.parse(value) });
    },
    async remove() {
      await area.remove(key);
    },
  };
}
