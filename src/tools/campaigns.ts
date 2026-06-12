/**
 * Campaign tools for the MCP server. Each tool wraps one HTTP endpoint
 * with a tight, LLM-friendly Zod input schema + a structured-content
 * response that summarises what happened in plain English.
 *
 * The preview/apply discipline (every /launch requires a fresh
 * snapshot-bound `preview_token`) is preserved by exposing them as two
 * separate tools — `campaign_preview` returns the token, `campaign_launch`
 * consumes it. An LLM cannot launch without first previewing.
 *
 * Description prose on every tool repeats the trinary update semantics
 * (omit = preserve, null = clear, value = set) because LLMs treat tool
 * schemas as the canonical contract.
 */

import { z } from "zod";
import {
  archiveCampaignSchema,
  campaignListQuerySchema,
  completeCampaignSchema,
  createCampaignSchema,
  launchCampaignSchema,
  pauseCampaignSchema,
  resumeCampaignSchema,
  updateCampaignSchema,
} from "../vendor/index.js";
import type { ApiClient } from "../lib/api-client.js";
import { wrapUntrusted, sanitizeUntrustedFields } from "../lib/untrust.js";

// Fields customers populate on a Campaign that round-trip via the
// `structuredContent` channel. MCP-spec hosts MAY surface this channel
// direct-to-model, bypassing the `content[].text` sentinel wrap, so we
// strip dangerous code points on the way out.
//
// v2: `subject`/`from_name` are NOT top-level Campaign fields — they
// live inside `creative[].payload.*`.
// v3: audience RuleCondition values, success_metric event_name + filter
// values, and the full `creative.*.payload.*` map (32 keys ×
// 8000-char strings, customer-named). Both audience and metric.filter
// values are `string|number|bool` — the string-array idiom strips
// strings only.
const CAMPAIGN_FIELDS = [
  "name",
  "key",
  "description",
  "goal",
  "audience.*.field",
  "audience.*.values",
  "success_metric.event_name",
  "success_metric.filter.*.field",
  "success_metric.filter.*.values",
  "creative.*.name",
  "creative.*.payload.*",
];
// List response (campaign_list) doesn't carry creative/audience/metric —
// that endpoint returns a slim row shape. Keep the flat fields only.
const CAMPAIGN_LIST_FIELDS = ["*.name", "*.key", "*.description"];
import { type Tool, defineTool } from "./define.js";

interface CampaignsToolDeps {
  api: ApiClient;
}

interface CampaignEnvelope {
  data: {
    id: string;
    key: string;
    name: string;
    status: string;
    [k: string]: unknown;
  };
}

interface PreviewEnvelope {
  data: {
    campaign_id: string;
    launchable: boolean;
    validation_errors: Array<{ field: string; message: string }>;
    plan: Record<string, unknown>;
    preview_token: string | null;
    preview_token_expires_at: string | null;
  };
}

interface ListEnvelope {
  data: Array<{ id: string; key: string; name: string; status: string }>;
  pagination: { cursor: string | null; has_more: boolean };
}

interface ResultsEnvelope {
  data: {
    campaign_id: string;
    status: string;
    results: unknown;
    results_updated_at: string | null;
  };
}

const idParam = z.object({ id: z.string().uuid().describe("Campaign UUID.") });

