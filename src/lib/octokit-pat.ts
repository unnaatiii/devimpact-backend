/**
 * User-supplied PATs: trim whitespace, strip accidental "Bearer " prefix,
 * and use Authorization: Bearer for fine-grained tokens (github_pat_*).
 * Classic tokens keep the token scheme Octokit uses by default.
 */
import { Octokit } from "@octokit/rest";
import { RequestError } from "@octokit/request-error";

export type PatListedRepo = {
  owner: string;
  repo: string;
  fullName: string;
  description: string | null;
  private: boolean;
  htmlUrl: string;
  defaultBranch: string;
};

async function paginateReposForAffiliation(
  octokit: Octokit,
  affiliation: string,
): Promise<PatListedRepo[]> {
  const all: PatListedRepo[] = [];
  let page = 1;
  const perPage = 100;
  const maxPages = 15;
  while (page <= maxPages) {
    const { data } = await octokit.repos.listForAuthenticatedUser({
      affiliation,
      per_page: perPage,
      page,
      sort: "updated",
      direction: "desc",
    });
    for (const r of data) {
      const owner = r.owner?.login ?? "";
      if (!owner || !r.name) continue;
      all.push({
        owner,
        repo: r.name,
        fullName: r.full_name,
        description: r.description,
        private: r.private,
        htmlUrl: r.html_url,
        defaultBranch: r.default_branch ?? "main",
      });
    }
    if (data.length < perPage) break;
    page += 1;
  }
  return all;
}

/** List repos; on 403, retry without organization_member (some tokens/orgs reject that filter). */
export async function listReposForAuthenticatedUserPat(octokit: Octokit): Promise<PatListedRepo[]> {
  const tries = ["owner,collaborator,organization_member", "owner,collaborator"] as const;
  let last: unknown;
  for (const affiliation of tries) {
    try {
      return await paginateReposForAffiliation(octokit, affiliation);
    } catch (e) {
      last = e;
      if (e instanceof RequestError && e.status === 403 && affiliation !== tries[tries.length - 1]) {
        console.warn("[list-repos] retrying without organization_member affiliation…");
        continue;
      }
      throw e;
    }
  }
  throw last;
}

/** Trim and strip accidental `token ` / `Bearer ` prefix from pasted PATs. */
export function normalizeUserPat(raw: string): string {
  return raw.trim().replace(/^(?:token|bearer)\s+/i, "");
}

export function createOctokitForUserPat(rawToken: string): Octokit {
  const token = normalizeUserPat(rawToken);
  if (!token) {
    throw new Error("GitHub token is empty");
  }
  return new Octokit({
    authStrategy: (options: { token?: string } & Record<string, unknown>) => {
      const t = normalizeUserPat(String(options.token ?? token));
      const s = t.startsWith("github_pat_") ? "Bearer" : "token";
      async function auth() {
        return { type: "token" as const, token: t, tokenType: "oauth" as const };
      }
      return Object.assign(auth, {
        hook: async (request: any, route: unknown, parameters?: unknown) => {
          const endpoint = request.endpoint.merge(route as string, (parameters ?? {}) as Record<string, unknown>);
          endpoint.headers = {
            ...endpoint.headers,
            authorization: `${s} ${t}`,
          };
          return request(endpoint);
        },
      });
    },
    auth: { token },
  });
}

/** Map Octokit/GitHub errors to a safe client message and HTTP status. */
export function githubApiClientMessage(err: unknown): { httpStatus: number; message: string } {
  if (!(err instanceof RequestError)) {
    const msg = err instanceof Error ? err.message : "Request failed";
    return { httpStatus: 500, message: msg };
  }
  const status = err.status >= 400 && err.status < 600 ? err.status : 500;
  const data = err.response?.data as { message?: string } | undefined;
  const gh = typeof data?.message === "string" ? data.message.trim() : "";
  const hdrs = err.response?.headers as Record<string, string | undefined> | undefined;
  const sso = hdrs?.["x-github-sso"] ?? hdrs?.["X-GitHub-SSO"];
  const ssoHint =
    err.status === 403 && sso
      ? " If your organization uses SAML SSO, open your token on GitHub and click “Configure SSO” / authorize the organization."
      : "";

  if (err.status === 401) {
    return {
      httpStatus: 401,
      message:
        gh && !/^bad credentials/i.test(gh)
          ? gh
          : "Invalid or expired token — verify the PAT or create a new one.",
    };
  }
  if (err.status === 403) {
    const base =
      gh ||
      "Access denied — classic PATs need the repo scope (or public_repo for public repos only). Fine-grained tokens need repository access plus read permissions (e.g. Metadata, Contents) on those repos.";
    return { httpStatus: 403, message: base + ssoHint };
  }

  return { httpStatus: status, message: gh || err.message };
}
