// Raiz de composição da API (F1-API-04b; ADR-017 D7, ADR-018 D5 e D6). Lê o ambiente, monta cada adapter UMA vez
// no boot e entrega ao buildApp a rota POST /v1/analyze com os critérios do Supabase e as rotas GET e PUT
// /v1/criteria (F1-API-05, ADR-021 §4) com o MESMO CriteriaGuard. O main.ts só sobe a porta, pelo
// composeProductionApp (production-app.ts), que monta a cadeia de LLM do ambiente e chama esta função.
//
// Falha fechado no boot: ambiente da borda, do JWT ou do Redis inválido (ZodError), chave do Supabase que não é
// publishable (PostgrestClientConfigError) e anel da pretensão inválido ou ausente (SalaryKeyringConfigError)
// derrubam a subida antes de abrir a porta, assim como a lista de `amr` fora da política (AllowedAmrConfigError: método
// fora do ADR-004 D6, ou senha fora de NODE_ENV=test). Nenhuma mensagem repete valor de variável.
//
// BFF de autenticação (F1-API-07 07g, ADR-004 D4 a D8), também em falha fechada: `API_BEHIND_PROXY` ausente ou em
// contradição com o TRUST_PROXY já validado (BehindProxyConfigError), anel do refresh inválido
// (RefreshKeyringConfigError), idades fora da faixa (AuthSessionConfigError) e material de chave repetido entre o anel
// da pretensão e o do refresh (KeyringReuseError). O GotrueEgress (orçamento e *bulkhead*), o limitador local e a
// amostragem de log são um só por processo, compartilhados pelas três rotas.
//
// A extração por LLM é opcional AQUI (os testes de borda e de critérios sobem sem ela): sem adapters, a análise segue
// só pelo caminho determinístico, sem router e sem cache. Com adapters, entram o router (QuotaLedger em Redis e
// systemClock) e o JobFactsCache numa instância própria do cliente REST (CACHE_CLIENT_LIMITS). Em produção a cadeia é
// obrigatória: o composeProductionApp não sobe sem ela (Trilha L1).
import { JOB_TITLE_MAX_CHARS } from "@trampo/contracts/limits";
import { safeText, truncateCodePoints } from "@trampo/contracts/primitives";
import { z } from "zod";

