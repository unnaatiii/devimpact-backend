import type { RepoConfig } from "./types";

/**
 * Cached logins from GitHub `repos/listCollaborators` (current repo access).
 */
export const ACTIVE_COLLABORATORS_STORAGE_KEY = "devimpact-active-collaborators-cache";

/**
 * Cached logins from GitHub `repos/listContributors` (Insights contributors graph / default branch).
 */
export const GRAPH_CONTRIBUTORS_STORAGE_KEY = "devimpact-graph-contributors-cache";

/** @deprecated Legacy key; cleared on sign-out. */
const LEGACY_CONTRIBUTORS_STORAGE_KEY = "devimpact-active-contributors-cache";

type CacheEntry = {
  fingerprint: string;
  logins: string[];
};

/** Minimal row for lifetime list ordering (from GitHub listContributors). */
export type CachedGraphContributorRow = {
  login: string;
  avatar_url: string;
  contributions: number;
};

type GraphCacheEntry = CacheEntry & {
  members?: CachedGraphContributorRow[];
};

export function fingerprintForRepos(repos: RepoConfig[]): string {
  return [...repos]
    .map((r) => `${r.owner.trim()}/${r.repo.trim()}`)
    .sort()
    .join("\0");
}

export function readCachedActiveCollaboratorLogins(repos: RepoConfig[]): string[] | null {
  if (typeof window === "undefined" || repos.length === 0) return null;
  const fp = fingerprintForRepos(repos);
  try {
    const raw = sessionStorage.getItem(ACTIVE_COLLABORATORS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (parsed?.fingerprint === fp && Array.isArray(parsed.logins)) {
      return parsed.logins;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function writeCachedActiveCollaboratorLogins(repos: RepoConfig[], logins: string[]): void {
  if (typeof window === "undefined" || repos.length === 0) return;
  try {
    const entry: CacheEntry = {
      fingerprint: fingerprintForRepos(repos),
      logins: [...new Set(logins.map((l) => l.trim().toLowerCase()))],
    };
    sessionStorage.setItem(ACTIVE_COLLABORATORS_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    /* quota */
  }
}

export function readCachedGraphContributorLogins(repos: RepoConfig[]): string[] | null {
  const full = readCachedGraphContributors(repos);
  return full?.logins ?? null;
}

/** Logins plus optional GitHub rows (contributions order) for lifetime view. */
export function readCachedGraphContributors(repos: RepoConfig[]): {
  logins: string[];
  members: CachedGraphContributorRow[] | null;
} | null {
  if (typeof window === "undefined" || repos.length === 0) return null;
  const fp = fingerprintForRepos(repos);
  try {
    const raw = sessionStorage.getItem(GRAPH_CONTRIBUTORS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GraphCacheEntry;
    if (parsed?.fingerprint === fp && Array.isArray(parsed.logins)) {
      const members =
        Array.isArray(parsed.members) && parsed.members.length > 0
          ? parsed.members.map((m) => ({
              login: String(m.login ?? ""),
              avatar_url: String(m.avatar_url ?? ""),
              contributions: Number(m.contributions) || 0,
            }))
          : null;
      return { logins: parsed.logins, members };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function writeCachedGraphContributorLogins(
  repos: RepoConfig[],
  logins: string[],
  members?: CachedGraphContributorRow[],
): void {
  if (typeof window === "undefined" || repos.length === 0) return;
  try {
    const entry: GraphCacheEntry = {
      fingerprint: fingerprintForRepos(repos),
      logins: [...new Set(logins.map((l) => l.trim().toLowerCase()))],
      members:
        members && members.length > 0
          ? members.map((m) => ({
              login: m.login.trim(),
              avatar_url: m.avatar_url?.trim() || `https://github.com/${m.login}.png`,
              contributions: m.contributions ?? 0,
            }))
          : undefined,
    };
    sessionStorage.setItem(GRAPH_CONTRIBUTORS_STORAGE_KEY, JSON.stringify(entry));
  } catch {
    /* quota */
  }
}

export function clearActiveContributorsCache(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(ACTIVE_COLLABORATORS_STORAGE_KEY);
    sessionStorage.removeItem(GRAPH_CONTRIBUTORS_STORAGE_KEY);
    sessionStorage.removeItem(LEGACY_CONTRIBUTORS_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
