// Selagem do refresh do Supabase num envelope que só a API abre (ADR-004 D5). A aplicação só conhece esta porta: o
// adapter AEAD fica em infrastructure/crypto. O refresh cru nunca sai da API; a extensão guarda só o envelope.

/** O texto claro do envelope. Epochs em segundos, pelo relógio da API. */
export interface SealedSession {
  /** O refresh do Supabase, cru. */
  readonly rt: string;
  /** `session_id` do access token (UUID): a renovação recusa um token de outra sessão. */
  readonly sid: string;
  /** Início da sessão no BFF: base da idade máxima. Não muda nas renovações. */
  readonly sst: number;
  /** Momento da selagem (última troca ou renovação): base da inatividade. */
  readonly iat: number;
}

/** `ok: false` na selagem é sessão fora da política (ex.: texto claro acima do teto): 503, nunca 500. */
export type RefreshSealResult = { readonly ok: true; readonly envelope: string } | { readonly ok: false };

export type RefreshOpenResult = { readonly ok: true; readonly session: SealedSession } | { readonly ok: false };

export interface RefreshSealer {
  /** Nunca lança. O `origin` (header `Origin` da extensão) entra no AAD. */
  seal(session: SealedSession, origin: string): RefreshSealResult;
  /** Nunca lança: forjado, adulterado, kid desconhecido ou outra origem → `ok: false` (401 sem chamar o GoTrue). */
  open(envelope: string, origin: string): RefreshOpenResult;
}
