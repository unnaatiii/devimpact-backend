import {
  looksLikeGithubLogin,
  parseNoreplyGithubLogin,
  resolveProfileKey,
} from "./commit-author";
import type { CommitData } from "./types";

/** null = no filtering */
export function buildAllowlistSet(logins: string[] | undefined | null): Set<string> | null {
  if (!logins?.length) return null;
  const s = new Set<string>();
  for (const l of logins) {
    const t = l.trim().toLowerCase();
    if (t) s.add(t);
  }
  return s.size > 0 ? s : null;
}

/** True if this commit should be included when an allowlist is active. */
export function commitMatchesAllowlist(commit: CommitData, allow: Set<string>): boolean {
  const author = commit.author ?? "";
  const email = commit.authorEmail;
  const key = resolveProfileKey(author, email).toLowerCase();
  if (allow.has(key)) return true;
  if (looksLikeGithubLogin(author) && allow.has(author.trim().toLowerCase())) return true;
  const n = parseNoreplyGithubLogin(email ?? "");
  if (n && allow.has(n.toLowerCase())) return true;
  return false;
}

export function loginMatchesAllowlist(login: string, allow: Set<string>): boolean {
  return allow.has(login.trim().toLowerCase());
}
