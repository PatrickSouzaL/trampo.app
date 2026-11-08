// Origens trocadas no build pelo `define` do wxt.config.ts (ADR-004 D15), já validadas lá; "" quando o build não
// as tem. Só o background.ts as lê, e a montagem do config é do src/auth/worker-auth.ts.
interface ImportMetaEnv {
  readonly TRAMPO_API_ORIGIN: string;
  readonly TRAMPO_SUPABASE_ORIGIN: string;
}
