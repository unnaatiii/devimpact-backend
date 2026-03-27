import { createHash } from "crypto";

/**
 * Stable per-installation user key derived from the GitHub PAT.
 * Server-only; never send raw PAT to the client in API responses.
 */
export function deriveUserIdFromToken(token: string, pepper: string): string {
  const t = token.trim();
  const p = pepper.trim();
  if (!t) throw new Error("empty token");
  if (!p) throw new Error("empty pepper");
  const h = createHash("sha256");
  h.update(p);
  h.update("\0");
  h.update(t);
  return `u_${h.digest("hex").slice(0, 40)}`;
}

export function tryDeriveUserIdFromToken(token: string | undefined | null): string | null {
  if (!token?.trim()) return null;
  const pepper = process.env.USER_ID_PEPPER?.trim();
  if (!pepper) return null;
  try {
    return deriveUserIdFromToken(token, pepper);
  } catch {
    return null;
  }
}
