/**
 * Reads OPENROUTER_API_KEY from process.env (Next.js loads `.env.local` + `.env` at build/dev).
 * Strips accidental quotes/whitespace so a malformed line in `.env.local` doesn’t break auth.
 */
export function getOpenRouterApiKey(): string | undefined {
  const raw = process.env.OPENROUTER_API_KEY;
  if (raw == null || typeof raw !== "string") return undefined;
  let v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  v = v.replace(/\s+/g, "");
  if (!v || v.length < 10) return undefined;
  return v;
}
