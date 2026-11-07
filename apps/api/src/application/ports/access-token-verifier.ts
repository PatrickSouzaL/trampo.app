// Verificação do access token do Supabase Auth (ADR-013 D1). A aplicação só conhece esta porta: o adapter
// com jose e o JWKS remoto fica em infrastructure/auth, e o hook que lê o header fica na presentation.

/** Quem fez a requisição, tirado de um token verificado. Nenhuma outra claim sai do adapter. */
export interface Principal {
  /** `sub` do token (UUID). É a ÚNICA fonte do dono dos dados (threat-model T10). */
  readonly userId: string;
  /** `session_id` do token (UUID), quando houver: base para a idade máxima de sessão do T9. */
  readonly sessionId: string | null;
}

/**
 * `iat` e `exp` do token verificado, em epoch de segundos, como vieram no JWT (o adapter já os conferiu). Fora do
 * `Principal` porque não dizem quem é o usuário: servem ao BFF para conferir `exp − iat` e descontar a idade do
 * token no `expiresIn` (ADR-004 D4, troca, passos 6 e 8; emenda do 07f no D6).
 */
export interface TokenLifetime {
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/**
 * - `token_invalido`: assinatura, algoritmo, `kid` ou claim (inclusive `amr` fora da lista) recusados → 401.
 * - `chaves_indisponiveis`: JWKS inacessível, vazio ou sem chave ES256 → 503 (threat-model T30).
 */
export type AccessTokenRejection = "token_invalido" | "chaves_indisponiveis";

export type AccessTokenVerification =
  | { readonly ok: true; readonly principal: Principal; readonly lifetime: TokenLifetime }
  | { readonly ok: false; readonly reason: AccessTokenRejection };

export interface AccessTokenVerifier {
  /** Nunca rejeita: toda falha vira `{ ok: false }` (falha fechado). */
  verify(token: string): Promise<AccessTokenVerification>;
  /**
   * Há chave pronta para verificar um token agora? Sem token (ADR-004 D6): o BFF pergunta ANTES de chamar o GoTrue,
   * para não consumir o refresh quando o JWKS está fora. Nunca rejeita: qualquer falha é `false`.
   */
  keysReady(): Promise<boolean>;
}