import { EndSession } from "../application/auth/end-session.js";
import { ExchangeSession } from "../application/auth/exchange-session.js";
import { createGotrueEgress } from "../application/auth/gotrue-egress.js";
import { RefreshSession } from "../application/auth/refresh-session.js";
import type { AccessTokenVerifier } from "../application/ports/access-token-verifier.js";
import {
  AnalyzeJob,
  CriteriaGuard,
  DailyQuotaGuard,
  InMemoryProviderStateStore,
  JobFactsCache,
  LLM_OUTPUT_GUARD_VERSION,
  LlmProviderRouter,
  RateLimitGuard,
  extractorVersionTag,
  parseLlmProviderChain,
  type JobFactsExtractor,
  type Telemetry,
} from "../application/index.js";
import {
  DeterministicPreFilter,
  FactResolver,
  JOB_TEXT_NORMALIZER_VERSION,
  JobTextNormalizer,
  LLM_INPUT_MAX_CHARS,
  PreFilterRouter,
  RELEVANT_SECTION_SELECTOR_VERSION,
  RelevantSectionSelector,
  ReportComposer,
  ScoringEngine,
} from "../domain/index.js";
import { readAllowedAmr } from "../infrastructure/auth/allowed-amr-env.js";
import { readAuthSessionEnv, type AuthSessionConfig } from "../infrastructure/auth/auth-session-env.js";
import { createJoseAccessTokenVerifier } from "../infrastructure/auth/jose-access-token-verifier.js";
import { CACHE_CLIENT_LIMITS, createRedisJobFactsStore } from "../infrastructure/cache/redis-job-facts-store.js";
import { assertDisjointKeyrings } from "../infrastructure/crypto/aead-envelope.js";
import { createAeadRefreshSealer } from "../infrastructure/crypto/aead-refresh-sealer.js";
import { createHmacKeyPseudonymizer, type KeyPseudonymizer } from "../infrastructure/crypto/hmac-key-pseudonymizer.js";
import { nodeTextHasher } from "../infrastructure/crypto/node-text-hasher.js";
import { createSalaryCipher, parseSalaryKeyring } from "../infrastructure/crypto/salary-cipher.js";
import { cryptoIdGenerator } from "../infrastructure/ids/crypto-id-generator.js";
import { LimitsEnvSchema, type LimitsEnv } from "../infrastructure/limits/limits-env.js";
import { createRedisDailyQuota } from "../infrastructure/limits/redis-daily-quota.js";
import { createRedisQuotaLedger } from "../infrastructure/limits/redis-quota-ledger.js";
import { createRedisRateLimiter } from "../infrastructure/limits/redis-rate-limiter.js";
import { createSupabaseCriteriaRepository } from "../infrastructure/persistence/supabase-criteria-repository.js";
import { cryptoRandom } from "../infrastructure/random/crypto-random.js";
import { createUpstashRestClient, type RedisTransactions } from "../infrastructure/redis/upstash-rest-client.js";
import { createGotrueTokenClient } from "../infrastructure/supabase/gotrue-token-client.js";
import { createPostgrestUserClient } from "../infrastructure/supabase/postgrest-user-client.js";
import { InMemoryTelemetry } from "../infrastructure/telemetry/in-memory-telemetry.js";
import { systemClock } from "../infrastructure/time/system-clock.js";
import { buildApp, type BuildAppOptions } from "../presentation/build-app.js";
import { AuthEnvSchema } from "../presentation/edge/auth-env.js";
import { readApiBehindProxy } from "../presentation/edge/behind-proxy-env.js";
import { EdgeEnvSchema } from "../presentation/edge/edge-env.js";
import { createPreAuthLimiter } from "../presentation/edge/pre-auth-limit.js";
import { createAuthLogSampler } from "../presentation/logging/auth-log-sampler.js";
import type { AuthRouteOptions } from "../presentation/routes/auth.js";

const ServerEnvSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  ...EdgeEnvSchema.shape,
});

/**
 * Versão do prompt quando não há extrator. Só compõe a `extractorVersion` exigida pelo AnalyzeJob: sem extração,
 * ela nunca vai a um relatório nem a uma chave de cache.
 */
export const NO_EXTRACTOR_PROMPT_VERSION = "p0";

export interface LlmComposition {
  /** Um adapter por provedor da `LLM_PROVIDER_CHAIN` (o router recusa a cadeia que não casa). */
  readonly extractors: readonly JobFactsExtractor[];
  /** Versão do prompt do extrator (F1-LLM-01 parte 2), parte da `extractorVersionTag`. */
  readonly promptVersion: string;
}

export interface ComposeOptions {
  /** Sem a opção: análise só determinística (testes). Produção passa pelo composeProductionApp, que sempre a dá. */
  readonly llm?: LlmComposition;
  /** Só para os testes capturarem ou calarem o log. */
  readonly logger?: BuildAppOptions["logger"];
  /** Só para os testes lerem os contadores. Sem a opção, a telemetria em memória do processo (ADR-010 D6). */
  readonly telemetry?: Telemetry;
}

export type Environment = Readonly<Record<string, string | undefined>>;

export interface ComposedApp {
  readonly app: ReturnType<typeof buildApp>;
  readonly host: string;
  readonly port: number;
}

const titleSchema = safeText(JOB_TITLE_MAX_CHARS);

