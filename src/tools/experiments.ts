/**
 * Experiment tools for the MCP server — agent-native A/B test setup.
 *
 * These four tools let a customer's AI agent create + edit experiments
 * end-to-end. Each wraps ONE existing `/v1/experiments` route — no business
 * logic is forked here; the API owns the cross-field invariants (exactly one
 * control variant, variant weights summing to 100, ≥1 primary metric,
 * environment-belongs-to-project) and re-checks them server-side:
 *
 *   experiment_list   → GET   /v1/experiments       (secret key + viewer role)
 *   experiment_get    → GET   /v1/experiments/:id    (secret key + viewer)
 *   experiment_create → POST  /v1/experiments        (secret key + editor role)
 *   experiment_update → PATCH /v1/experiments/:id     (secret key + editor; draft-only)
 *
 * Auth/scope: the `/v1/experiments` plugin registers `requireSecretKey` for
 * the whole surface — every experiment tool needs a secret (`lp_sec_*`) key
 * (a publishable or dev key gets 401/403). Writes additionally need editor role.
 *
 * Anti-hallucination: customer-controlled strings (key / name / description /
 * hypothesis / variant keys+names / metric event names) round-trip through the
 * LLM channel, so they're wrapped in the text channel and stripped of
 * dangerous code points in structuredContent. Mirrors the campaign / flag tool
 * pattern — see src/lib/untrust.ts.
 */

import { z } from "zod";
import {
  createExperimentSchema,
  updateExperimentSchema,
  experimentListQuerySchema,
} from "../vendor/index.js";
import type { ApiClient } from "../lib/api-client.js";
import { wrapUntrusted, sanitizeUntrustedFields } from "../lib/untrust.js";
import { type Tool, defineTool } from "./define.js";

// Customer-controlled fields that round-trip via structuredContent.
// `variants.*.payload.*` is arbitrary customer JSON (z.record(z.unknown())
// on create) surfaced back on every read — same tool-poisoning vector the
// campaign tool strips on `creative.*.payload.*`.
const EXPERIMENT_FIELDS = [
  "key",
  "name",
  "description",
  "hypothesis",
  "variants.*.key",
  "variants.*.name",
  "variants.*.payload.*",
  "metrics.*.event_name",
  "metrics.*.aggregation_field",
];
// List/get return the same row shape; the list variant prefixes `*.`.
const EXPERIMENT_LIST_FIELDS = EXPERIMENT_FIELDS.map((f) => `*.${f}`);

interface ExperimentEnvelope {
  data: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    hypothesis: string | null;
    status: string;
    environment_id: string;
    traffic_pct: number;
    variants?: Array<{ key: string; name: string; is_control: boolean; weight: number }>;
    metrics?: Array<{ event_name: string; metric_type: string; is_primary: boolean }>;
    created_at: string;
    updated_at: string;
    [k: string]: unknown;
  };
}

interface ExperimentListEnvelope {
  data: ExperimentEnvelope["data"][];
  pagination: { cursor: string | null; has_more: boolean };
}

const idParam = z.object({ id: z.string().uuid().describe("Experiment UUID.") });

interface ExperimentsToolDeps {
  api: ApiClient;
}