export function buildCampaignTools({ api }: CampaignsToolDeps): Tool[] {
  return [
    defineTool({
      name: "campaign_list",
      title: "List campaigns",
      description:
        "List campaigns in the current project. Supports cursor pagination, status filter, free-text search across name/key/goal.",
      inputSchema: campaignListQuerySchema,
      async handler(input) {
        const res = await api.get<ListEnvelope>(
          "/v1/campaigns",
          input as Record<string, string | number | boolean | undefined>,
        );
        return {
          content: [
            {
              type: "text",
              text:
                res.data.length === 0
                  ? "No campaigns matched."
                  : `${res.data.length} campaign${res.data.length === 1 ? "" : "s"}${res.pagination.has_more ? " (more available — pass `cursor` to paginate)" : ""}:\n` +
                    res.data
                      .map(
                        (c) =>
                          ` • ${wrapUntrusted(c.name)} (${wrapUntrusted(c.key)}) — ${c.status} — id ${c.id}`,
                      )
                      .join("\n"),
            },
          ],
          structuredContent: {
            // Strip dangerous code points from customer-controlled fields
            // on every campaign before structuredContent exposes them to
            // the host LLM.
            campaigns: sanitizeUntrustedFields(res.data, CAMPAIGN_LIST_FIELDS),
            pagination: res.pagination,
          },
        };
      },
    }),

    defineTool({
      name: "campaign_get",
      title: "Read a campaign",
      description:
        "Fetch a single campaign by id with full audience / channels / creative / metric / budget / schedule / status.",
      inputSchema: idParam,
      async handler({ id }) {
        const res = await api.get<CampaignEnvelope>(`/v1/campaigns/${id}`);
        return {
          content: [
            {
              type: "text",
              text: `Campaign ${wrapUntrusted(res.data.name)} (${wrapUntrusted(res.data.key)}) is ${res.data.status}.`,
            },
          ],
          structuredContent: { campaign: sanitizeUntrustedFields(res.data, CAMPAIGN_FIELDS) },
        };
      },
    }),

    defineTool({
      name: "campaign_create",
      title: "Create a campaign (draft)",
      description:
        "Create a new campaign in `draft` status. The campaign isn't running until you call campaign_preview followed by campaign_launch. " +
        "Channels: each entry needs a `kind` (email|meta|google|tiktok|linkedin|webhook). " +
        "Audience: array of RuleCondition `{field, op, values[]}`. " +
        "Success metric: `{event_name, window_seconds?}` — defaults to a 7-day conversion window.",
      inputSchema: createCampaignSchema,
      async handler(input) {
        const res = await api.post<CampaignEnvelope>("/v1/campaigns", input);
        return {
          content: [
            {
              type: "text",
              text: `Created draft campaign ${wrapUntrusted(res.data.name)} (${wrapUntrusted(res.data.key)}). Next step: call campaign_preview to validate launch readiness.`,
            },
          ],
          structuredContent: { campaign: sanitizeUntrustedFields(res.data, CAMPAIGN_FIELDS) },
        };
      },
    }),

    defineTool({
      name: "campaign_update",
      title: "Update a campaign (draft|paused only)",
      description:
        "Patch a campaign. ALLOWED only in `draft` or `paused` state. " +
        "Trinary semantics for nullable fields: omit a field to PRESERVE its current value, send null to CLEAR, send a value to SET. " +
        "Editing audience / channels / creative will INVALIDATE any outstanding preview_token (re-preview to get a fresh one).",
      inputSchema: updateCampaignSchema.extend({ id: z.string().uuid() }),
      async handler(input) {
        const { id, ...body } = input;
        const res = await api.patch<CampaignEnvelope>(`/v1/campaigns/${id}`, body);
        return {
          content: [
            {
              type: "text",
              text: `Updated campaign ${wrapUntrusted(res.data.name)} (${wrapUntrusted(res.data.key)}).`,
            },
          ],
          structuredContent: { campaign: sanitizeUntrustedFields(res.data, CAMPAIGN_FIELDS) },
        };
      },
    }),

    defineTool({
      name: "campaign_preview",
      title: "Preview & validate a campaign before launching",
      description:
        "Dry-run the campaign and return the launch plan + a single-use `preview_token`. The token is bound to the current state of audience/channels/creative/metric/budget/schedule and ALL of these must be present and valid for the token to be returned. Pass the token to campaign_launch within 5 minutes — editing the campaign in between invalidates it.",
      inputSchema: idParam,
      async handler({ id }) {
        const res = await api.post<PreviewEnvelope>(`/v1/campaigns/${id}/preview`, {});
        // validation_errors.field/message are server-generated, but an
        // attacker can craft customer input that the server echoes back
        // (e.g. a campaign name with a sentinel forge that surfaces in an
        // error). Strip defensively.
        sanitizeUntrustedFields(res.data, [
          "validation_errors.*.field",
          "validation_errors.*.message",
        ]);
        if (!res.data.launchable) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Campaign is NOT launchable yet. Issues:\n" +
                  res.data.validation_errors.map((e) => ` • ${e.field}: ${e.message}`).join("\n"),
              },
            ],
            structuredContent: res.data,
            isError: false,
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                "Campaign is launchable. Plan summary:\n" +
                JSON.stringify(res.data.plan, null, 2) +
                `\n\nPass preview_token "${res.data.preview_token}" to campaign_launch to actually start it.`,
            },
          ],
          structuredContent: res.data,
        };
      },
    }),

    defineTool({
      name: "campaign_launch",
      title: "Launch a previewed campaign",
      description:
        "Move a campaign from draft|paused → scheduled|running. REQUIRES a fresh `preview_token` from campaign_preview. The token is single-use and snapshot-bound — if anything changed since preview, re-run campaign_preview to get a new token.",
      inputSchema: launchCampaignSchema.extend({ id: z.string().uuid() }),
      async handler(input) {
        const { id, ...body } = input;
        const res = await api.post<CampaignEnvelope>(`/v1/campaigns/${id}/launch`, body);
        return {
          content: [
            {
              type: "text",
              text: `✓ Campaign ${wrapUntrusted(res.data.name)} is now ${res.data.status}.`,
            },
          ],
          structuredContent: { campaign: sanitizeUntrustedFields(res.data, CAMPAIGN_FIELDS) },
        };
      },
    }),

    defineTool({
      name: "campaign_pause",
      title: "Pause a running campaign",
      description:
        "Pause a scheduled or running campaign. Pause is reversible via campaign_resume.",
      inputSchema: pauseCampaignSchema.extend({ id: z.string().uuid() }),
      async handler({ id, reason }) {
        const res = await api.post<CampaignEnvelope>(`/v1/campaigns/${id}/pause`, { reason });
        return {
          content: [{ type: "text", text: `Paused ${wrapUntrusted(res.data.name)}.` }],
          structuredContent: { campaign: sanitizeUntrustedFields(res.data, CAMPAIGN_FIELDS) },
        };
      },
    }),

    defineTool({
      name: "campaign_resume",
      title: "Resume a paused campaign",
      description:
        "Resume a paused campaign (paused → running). Re-validates launchability — empty audience / channels / creative / metric will reject.",
      inputSchema: resumeCampaignSchema.extend({ id: z.string().uuid() }),
      async handler({ id }) {
        const res = await api.post<CampaignEnvelope>(`/v1/campaigns/${id}/resume`, {});
        return {
          content: [{ type: "text", text: `Resumed ${wrapUntrusted(res.data.name)}.` }],
          structuredContent: { campaign: sanitizeUntrustedFields(res.data, CAMPAIGN_FIELDS) },
        };
      },
    }),

    defineTool({
      name: "campaign_complete",
      title: "Mark a campaign as completed",
      description:
        "Move a scheduled / running / paused campaign to `completed`. Terminal — only `archive` follows.",
      inputSchema: completeCampaignSchema.extend({ id: z.string().uuid() }),
      async handler({ id, reason }) {
        const res = await api.post<CampaignEnvelope>(`/v1/campaigns/${id}/complete`, { reason });
        return {
          content: [{ type: "text", text: `Completed ${wrapUntrusted(res.data.name)}.` }],
          structuredContent: { campaign: sanitizeUntrustedFields(res.data, CAMPAIGN_FIELDS) },
        };
      },
    }),

    defineTool({
      name: "campaign_archive",
      title: "Archive a campaign",
      description:
        "Archive a completed (or never-launched draft) campaign. Removes it from the default list view but keeps history.",
      inputSchema: archiveCampaignSchema.extend({ id: z.string().uuid() }),
      async handler({ id }) {
        const res = await api.post<CampaignEnvelope>(`/v1/campaigns/${id}/archive`, {});
        return {
          content: [{ type: "text", text: `Archived ${wrapUntrusted(res.data.name)}.` }],
          structuredContent: { campaign: sanitizeUntrustedFields(res.data, CAMPAIGN_FIELDS) },
        };
      },
    }),

    defineTool({
      name: "campaign_results",
      title: "Read latest campaign results",
      description:
        "Fetch the latest results snapshot for a campaign. v1 only stores the latest aggregate (impressions, clicks, conversions, by_channel, by_variant); time-series snapshots land with the destinations framework.",
      inputSchema: idParam,
      async handler({ id }) {
        const res = await api.get<ResultsEnvelope>(`/v1/campaigns/${id}/results`);
        return {
          content: [
            {
              type: "text",
              text: `Status: ${res.data.status}. Results last updated ${res.data.results_updated_at ?? "never"}.`,
            },
          ],
          structuredContent: res.data,
        };
      },
    }),
  ];
}
