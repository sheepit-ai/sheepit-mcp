/**
 * Release-verdict MCP tools — first-class demo path for release intelligence.
 *
 * Three tools surface pre-computed server verdicts so the LLM can narrate
 * them without recomputing math. GoaTech runs ZERO server-side LLM/ML —
 * the health_score/health_status on each tool result is computed by
 * computeHealthScore() on the API side and written to the Release row +
 * ReleaseHealthSnapshot. These tools wrap:
 *
 *   release_list       → GET /v1/releases
 *   release_health     → GET /v1/releases/:id/health + GET /v1/releases/:id (parallel)
 *   release_regressions → GET /v1/releases/regressions
 *
 * Sanitised fields (tool-poisoning vectors):
 *   release.version, release.pr_title, release.branch — customer-controlled
 *   regression.version, regression.change_entity_key — flag/entity key
 *
 * Reference: packages/mcp/src/lib/untrust.ts for the sanitise + wrap pattern.
 */

import { z } from "zod";
import type { ApiClient } from "../lib/api-client.js";
import { wrapUntrusted, sanitizeUntrustedFields } from "../lib/untrust.js";
import { type Tool, defineTool } from "./define.js";

// ── Tool-poisoning vector fields ────────────────────────────────────────────
// Fields that customers control and that round-trip through the LLM channel.
const RELEASE_UNTRUSTED_FIELDS = ["version", "pr_title", "branch"];
const RELEASE_LIST_UNTRUSTED_FIELDS = RELEASE_UNTRUSTED_FIELDS.map((f) => `*.${f}`);
// change_at and change_event_id are customer-emitted ($change_regression event_properties)
// and must be treated as untrusted even though the API Zod tightens them to datetime/uuid.
// Defense-in-depth: the MCP layer sanitises regardless of whether the API validated.
const REGRESSION_UNTRUSTED_FIELDS = [
  "regressions.*.version",
  "regressions.*.change_entity_key",
  "regressions.*.change_at",
  "regressions.*.change_event_id",
];

// ── Response envelope shapes ────────────────────────────────────────────────

interface ReleaseItem {
  id: string;
  version: string;
  platform: string;
  channel: string;
  status: string;
  rollout_pct: number;
  health_status: string | null;
  health_score: number | null;
  crash_free_rate: number | null;
  error_rate: number | null;
  p50_latency_ms: number | null;
  p99_latency_ms: number | null;
  commit_sha: string | null;
  pr_number: number | null;
  pr_title: string | null;
  branch: string | null;
  deployed_at: string | null;
  created_at: string;
  [k: string]: unknown;
}

interface ReleaseListEnvelope {
  data: ReleaseItem[];
  pagination: { cursor: string | null; has_more: boolean };
}

interface ReleaseDetailEnvelope {
  data: ReleaseItem & {
    commit_count: number;
  };
}

interface HealthSnapshotEnvelope {
  data: {
    release_id: string;
    environment_id: string;
    window_minutes: number;
    window_start: string | null;
    window_end: string | null;
    total_sessions: number | null;
    crash_free_rate: number | null;
    error_rate: number | null;
    p50_api_latency_ms: number | null;
    p95_api_latency_ms: number | null;
    conversion_rate: number | null;
    health_score: number | null;
    health_status: string | null;
    prev_release_id: string | null;
    crash_rate_delta: number | null;
    latency_delta_ms: number | null;
  };
}

interface RegressionEntry {
  kind: string;
  release_id: string;
  version: string;
  detected_at: string;
  crash_free_delta: number;
  crash_free_rate: number;
  total_sessions: number;
  prev_release_id: string | null;
  crash_rate_delta: number | null;
  error_rate: number | null;
  p95_api_latency_ms: number | null;
  change_event_id: string | null;
  change_entity_key: string | null;
  change_at: string | null;
  pre_crash_free_rate: number | null;
  post_crash_free_rate: number | null;
  pre_sessions: number | null;
  post_sessions: number | null;
}

interface RegressionsEnvelope {
  data: {
    regressions: RegressionEntry[];
    since: string;
    count: number;
  };
}

interface ReleaseToolDeps {
  api: ApiClient;
}

// ── Input schemas ────────────────────────────────────────────────────────────

const listInputSchema = z.object({
  environment_id: z.string().uuid().optional().describe("Filter to a specific environment."),
  platform: z.enum(["ios", "android", "web", "backend", "all"]).optional(),
  channel: z.enum(["internal", "beta", "canary", "production"]).optional(),
  status: z
    .enum(["created", "deploying", "rolling_out", "active", "paused", "rolled_back", "superseded"])
    .optional(),
  cursor: z.string().uuid().optional().describe("Pagination cursor from a prior call."),
  limit: z.coerce.number().int().min(1).max(100).default(25).describe("Page size (1-100)."),
});