export function buildExperimentTools({ api }: ExperimentsToolDeps): Tool[] {
  return [
    defineTool({
      name: "experiment_list",
      title: "List experiments",
      description:
        "List experiments in the current project, newest-first, with their variants + metrics. " +
        "Filter by status (draft|running|paused|completed|archived) or free-text search across name/key. " +
        "Supports cursor pagination. Use experiment_get for one experiment's full detail, " +
        "experiment_create to set up a new A/B test.",
      inputSchema: experimentListQuerySchema,
      async handler(input) {
        const query: Record<string, string | number | boolean | undefined> = { limit: input.limit };
        if (input.status) query.status = input.status;
        if (input.search) query.search = input.search;
        if (input.cursor) query.cursor = input.cursor;

        const res = await api.get<ExperimentListEnvelope>("/v1/experiments", query);

        const lines =
          res.data.length === 0
            ? "No experiments matched."
            : res.data
                .map(
                  (e) =>
                    ` • ${wrapUntrusted(e.name)} (${wrapUntrusted(e.key)}) — ${e.status} — ${e.traffic_pct}% traffic — id ${e.id}`,
                )
                .join("\n");
        const more = res.pagination.has_more ? " (more available — pass `cursor` to paginate)" : "";

        sanitizeUntrustedFields(res.data, EXPERIMENT_LIST_FIELDS);

        return {
          content: [
            {
              type: "text",
              text: `${res.data.length} experiment${res.data.length === 1 ? "" : "s"}${more}:\n${lines}`,
            },
          ],
          structuredContent: { experiments: res.data, pagination: res.pagination },
        };
      },
    }),

    defineTool({
      name: "experiment_get",
      title: "Read an experiment",
      description:
        "Fetch a single experiment by id with its full variants (key/name/weight/control) and metrics (event/type/primary).",
      inputSchema: idParam,
      async handler({ id }) {
        const res = await api.get<ExperimentEnvelope>(`/v1/experiments/${id}`);
        const nameText = wrapUntrusted(res.data.name);
        const keyText = wrapUntrusted(res.data.key);
        sanitizeUntrustedFields(res.data, EXPERIMENT_FIELDS);
        return {
          content: [
            {
              type: "text",
              text: `Experiment ${nameText} (${keyText}) — ${res.data.status}, ${res.data.traffic_pct}% traffic, ${res.data.variants?.length ?? 0} variants.`,
            },
          ],
          structuredContent: { experiment: res.data },
        };
      },
    }),

    defineTool({
      name: "experiment_create",
      title: "Create an experiment (draft)",
      description:
        "Create a new experiment in `draft` status — it does NOT collect data until started (via the dashboard or the start endpoint). " +
        "key is immutable lowercase snake_case (2–128 chars). environment_id MUST be a UUID of an environment in this project. " +
        "variants: 2–10 entries; EXACTLY ONE must have is_control=true, and the integer weights MUST sum to 100. " +
        "metrics: 1–20 entries; AT LEAST ONE must have is_primary=true. metric_type is conversion|count|sum|average|p50|p95|p99; " +
        "sum/average/percentile types need aggregation_field. traffic_pct (1–100, default 10) is the fraction of users enrolled. " +
        "These invariants are enforced server-side — a violation returns 400 (INVALID_VARIANTS / INVALID_WEIGHTS / MISSING_PRIMARY_METRIC / INVALID_ENVIRONMENT). " +
        "Returns 409 EXPERIMENT_KEY_EXISTS if the key is taken. Requires a secret API key with editor role.",
      inputSchema: createExperimentSchema,
      async handler(input) {
        const res = await api.post<ExperimentEnvelope>("/v1/experiments", input);
        const nameText = wrapUntrusted(res.data.name);
        const keyText = wrapUntrusted(res.data.key);
        sanitizeUntrustedFields(res.data, EXPERIMENT_FIELDS);
        return {
          content: [
            {
              type: "text",
              text: `✓ Created draft experiment ${nameText} (${keyText}) with ${res.data.variants?.length ?? 0} variants. Start it (dashboard or start endpoint) to begin collecting data. id ${res.data.id}`,
            },
          ],
          structuredContent: { experiment: res.data },
        };
      },
    }),

    defineTool({
      name: "experiment_update",
      title: "Update an experiment (draft only)",
      description:
        "Patch a draft experiment's name, description, hypothesis, or traffic_pct. " +
        "Omit a field to PRESERVE its current value. " +
        "ALLOWED only while status is `draft` — a running/paused/completed experiment returns 409 EXPERIMENT_NOT_DRAFT " +
        "(its variants + metrics are frozen once it has collected data). " +
        "key, environment_id, variants, and metrics are NOT editable here. Requires a secret API key with editor role.",
      inputSchema: updateExperimentSchema.extend({
        id: z.string().uuid().describe("Experiment UUID to update."),
      }),
      async handler(input) {
        const { id, ...body } = input;
        const res = await api.patch<ExperimentEnvelope>(`/v1/experiments/${id}`, body);
        const nameText = wrapUntrusted(res.data.name);
        const keyText = wrapUntrusted(res.data.key);
        sanitizeUntrustedFields(res.data, EXPERIMENT_FIELDS);
        return {
          content: [
            {
              type: "text",
              text: `✓ Updated experiment ${nameText} (${keyText}) — ${res.data.traffic_pct}% traffic.`,
            },
          ],
          structuredContent: { experiment: res.data },
        };
      },
    }),
  ];
}
