// Verificadores falsos para os testes da presentation (ADR-013 D1): o buildApp exige um verificador explícito.
// O adapter real (jose + JWKS) é testado em test/infrastructure, contra um JWKS local.
import type {
  AccessTokenVerification,
  AccessTokenVerifier,
  Principal,
} from "../src/application/ports/access-token-verifier.js";

export const TEST_PRINCIPAL: Principal = {
  userId: "6f0c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f",
  sessionId: "0b1c2d3e-4f50-4a6b-9c7d-8e9fa0b1c2d3",
};

/** Token de forma válida (três partes base64url). Só o fake o aceita. */
export const TEST_TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ0ZXN0ZSJ9.c2lnbmF0dXJh";
export const TEST_AUTHORIZATION = `Bearer ${TEST_TOKEN}`;

/**
 * Verificador que registra os tokens recebidos e responde o resultado configurado. `keysReady` responde `true`
 * (ninguém na presentation o chama: é do BFF, ADR-004 D6).
 */
export function fakeVerifier(result: AccessTokenVerification = { ok: true, principal: TEST_PRINCIPAL }) {
  const calls: string[] = [];
  const verifier: AccessTokenVerifier = {
    async verify(token) {
      calls.push(token);
      return result;
    },
    keysReady: async () => true,
  };
  return { verifier, calls };
}

/** Aceita qualquer token de forma válida: para os testes de borda que não tratam de autenticação. */
export const acceptAll: AccessTokenVerifier = fakeVerifier().verifier;
