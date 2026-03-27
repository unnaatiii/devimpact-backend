/** Extract GitHub username from users.noreply.github.com addresses */
export function parseNoreplyGithubLogin(email: string | undefined | null): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  const withId = /^(\d+)\+([a-z0-9-]+)@users\.noreply\.github\.com$/i.exec(e);
  if (withId) return withId[2];
  const plain = /^([a-z0-9-]+)@users\.noreply\.github\.com$/i.exec(e);
  if (plain) return plain[1];
  return null;
}

const GENERIC_AUTHOR_NAMES =
  /^(mac|macbook|macbookpro|admin|administrator|user|root|localhost|default|unknown|developer|hostname|desktop|laptop|pc)$/i;

/** Machine / placeholder git user.name values — not a real GitHub identity */
export function isGenericGitDisplayName(s: string): boolean {
  return !s || GENERIC_AUTHOR_NAMES.test(s.trim());
}

function stableHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).padStart(7, "0").slice(0, 12);
}

/** Derive a stable handle from a normal (non-noreply) email when GitHub login is unknown */
function loginFromEmailHandle(email: string): string {
  const lower = email.trim().toLowerCase();
  const at = lower.indexOf("@");
  if (at <= 0) return `u${stableHash(lower)}`;
  let local = lower.slice(0, at).split("+")[0];
  local = local.replace(/\./g, "-").replace(/[^a-z0-9_-]/g, "");
  if (local.length < 2 || GENERIC_AUTHOR_NAMES.test(local)) {
    return `u${stableHash(lower)}`;
  }
  return local.length > 39 ? local.slice(0, 39) : local;
}

function displayNameToSlug(name: string): string | null {
  const slug = name
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join("-")
    .replace(/[^a-z0-9-]/g, "");
  if (slug.length < 2 || slug.length > 39) return null;
  if (GENERIC_AUTHOR_NAMES.test(slug)) return null;
  return slug;
}

/**
 * Map alternate GitHub / email-derived handles onto one profile (org-specific).
 * Keys must be lowercase; values are the canonical login / display id used in the app.
 */
const CONTRIBUTOR_CANONICAL_LOGIN: Record<string, string> = {
  /** Misattributed commits — real owner */
  rahulrameshm0: "raulk-09",
  /** Email-hash style handles → real names (see contributorDisplayLabel) */
  u0egoyg3: "joel",
};

/** Pretty names for canonical keys that are not GitHub usernames */
const CONTRIBUTOR_DISPLAY_LABEL: Record<string, string> = {
  joel: "JOEL",
};

/** Prefer ui-avatars with a real name — avoids wrong github.com/{login}.png */
const USE_UI_AVATAR_FOR_CANONICAL = new Set(["joel"]);

/**
 * Merge alias handles into the canonical profile key (for leaderboard grouping).
 */
export function canonicalizeContributorKey(key: string): string {
  if (!key || key === "unknown") return key;
  const mapped = CONTRIBUTOR_CANONICAL_LOGIN[key.trim().toLowerCase()];
  return mapped ?? key;
}

/**
 * True if a commit-derived profile key matches any GitHub `repos/listContributors` login
 * (handles canonical aliases, e.g. API returns u0egoyg3 but profile key is joel).
 */
export function profileKeyMatchesContributorLogin(
  profileKey: string,
  contributorLoginsLowercase: Set<string>,
): boolean {
  const pk = profileKey.trim().toLowerCase();
  if (contributorLoginsLowercase.has(pk)) return true;
  for (const gh of contributorLoginsLowercase) {
    if (canonicalizeContributorKey(gh) === pk) return true;
  }
  return false;
}

/** Resolve a single GitHub login against commit-derived profile keys (aliases / canonicalization). */
export function developerProfileForGraphLogin(
  developers: { login: string }[],
  graphLogin: string,
): { login: string } | undefined {
  const one = new Set([graphLogin.trim().toLowerCase()]);
  return developers.find((d) => profileKeyMatchesContributorLogin(d.login, one));
}

/** Card / chart label; falls back to login */
export function contributorDisplayLabel(login: string): string {
  return CONTRIBUTOR_DISPLAY_LABEL[login.trim().toLowerCase()] ?? login;
}

function resolveProfileKeyRaw(author: string, authorEmail?: string | null): string {
  const a = (author || "").trim();
  const em = normalizeAuthorEmail(authorEmail);

  if (em) {
    const nr = parseNoreplyGithubLogin(em);
    if (nr) return nr;
  }

  if (a && looksLikeGithubLogin(a)) return a;

  if (em) return loginFromEmailHandle(em);

  if (a && !isGenericGitDisplayName(a)) {
    const slug = displayNameToSlug(a);
    if (slug) return slug;
  }

  return "unknown";
}

/**
 * Single stable id for leaderboard grouping. Never uses generic host names (e.g. "MAC") as the key.
 * Order: noreply GitHub login → real-looking git author as login → email-derived handle → display-name slug.
 * Then applies {@link canonicalizeContributorKey} for org-specific merges.
 */
export function resolveProfileKey(author: string, authorEmail?: string | null): string {
  const raw = resolveProfileKeyRaw(author, authorEmail);
  if (raw === "unknown") return raw;
  return canonicalizeContributorKey(raw);
}

/** True if this profile key should appear on the developer leaderboard (real or email-resolved person). */
export function isResolvableContributorKey(key: string): boolean {
  return key !== "unknown" && key.length >= 2;
}

/** True if string looks like a GitHub login (not a display name like "Jane Doe") */
export function looksLikeGithubLogin(s: string): boolean {
  if (!s || s.length < 2 || s.length > 39) return false;
  if (GENERIC_AUTHOR_NAMES.test(s.trim())) return false;
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9]))*$/.test(s.trim());
}

export function normalizeAuthorEmail(email: string | undefined | null): string | null {
  if (!email) return null;
  const t = email.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

/** Keys we synthesized from email hash (not a real GitHub username) */
function isEmailHashHandle(key: string): boolean {
  return /^u[a-z0-9]{6,14}$/i.test(key);
}

/** Avatar: GitHub CDN only when the key is a plausible GitHub username */
export function contributorAvatarUrl(profileKey: string): string {
  const lower = profileKey.trim().toLowerCase();
  if (USE_UI_AVATAR_FOR_CANONICAL.has(lower)) {
    const name = CONTRIBUTOR_DISPLAY_LABEL[lower] ?? profileKey;
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&size=128&background=6366f1&color=e5e7eb`;
  }
  if (looksLikeGithubLogin(profileKey) && !isEmailHashHandle(profileKey)) {
    return `https://github.com/${profileKey}.png`;
  }
  const label = encodeURIComponent(profileKey.slice(0, 40));
  return `https://ui-avatars.com/api/?name=${label}&size=128&background=1f2937&color=e5e7eb`;
}