const healthInputSchema = z.object({
  release_id: z.string().uuid().describe("UUID of the release to inspect."),
  environment_id: z
    .string()
    .uuid()
    .optional()
    .describe("Filter health snapshot to a specific environment."),
  window_minutes: z.coerce
    .number()
    .int()
    .min(5)
    .max(10080)
    .default(60)
    .describe("Rolling window in minutes for the health signals (5–10080, default 60)."),
});

const regressionsInputSchema = z.object({
  since: z
    .string()
    .datetime()
    .optional()
    .describe("ISO timestamp lower bound. Defaults to 24 h ago."),
  environment_id: z.string().uuid().optional().describe("Filter regressions to one environment."),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("Max regressions to return (1-100)."),
});

// ── Tool builder ─────────────────────────────────────────────────────────────

export function buildReleaseTools({ api }: ReleaseToolDeps): Tool[] {
  return [
    // ── release_list ───────────────────────────────────────────────────────

    defineTool({
      name: "release_list",
      title: "List releases with current health verdicts",
      description:
        "List releases newest-first with each release's CURRENT pre-computed health verdict " +
        "(healthy/degraded/critical/unknown) and crash-free + error + latency rates. " +
        "The verdict is computed server-side — read health_status, do not recompute it from the rates. " +
        "Filter by platform, channel, or status (status='active' means deployed to production). " +
        "Supports cursor pagination: pass cursor from pagination.cursor to fetch the next page. " +
        "Use release_health for the full four-signal breakdown of one release, " +
        "and release_regressions to find releases that got WORSE.",
      inputSchema: listInputSchema,
      async handler(input) {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (input.environment_id) query.environment_id = input.environment_id;
        if (input.platform) query.platform = input.platform;
        if (input.channel) query.channel = input.channel;
        if (input.status) query.status = input.status;
        if (input.cursor) query.cursor = input.cursor;
        query.limit = input.limit;

        const res = await api.get<ReleaseListEnvelope>("/v1/releases", query);

        // Build text channel from ORIGINAL strings (wrapped via wrapUntrusted)
        // BEFORE sanitising structuredContent. sanitizeUntrustedFields mutates
        // res.data in place — if we built text after that call, wrapUntrusted
        // would wrap already-stripped content instead of the raw input.
        const lines =
          res.data.length === 0
            ? "No releases found."
            : res.data
                .map((r) => {
                  const verdict = r.health_status ?? "unknown";
                  const cfr =
                    typeof r.crash_free_rate === "number"
                      ? `${r.crash_free_rate.toFixed(2)}% cfr`
                      : "cfr n/a";
                  return (
                    ` • ${wrapUntrusted(r.version)} [${r.platform}/${r.channel}] ` +
                    `${verdict} score=${r.health_score ?? "?"} ${cfr} — id ${r.id}`
                  );
                })
                .join("\n");

        // Now sanitise the structured payload (strips dangerous code points for
        // the structuredContent channel which MCP hosts may surface to the model).
        sanitizeUntrustedFields(res.data, RELEASE_LIST_UNTRUSTED_FIELDS);

        return {
          content: [
            {
              type: "text",
              text: `${res.data.length} release${res.data.length === 1 ? "" : "s"}:\n${lines}`,
            },
          ],
          structuredContent: {
            releases: res.data.map((r) => ({
              id: r.id,
              version: r.version,
              platform: r.platform,
              channel: r.channel,
              status: r.status,
              rollout_pct: r.rollout_pct,
              health_status: r.health_status,
              health_score: r.health_score,
              crash_free_rate: r.crash_free_rate,
              error_rate: r.error_rate,
              // p50 + p99 both surfaced for parity with release_health's
              // signals block (which returns p50_api_latency_ms).
              p50_latency_ms: r.p50_latency_ms,
              p99_latency_ms: r.p99_latency_ms,
              commit_sha: r.commit_sha,
              pr_number: r.pr_number,
              pr_title: r.pr_title,
              branch: r.branch,
              deployed_at: r.deployed_at,
              created_at: r.created_at,
            })),
            pagination: res.pagination,
          },
        };
      },
    }),

    // ── release_health ─────────────────────────────────────────────────────

    defineTool({
      name: "release_health",
      title: "Full health verdict + four signals for one release",
      description:
        "Return the full pre-computed health verdict and all four signals (crash-free, error rate, " +
        "p95 latency, conversion) for ONE release, plus code context (commit SHA, PR number, PR title, " +
        "branch, commit count) and the delta vs the prior release. " +
        "health_status and health_score are authoritative — narrate " +
        "them, never derive your own verdict from the individual rates. " +
        "conversion_rate may be null when business metrics are not instrumented for this project; " +
        "do not treat null as 0%.",
      inputSchema: healthInputSchema,
      async handler(input) {
        const { release_id, environment_id, window_minutes } = input;

        // Fetch health snapshot + release detail in parallel to build the full
        // four-signal + code context response without two sequential round-trips.
        // Use allSettled so one 404 doesn't sink both calls — lets us return
        // a helpful message when the release exists but has no snapshot yet.
        const healthQuery: Record<string, string | number | boolean | undefined> = {
          window_minutes,
        };
        if (environment_id) healthQuery.environment_id = environment_id;

        const [healthSettled, detailSettled] = await Promise.allSettled([
          api.get<HealthSnapshotEnvelope>(`/v1/releases/${release_id}/health`, healthQuery),
          api.get<ReleaseDetailEnvelope>(`/v1/releases/${release_id}`),
        ]);

        // Detail rejection: ONLY a 404 means the release genuinely does not
        // exist. Any other rejection (401/403/429/5xx/network) is a real
        // failure — rethrow so the central handler in src/index.ts surfaces
        // the actual status + recoveryHint instead of mislabelling every
        // failure as "not found". (ApiError carries `.status`; a plain
        // Error with no status falls through to the rethrow, which is the
        // safe default — "unknown failure" is never "not found".)
        if (detailSettled.status === "rejected") {
          const reason = detailSettled.reason as { status?: number } | undefined;
          if (reason?.status !== 404) throw detailSettled.reason;
          return {
            content: [
              {
                type: "text",
                text: `Release ${release_id} not found.`,
              },
            ],
            structuredContent: { error: "NOT_FOUND", release_id },
            // Resource-not-found is a tool error in this codebase — mirrors
            // dashboard_template_get's "Unknown template" isError convention.
            isError: true,
          };
        }

        const d = detailSettled.value.data;

        // Health rejection: ONLY a 404 means "release exists but has no snapshot
        // yet". Any other rejection (401/403/429/5xx/network) is a real failure —
        // rethrow so the central handler surfaces the true status + recoveryHint
        // instead of telling the user to "check back after the first telemetry
        // window" for data that will never arrive. (Symmetric with the detail
        // branch above; same guard, same safe default for null/non-object reason.)
        if (healthSettled.status === "rejected") {
          const healthReason = healthSettled.reason as { status?: number } | undefined;
          if (healthReason?.status !== 404) throw healthSettled.reason;
          // Build text from original (unsanitised) before mutating for structuredContent
          const versionText = wrapUntrusted(d.version);
          sanitizeUntrustedFields(d, RELEASE_UNTRUSTED_FIELDS);
          return {
            content: [
              {
                type: "text",
                text:
                  `Release ${versionText} (${d.platform}/${d.channel}) found but has no health ` +
                  `snapshots yet — check back after the first telemetry window.`,
              },
            ],
            structuredContent: {
              error: "NO_SNAPSHOT",
              release: {
                id: d.id,
                version: d.version,
                platform: d.platform,
                channel: d.channel,
                status: d.status,
              },
            },
          };
        }

        const h = healthSettled.value.data;

        // Build text channel from ORIGINAL strings BEFORE sanitising structuredContent.
        const versionText = wrapUntrusted(d.version);
        const branchText = wrapUntrusted(d.branch ?? "");
        const prTitleText = typeof d.pr_number === "number" ? wrapUntrusted(d.pr_title ?? "") : "";

        // Sanitise tool-poisoning vectors for structuredContent
        sanitizeUntrustedFields(d, RELEASE_UNTRUSTED_FIELDS);

        const verdict = h.health_status ?? "unknown";
        const score = h.health_score ?? "?";
        const cfr =
          typeof h.crash_free_rate === "number" ? `${h.crash_free_rate.toFixed(2)}%` : "n/a";
        const conv =
          typeof h.conversion_rate === "number"
            ? `${h.conversion_rate.toFixed(2)}%`
            : "not instrumented";

        // Use pre-computed wrapped text (versionText/branchText/prTitleText built before
        // sanitiseUntrustedFields mutated d). d.version/branch/pr_title are now stripped.
        return {
          content: [
            {
              type: "text",
              text:
                `Release ${versionText} (${d.platform}/${d.channel}) — ` +
                `verdict: ${verdict} (score ${score})\n` +
                `  crash-free: ${cfr}  error-rate: ${typeof h.error_rate === "number" ? `${h.error_rate.toFixed(2)}%` : "n/a"}  ` +
                `p95 latency: ${typeof h.p95_api_latency_ms === "number" ? `${h.p95_api_latency_ms}ms` : "n/a"}  ` +
                `conversion: ${conv}\n` +
                `  sessions: ${h.total_sessions ?? "n/a"}  window: ${window_minutes}min\n` +
                (h.prev_release_id
                  ? `  vs prior: crash_delta=${typeof h.crash_rate_delta === "number" ? `${h.crash_rate_delta.toFixed(2)}pp` : "n/a"}  ` +
                    `latency_delta=${typeof h.latency_delta_ms === "number" ? `${h.latency_delta_ms}ms` : "n/a"}\n`
                  : "  no prior release for comparison\n") +
                `  commit: ${d.commit_sha ?? "n/a"}  branch: ${branchText}  ` +
                `PR: ${typeof d.pr_number === "number" ? `#${d.pr_number} ${prTitleText}` : "n/a"}`,
            },
          ],
          structuredContent: {
            verdict: {
              health_status: h.health_status,
              health_score: h.health_score,
            },
            release: {
              id: d.id,
              version: d.version,
              platform: d.platform,
              channel: d.channel,
              status: d.status,
              rollout_pct: d.rollout_pct,
              commit_sha: d.commit_sha,
              branch: d.branch,
              pr_number: d.pr_number,
              pr_title: d.pr_title,
              commit_count: d.commit_count,
            },
            signals: {
              crash_free_rate: h.crash_free_rate,
              error_rate: h.error_rate,
              p95_api_latency_ms: h.p95_api_latency_ms,
              p50_api_latency_ms: h.p50_api_latency_ms,
              conversion_rate: h.conversion_rate,
              total_sessions: h.total_sessions,
              window_minutes: h.window_minutes,
              window_start: h.window_start,
              window_end: h.window_end,
            },
            comparison: {
              prev_release_id: h.prev_release_id,
              crash_rate_delta: h.crash_rate_delta,
              latency_delta_ms: h.latency_delta_ms,
            },
          },
        };
      },
    }),

    // ── release_regressions ────────────────────────────────────────────────

    defineTool({
      name: "release_regressions",
      title: "List releases that regressed",
      description:
        "List releases that REGRESSED (crash-free rate dropped past the server's significance gate), " +
        "newest-first, optionally since a timestamp. " +
        "kind='release' means the release degraded vs the prior release; " +
        "kind='change' means it degraded right after a specific flag/config change (see change_entity_key). " +
        "The drop is detected server-side — report crash_free_delta as given, do not recompute it. " +
        "crash_free_delta of 0 on a kind='change' entry may mean the delta was not computable — " +
        "check pre/post_crash_free_rate to confirm before treating 0 as a true no-change reading. " +
        "Use release_health(release_id) to investigate a specific regression in depth.",
      inputSchema: regressionsInputSchema,
      async handler(input) {
        const query: Record<string, string | number | boolean | undefined> = {
          limit: input.limit,
        };
        if (input.since) query.since = input.since;
        if (input.environment_id) query.environment_id = input.environment_id;

        const res = await api.get<RegressionsEnvelope>("/v1/releases/regressions", query);

        const { regressions, since, count } = res.data;

        // Build text channel from ORIGINAL strings (wrapped via wrapUntrusted)
        // BEFORE sanitising structuredContent. sanitizeUntrustedFields mutates
        // res.data in place — building text after that call would wrap already-stripped content.
        const lines =
          count === 0
            ? `No regressions detected since ${since}.`
            : regressions
                .map((r) => {
                  const delta = r.crash_free_delta.toFixed(2);
                  const label =
                    r.kind === "change"
                      ? `after change ${wrapUntrusted(r.change_entity_key ?? "unknown")}`
                      : "vs prior release";
                  return ` • ${wrapUntrusted(r.version)} [${r.kind}] crash_free_delta=${delta}pp ${label} — id ${r.release_id}`;
                })
                .join("\n");

        // Sanitise customer-controlled strings in structuredContent (version,
        // change_entity_key, change_at, change_event_id are tool-poisoning vectors).
        sanitizeUntrustedFields(res.data, REGRESSION_UNTRUSTED_FIELDS);

        return {
          content: [
            {
              type: "text",
              text: `${count} regression${count === 1 ? "" : "s"} since ${since}:\n${lines}`,
            },
          ],
          structuredContent: {
            regressions,
            since,
            count,
          },
        };
      },
    }),
  ];
}
