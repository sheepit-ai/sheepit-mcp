/**
 * Fire-and-forget telemetry helper. Posts a single `$mcp_*` event to the
 * project's `/v1/ingest` endpoint after each tool invocation so the
 * GoaTech team can see how the MCP is being used / where it's failing.
 *
 * Hard rules:
 *   - NEVER throw. Telemetry failures cannot break the user's tool call.
 *   - NEVER block the response. Caller invokes without `await`; we hand
 *     back a promise that the runtime drains in the background.
 *   - Coarse properties only. Tool name, success, duration, error code.
 *     Never the user's actual arguments — that's PII territory and the
 *     user expects MCP traffic to stay between them and the API.
 *
 * Cost note: every event counts against the project's `events_ingested`
 * usage quota. For the early dogfooders we accept this; longer-term,
 * server-side `$`-prefixed events should be quota-exempt — tracked as
 * operational hardening.
 */

import type { ApiClient } from "./api-client.js";

/**
 * Whether the user has opted out of MCP telemetry. Honors two signals:
 *   - `DO_NOT_TRACK=1` — the cross-vendor consoledonottrack.com convention.
 *   - `SHEEPIT_TELEMETRY=0` / `=false` — Sheepit's own explicit switch.
 *
 * Read at CALL time (not module load) so a long-lived server / test that
 * mutates the env between invocations sees the change. Documented in
 * README.md → "Telemetry & opt-out".
 */
export function telemetryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DO_NOT_TRACK === "1") return true;
  const t = env.SHEEPIT_TELEMETRY?.toLowerCase();
  return t === "0" || t === "false";
}

export interface TrackEventInput {
  /** Event name. Must match `^\$?[a-z][a-z0-9_]{0,255}$` server-side. */
  event: string;
  properties: Record<string, unknown>;
  /** Source surface. Becomes `context.app.namespace` so dashboards can
   *  filter by surface (mcp / cli / web / ios). */
  namespace: string;
  /** Client version. Becomes `context.app.version` so we can correlate
   *  bug reports to specific builds. */
  version: string;
}

export function trackTelemetry(api: ApiClient, input: TrackEventInput): Promise<void> {
  // Opt-out short-circuit: no event leaves the process when the user set
  // DO_NOT_TRACK=1 or SHEEPIT_TELEMETRY=0/false. Checked here (the single
  // chokepoint every $mcp_* emit funnels through) so every call site —
  // tool_invoked, tools_listed, session_started, session_ended — is
  // covered without per-callsite guards.
  if (telemetryDisabled()) return Promise.resolve();

  const body = {
    batch: [
      {
        type: "track" as const,
        event: input.event,
        properties: input.properties,
        timestamp: new Date().toISOString(),
      },
    ],
    context: {
      app: { namespace: input.namespace, version: input.version },
    },
    sent_at: new Date().toISOString(),
  };
  return api
    .post<unknown>("/v1/ingest", body)
    .then(() => undefined)
    .catch(() => {
      // Telemetry must never break the user's flow. We swallow every
      // failure mode (network, 4xx quota, 5xx, malformed response) and
      // return resolved void. If telemetry is silently failing in
      // aggregate we'll notice via missing rows in events_raw.
      return undefined;
    });
}

/**
 * Classify an unknown error into a stable, low-cardinality enum so
 * dashboards can group failures usefully. The MCP api-client throws
 * `ApiError` (with `code`); other paths can throw plain Error / TypeError /
 * AbortError. Anything else collapses to "internal_error".
 */
export function classifyError(err: unknown): string {
  if (err === null || err === undefined) return "unknown";
  if (typeof err === "object" && err !== null) {
    const e = err as { name?: string; code?: string; status?: number };
    if (typeof e.code === "string" && e.code.length > 0) return e.code;
    if (typeof e.status === "number") return `http_${e.status}`;
    if (typeof e.name === "string" && e.name.length > 0) return e.name;
  }
  return "internal_error";
}
