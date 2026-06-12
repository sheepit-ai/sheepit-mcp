/**
 * Thin HTTP client for the Sheepit API. Every MCP tool funnels through
 * here so error shaping + auth header injection lives in one place.
 *
 * On 4xx / 5xx the server responds with `{ error: { code, message } }`;
 * we normalise that into an `ApiError` so tool handlers can re-raise a
 * crisp message that the LLM can read and explain to the user.
 */

import type { ResolvedCredential } from "./credentials.js";
import { VERSION } from "../generated/build-meta.js";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * Given an API error's HTTP status + code, return a one-line recovery
 * hint naming the next action the LLM (or its user) should take.
 * Returns "" when no hint applies — caller renders the bare status+code
 * in that case.
 *
 * Hint hierarchy: status-code first (the easy 401/403/503/5xx cases),
 * then specific `code` enums (UNKNOWN_CONNECTOR points the LLM at
 * `destination_catalog`; VALIDATION_ERROR shouldn't surface here because
 * Zod runs first at the boundary, but defended).
 */
export function recoveryHint(status: number, code: string): string {
  if (status === 401) {
    return "Hint: run `sheepit login` to re-authenticate, or set SHEEPIT_API_KEY.";
  }
  if (status === 403) {
    return "Hint: the current key lacks the role / scope this call needs — try a key with `admin` scope, or contact a project admin.";
  }
  if (status === 503) {
    return "Hint: the platform is degraded — retry shortly. If this persists, call `feedback_submit` to flag the outage.";
  }
  if (status === 400 && code === "UNKNOWN_CONNECTOR") {
    return "Hint: call `destination_catalog` to see the list of supported connector_ids.";
  }
  if (status === 429) {
    return "Hint: rate limit hit — back off and retry; respect `Retry-After` if present.";
  }
  if (status >= 500) {
    return "Hint: server-side failure — safe to retry once. If it persists, call `feedback_submit` to capture the failure.";
  }
  return "";
}

export interface ApiClient {
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  delete(path: string): Promise<void>;
}

export function createApiClient(creds: ResolvedCredential): ApiClient {
  // VERSION comes from `src/generated/build-meta.ts` (written by the
  // `prebuild` script before any other compile step). Pre-PR #345 we
  // read `process.env.npm_package_version`, which is undefined under
  // `node dist/index.js` (the standard bin entry-point) — so every
  // production invocation reported `sheepit-mcp/0.1.0` regardless of
  // actual version. MCP audit M9.
  const baseHeaders: Record<string, string> = {
    authorization: `Bearer ${creds.apiKey}`,
    "user-agent": `sheepit-mcp/${VERSION} node/${process.version} ${process.platform}`,
  };

  function buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>) {
    const u = new URL(path, creds.apiUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = buildUrl(path, query);
    // Only send content-type when there's a body — Fastify rejects
    // empty-body requests with `content-type: application/json` set
    // (FST_ERR_CTP_EMPTY_JSON_BODY → 400). Bit us on dashboard_delete /
    // destination_delete / campaign_archive in prod even though every
    // unit test passed against a mocked api-client.
    const headers =
      body !== undefined ? { ...baseHeaders, "content-type": "application/json" } : baseHeaders;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ApiError(
        0,
        "NETWORK_ERROR",
        `Network error reaching ${creds.apiUrl}: ${(err as Error).message}`,
      );
    }

    if (resp.status === 204) {
      return undefined as T;
    }

    let parsed: unknown;
    const text = await resp.text();
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw new ApiError(
        resp.status,
        "INVALID_JSON",
        `API returned non-JSON: ${text.slice(0, 200)}`,
      );
    }

    if (!resp.ok) {
      const errBody = parsed as { error?: { code?: string; message?: string } } & Record<
        string,
        unknown
      >;
      const code = errBody.error?.code ?? "UNKNOWN";
      const msg = errBody.error?.message ?? `HTTP ${resp.status}`;
      const extra = { ...errBody };
      delete (extra as { error?: unknown }).error;
      throw new ApiError(resp.status, code, msg, extra as Record<string, unknown>);
    }

    return parsed as T;
  }

  return {
    get: (path, query) => request("GET", path, undefined, query),
    post: (path, body) => request("POST", path, body),
    patch: (path, body) => request("PATCH", path, body),
    delete: (path) => request("DELETE", path).then(() => undefined),
  };
}
