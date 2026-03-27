import { createHmac, timingSafeEqual } from "crypto";

export function verifyGitHubWebhookSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=") || !secret?.trim()) return false;
  const sig = signatureHeader.slice("sha256=".length);
  const expected = createHmac("sha256", secret.trim()).update(rawBody, "utf8").digest("hex");
  try {
    const a = Buffer.from(sig, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export type GitHubPushWebhookPayload = {
  zen?: string;
  hook_id?: number;
  organization?: { login?: string };
  repository?: { full_name?: string; name?: string };
  commits?: Array<{
    id: string;
    message?: string;
    timestamp?: string;
    author?: { username?: string; name?: string; email?: string };
  }>;
};

export function parseOrgLogin(payload: GitHubPushWebhookPayload): string | null {
  const o = payload.organization?.login?.trim();
  return o ? o.toLowerCase() : null;
}

export function parseRepositoryFullName(payload: GitHubPushWebhookPayload): string | null {
  const f = payload.repository?.full_name?.trim();
  return f || null;
}
