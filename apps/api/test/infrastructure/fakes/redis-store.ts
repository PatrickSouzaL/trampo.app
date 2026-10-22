// Redis simulado (ADR-014 §4): interpreta, de forma síncrona e atômica, só os comandos que os adapters usam,
// com a semântica do Redis (inclusive WRONGTYPE). Nenhum teste fala com o Upstash real.
import type { RedisCommand, RedisTransactions, RedisValue } from "../../../src/infrastructure/redis/upstash-rest-client.js";

export type RedisItem = { readonly result: RedisValue } | { readonly error: string };

export class RedisStore {
  readonly values = new Map<string, string | Set<string>>();
  /** TTL em ms do último EXPIRE/PEXPIRE de cada chave (o simulado não expira sozinho: o relógio é do teste). */
  readonly ttlMs = new Map<string, number>();

  apply(command: readonly unknown[]): RedisItem {
    const [name, key, arg] = command.map(String);
    const current = key === undefined ? undefined : this.values.get(key);
    const asString = (): number | null => {
      if (current === undefined) return 0;
      return typeof current === "string" ? Number(current) : null;
    };
    const asSet = (): Set<string> | null => {
      if (current === undefined) return new Set();
      return current instanceof Set ? current : null;
    };
    const wrongType = { error: "WRONGTYPE Operation against a key holding the wrong kind of value" };
    if (key === undefined) return { error: "ERR wrong number of arguments" };

    switch (name) {
      case "INCR":
      case "INCRBY":
      case "DECR": {
        const value = asString();
        if (value === null) return wrongType;
        const delta = name === "INCR" ? 1 : name === "DECR" ? -1 : Number(arg);
        const next = value + delta;
        this.values.set(key, String(next));
        return { result: next };
      }
      case "GET": {
        if (current instanceof Set) return wrongType;
        return { result: current ?? null };
      }
      case "PEXPIRE":
      case "EXPIRE": {
        if (current === undefined) return { result: 0 };
        this.ttlMs.set(key, name === "EXPIRE" ? Number(arg) * 1_000 : Number(arg));
        return { result: 1 };
      }
      case "SADD":
      case "SREM": {
        const set = asSet();
        if (set === null) return wrongType;
        const member = String(arg);
        const had = set.has(member);
        if (name === "SADD") set.add(member);
        else set.delete(member);
        if (set.size > 0) this.values.set(key, set);
        else this.values.delete(key);
        return { result: name === "SADD" ? (had ? 0 : 1) : had ? 1 : 0 };
      }
      case "SCARD": {
        const set = asSet();
        return set === null ? wrongType : { result: set.size };
      }
      default:
        return { error: `ERR unknown command '${name}'` };
    }
  }

  /** Aplica a transação inteira, como o MULTI/EXEC do Upstash: um erro não para os outros comandos. */
  transaction(commands: readonly (readonly unknown[])[]): RedisItem[] {
    return commands.map((command) => this.apply(command));
  }

  counter(key: string): number {
    const value = this.values.get(key);
    return typeof value === "string" ? Number(value) : 0;
  }

  members(key: string): number {
    const value = this.values.get(key);
    return value instanceof Set ? value.size : 0;
  }
}

/** Como o RedisTransactions responde: normal, nulo, exceção, rejeição, travado ou com as respostas alteradas. */
export type MemoryMode =
  | { readonly kind: "normal" }
  | { readonly kind: "nulo" | "lanca" | "rejeita" | "trava" }
  | { readonly kind: "altera"; readonly change: (replies: RedisValue[]) => unknown[] };

/** RedisTransactions em memória, para os testes dos adapters sem socket. Registra TODO comando recebido. */
export function memoryRedis(store = new RedisStore()) {
  const log: RedisCommand[][] = [];
  const signals: AbortSignal[] = [];
  const state: { mode: MemoryMode; modeAfter: MemoryMode | null } = { mode: { kind: "normal" }, modeAfter: null };
  const redis: RedisTransactions = {
    exec(commands, signal) {
      log.push([...commands]);
      signals.push(signal);
      const mode = state.mode;
      if (state.modeAfter !== null) state.mode = state.modeAfter;
      switch (mode.kind) {
        case "nulo":
          return Promise.resolve(null);
        case "lanca":
          throw new Error("redis fora do ar");
        case "rejeita":
          return Promise.reject(new Error("redis fora do ar"));
        case "trava":
          return new Promise(() => undefined);
        default: {
          const items = store.transaction(commands);
          if (items.some((item) => "error" in item)) return Promise.resolve(null);
          const replies = items.map((item) => ("result" in item ? item.result : null));
          return Promise.resolve(mode.kind === "altera" ? (mode.change(replies) as RedisValue[]) : replies);
        }
      }
    },
  };
  /** Troca o modo a partir da próxima chamada; `then`, se dado, vale depois dela. */
  const setMode = (mode: MemoryMode, then: MemoryMode | null = null): void => {
    state.mode = mode;
    state.modeAfter = then;
  };
  return { redis, store, log, signals, setMode };
}

/** Todos os argumentos de todos os comandos, em texto (para o SR-17). */
export function allArguments(log: readonly (readonly RedisCommand[])[]): string[] {
  return log.flat(2).map((value) => String(value).toLowerCase());
}

/** O `sub` e o IP não podem aparecer em nenhum argumento, nem o `sub` sem hífens (SR-17, T23 item 6). */
export function plainIdentifierLeaks(log: readonly (readonly RedisCommand[])[], identifiers: readonly string[]): string[] {
  const forms = identifiers.flatMap((id) => [id.toLowerCase(), id.toLowerCase().replaceAll("-", "")]);
  return allArguments(log).filter((arg) => forms.some((form) => arg.includes(form)));
}