export function composeApp(source: Environment, options: ComposeOptions = {}): ComposedApp {
  const server = ServerEnvSchema.parse(source);
  const auth = AuthEnvSchema.parse(source);
  // Vale para toda rota protegida: só sessão de login social entra (ADR-004 D6, F1-API-07 07d).
  const allowedAmr = readAllowedAmr(source);
  // O limitador local das rotas públicas conta pelo `request.ip`: a declaração de proxy precisa concordar com o
  // TRUST_PROXY, senão o limite vira global atrás do proxy (ADR-004 D8 item 4). Só valida: o valor não muda nada.
  readApiBehindProxy(source, server.TRUST_PROXY);
  const authSession = readAuthSessionEnv(source);
  const salaryKeyring = parseSalaryKeyring(source["CRITERIA_SALARY_KEYS"] ?? "", source["CRITERIA_SALARY_ACTIVE_KEY"] ?? "");
  assertDisjointKeyrings(salaryKeyring, authSession.keyring);
  const limitsEnv = LimitsEnvSchema.parse(source);

  // Um relógio só, compartilhado pelos critérios, pelos limites e pela sessão do BFF.
  const now = (): number => Date.now();
  const supabaseOrigin = new URL("/", auth.issuer);
  const publishableKey = source["SUPABASE_PUBLISHABLE_KEY"] ?? "";

  // Critérios (ADR-018 D5 e D6): cliente de usuário só com a publishable, e o adapter sempre dentro do guarda.
  const criteria = new CriteriaGuard(
    createSupabaseCriteriaRepository({
      client: createPostgrestUserClient({ url: supabaseOrigin, publishableKey }),
      cipher: createSalaryCipher(salaryKeyring),
      now,
    }),
    systemClock,
  );

  // Instâncias de limite criadas uma vez e compartilhadas por todas as requisições (ADR-014 D8; T39).
  const limitsRedis = createUpstashRestClient({ url: limitsEnv.restUrl, token: limitsEnv.restToken });
  const pseudonymizer = createHmacKeyPseudonymizer(limitsEnv.pepper);
  const limitDeps = { redis: limitsRedis, pseudonymizer, now };

  // Um verificador só: o das rotas protegidas é o mesmo que confere o token do GoTrue antes de repassar (ADR-004 D6).
  const verifier = createJoseAccessTokenVerifier({ ...auth, allowedAmr });
  // Uma telemetria só por processo: a análise e o BFF de autenticação contam no mesmo lugar (ADR-010 D6; 07i).
  const telemetry = options.telemetry ?? new InMemoryTelemetry();
  const authRoutes = composeAuth({ verifier, supabaseOrigin, publishableKey, authSession, pseudonymizer, telemetry, now });

  const extractorVersion = extractorVersionTag({
    prompt: options.llm?.promptVersion ?? NO_EXTRACTOR_PROMPT_VERSION,
    normalizer: JOB_TEXT_NORMALIZER_VERSION,
    selector: RELEVANT_SECTION_SELECTOR_VERSION,
    guard: LLM_OUTPUT_GUARD_VERSION,
    budgetChars: LLM_INPUT_MAX_CHARS,
  });
  const llm = options.llm === undefined
    ? null
    : composeLlm({ llm: options.llm, chain: source["LLM_PROVIDER_CHAIN"], limitsEnv, limitsRedis, extractorVersion, now });

  const resolver = new FactResolver({ isSafeTitle: (value) => titleSchema.safeParse(value).success });
  const engine = new ScoringEngine();
  const job = new AnalyzeJob({
    normalizer: new JobTextNormalizer({ hasher: nodeTextHasher, truncateCodePoints }),
    selector: new RelevantSectionSelector({ truncateCodePoints }),
    preFilter: new DeterministicPreFilter(),
    // Política padrão do rt1: aceite antecipado desligado (D-H3).
    router: new PreFilterRouter({ resolver, engine }),
    resolver,
    engine,
    composer: new ReportComposer(),
    cache: llm?.cache ?? null,
    extraction: llm?.router ?? null,
    extractorVersion,
    telemetry,
    clock: systemClock,
    now,
    ids: cryptoIdGenerator,
  });

  const app = buildApp({
    accessTokenVerifier: verifier,
    limits: {
      rateLimit: new RateLimitGuard(createRedisRateLimiter(limitDeps), systemClock),
      dailyQuota: new DailyQuotaGuard(createRedisDailyQuota(limitDeps), systemClock),
    },
    corsAllowedOrigins: server.CORS_ALLOWED_ORIGINS,
    trustProxy: server.TRUST_PROXY,
    analysis: { job, criteria },
    // O mesmo guarda (prazo e revalidação) lê para a análise e lê e grava para o portal.
    criteria: { repository: criteria },
    auth: authRoutes,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  return { app, host: server.HOST, port: server.PORT };
}

interface AuthCompositionInput {
  readonly verifier: AccessTokenVerifier;
  readonly supabaseOrigin: URL;
  readonly publishableKey: string;
  readonly authSession: AuthSessionConfig;
  readonly pseudonymizer: KeyPseudonymizer;
  readonly telemetry: Telemetry;
  readonly now: () => number;
}

/**
 * O BFF de autenticação (ADR-004 D4): adapter do GoTrue só com a publishable e a URL fixa do projeto, selador do anel
 * próprio, um só GotrueEgress (orçamento e *bulkhead* por processo, D8 item 5) e os três casos de uso do 07f. O
 * limitador local usa o mesmo *pepper* do rate limit, só para pseudonimizar o balde (nenhum comando ao Redis).
 */
function composeAuth(input: AuthCompositionInput): AuthRouteOptions {
  const { verifier, now } = input;
  const gateway = createGotrueTokenClient({ url: input.supabaseOrigin, publishableKey: input.publishableKey });
  const sealer = createAeadRefreshSealer(input.authSession.keyring);
  const egress = createGotrueEgress(systemClock);
  const ages = { maxAgeSeconds: input.authSession.maxAgeSeconds, idleSeconds: input.authSession.idleSeconds };
  return {
    exchange: new ExchangeSession({ gateway, sealer, verifier, egress, now }),
    refresh: new RefreshSession({ gateway, sealer, verifier, egress, clock: systemClock, now, ages }),
    logout: new EndSession({ gateway, egress }),
    preAuthLimiter: createPreAuthLimiter(systemClock, input.pseudonymizer),
    logSampler: createAuthLogSampler(systemClock),
    telemetry: input.telemetry,
  };
}

interface LlmCompositionInput {
  readonly llm: LlmComposition;
  readonly chain: string | undefined;
  readonly limitsEnv: LimitsEnv;
  readonly limitsRedis: RedisTransactions;
  readonly extractorVersion: string;
  readonly now: () => number;
}

function composeLlm(input: LlmCompositionInput): { readonly router: LlmProviderRouter; readonly cache: JobFactsCache } {
  const { llm, limitsEnv, extractorVersion, now } = input;
  const router = new LlmProviderRouter({
    // Só os provedores de produção: o Ollama é de dev e nunca sobe por aqui.
    chain: parseLlmProviderChain(input.chain, { allowDevOnlyProviders: false }),
    extractors: llm.extractors,
    clock: systemClock,
    random: cryptoRandom,
    // O ledger divide a instância do cliente do rate limit: os mesmos tetos de contador (ADR-014 D6).
    ledger: createRedisQuotaLedger({ redis: input.limitsRedis, now }),
    states: new InMemoryProviderStateStore(),
  });
  // Instância própria do cliente REST, com strings e respostas maiores (ADR-015 D1).
  const cacheRedis = createUpstashRestClient({ url: limitsEnv.restUrl, token: limitsEnv.restToken, ...CACHE_CLIENT_LIMITS });
  const cache = new JobFactsCache({
    store: createRedisJobFactsStore(cacheRedis),
    clock: systemClock,
    now,
    extractorVersion,
    acceptedModels: llm.extractors.map(({ provider, model }) => ({ provider, model })),
  });
  return { router, cache };
}
