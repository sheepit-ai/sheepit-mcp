/**
 * Flag tools for the MCP server — agent-native flag setup.
 *
 * These four tools let a customer's AI agent create + edit flags end-to-end
 * instead of only operating pre-created ones. Each wraps ONE existing
 * `/v1/flags` route — no business logic is forked here; the API re-validates
 * every request and owns config-version bumps, change records, and key
 * uniqueness:
 *
 *   flag_list   → GET   /v1/flags       (management key + viewer role)
 *   flag_get    → GET   /v1/flags/:id   (management key + viewer)
 *   flag_create → POST  /v1/flags       (secret key + editor role)
 *   flag_update → PATCH /v1/flags/:id   (secret key + editor)
 *
 * Auth/scope: create + update require a secret (`lp_sec_*`) key with editor
 * role. A dev (`lp_dev_*`) key can list/get but the API returns 403 on the
 * writes — surfaced via recoveryHint in the central handler.
 *
 * Anti-hallucination: customer-controlled strings (key / name / description /
 * tags / default_value) round-trip through the LLM channel, so they're
 * wrapped in the `content[].text` channel and stripped of dangerous code
 * points in `structuredContent` (which MCP hosts MAY surface direct-to-model).
 * Mirrors the campaign / release tool pattern — see src/lib/untrust.ts.
 */

import { z } from "zod";
import { createFlagSchema, updateFlagSchema, flagListQuerySchema } from "../vendor/index.js";
import type { ApiClient } from "../lib/api-client.js";
import { wrapUntrusted, sanitizeUntrustedFields } from "../lib/untrust.js";
import { type Tool, defineTool } from "./define.js";

// Customer-controlled fields that round-trip via structuredContent. The
// list endpoint returns the same row shape, so the list variant just
// prefixes each path with `*.`. `default_value` is arbitrary customer JSON
// (string when value_type=string, or an object/array for value_type=json);
// `default_value` strips it when it's a string and `default_value.*` strips
// every string under a json object — both are tool-poisoning vectors.
const FLAG_FIELDS = ["key", "name", "description", "tags.*", "default_value", "default_value.*"];
const FLAG_LIST_FIELDS = FLAG_FIELDS.map((f) => `*.${f}`);

interface FlagEnvelope {
  data: {
    id: string;
    key: string;
    name: string;
    description: string | null;
    value_type: string;
    default_value: unknown;
    platforms: string[];
    status: string;
    tags: string[];
    created_at: string;
    updated_at: string;
    [k: string]: unknown;
  };
}

interface FlagListEnvelope {
  data: FlagEnvelope["data"][];
  pagination: { cursor: string | null; has_more: boolean };
}

const idParam = z.object({ id: z.string().uuid().describe("Flag UUID.") });

interface FlagsToolDeps {
  api: ApiClient;
}

export function buildFlagTools({ api }: FlagsToolDeps): Tool[] {
  return [
    defineTool({
      name: "flag_list",
      title: "List feature flags",
      description:
        "List feature flags in the current project, newest-first. " +
        "Filter by status (active|archived|deprecated), platform, tag, or free-text search across name. " +
        "Supports cursor pagination: pass cursor from pagination.cursor for the next page. " +
        "Use flag_get for one flag's full default_value + platforms, flag_create to add a new flag.",
      inputSchema: flagListQuerySchema,
      async handler(input) {
        const query: Record<string, string | number | boolean | undefined> = { limit: input.limit };
        if (input.status) query.status = input.status;
        if (input.platform) query.platform = input.platform;
        if (input.tag) query.tag = input.tag;
        if (input.search) query.search = input.search;
        if (input.cursor) query.cursor = input.cursor;

        const res = await api.get<FlagListEnvelope>("/v1/flags", query);

        // Build the text channel from ORIGINAL strings (wrapped) BEFORE
        // sanitizeUntrustedFields mutates res.data in place for structuredContent.
        const lines =
          res.data.length === 0
            ? "No flags matched."
            : res.data
                .map(
                  (f) =>
                    ` • ${wrapUntrusted(f.name)} (${wrapUntrusted(f.key)}) — ${f.value_type} — ${f.status} — id ${f.id}`,
                )
                .join("\n");
        const more = res.pagination.has_more ? " (more available — pass `cursor` to paginate)" : "";

        sanitizeUntrustedFields(res.data, FLAG_LIST_FIELDS);

        return {
          content: [
            {
              type: "text",
              text: `${res.data.length} flag${res.data.length === 1 ? "" : "s"}${more}:\n${lines}`,
            },
          ],
          structuredContent: { flags: res.data, pagination: res.pagination },
        };
      },
    }),

    defineTool({
      name: "flag_get",
      title: "Read a feature flag",
      description:
        "Fetch a single flag by id with its full default_value, value_type, platforms, tags, and status.",
      inputSchema: idParam,
      async handler({ id }) {
        const res = await api.get<FlagEnvelope>(`/v1/flags/${id}`);
        const nameText = wrapUntrusted(res.data.name);
        const keyText = wrapUntrusted(res.data.key);
        sanitizeUntrustedFields(res.data, FLAG_FIELDS);
        return {
          content: [
            {
              type: "text",
              text: `Flag ${nameText} (${keyText}) — ${res.data.value_type}, ${res.data.status}, platforms: ${res.data.platforms.join(", ")}.`,
            },
          ],
          structuredContent: { flag: res.data },
        };
      },
    }),

    defineTool({
      name: "flag_create",
      title: "Create a feature flag",
      description:
        "Create a new feature flag in the current project. " +
        "key is immutable (lowercase snake_case, 2–128 chars) — it's how SDKs reference the flag in code. " +
        "value_type is one of boolean|string|number|json (default boolean); default_value MUST match value_type " +
        "(a bool for boolean, a string for string, etc.) and is what the SDK returns until a rule/rollout overrides it. " +
        "platforms is a non-empty list from web|ios|ipados|macos|android|server. " +
        "Returns 409 FLAG_KEY_EXISTS if the key is taken. Requires a secret API key with editor role; " +
        "a dev key gets 403. After creating, add targeting with the flag's rules/rollouts (dashboard) " +
        "or flip default behaviour with flag_update.",
      inputSchema: createFlagSchema,
      async handler(input) {
        const res = await api.post<FlagEnvelope>("/v1/flags", input);
        const nameText = wrapUntrusted(res.data.name);
        const keyText = wrapUntrusted(res.data.key);
        sanitizeUntrustedFields(res.data, FLAG_FIELDS);
        return {
          content: [
            {
              type: "text",
              text: `✓ Created flag ${nameText} (${keyText}) — ${res.data.value_type}, default returned until a rule overrides. id ${res.data.id}`,
            },
          ],
          structuredContent: { flag: res.data },
        };
      },
    }),

    defineTool({
      name: "flag_update",
      title: "Update a feature flag",
      description:
        "Patch a flag's metadata. Editable fields: name, description, platforms, tags, status (active|archived|deprecated). " +
        "Omit a field to PRESERVE its current value. " +
        "key, value_type, and default_value are NOT editable here — they're locked once the flag exists so SDKs reading the flag don't break " +
        "(change default behaviour via the flag's rules/rollouts, or archive + recreate to change the type). " +
        "Requires a secret API key with editor role; a dev key gets 403.",
      inputSchema: updateFlagSchema.extend({
        id: z.string().uuid().describe("Flag UUID to update."),
      }),
      async handler(input) {
        const { id, ...body } = input;
        const res = await api.patch<FlagEnvelope>(`/v1/flags/${id}`, body);
        const nameText = wrapUntrusted(res.data.name);
        const keyText = wrapUntrusted(res.data.key);
        sanitizeUntrustedFields(res.data, FLAG_FIELDS);
        return {
          content: [
            {
              type: "text",
              text: `✓ Updated flag ${nameText} (${keyText}) — now ${res.data.status}.`,
            },
          ],
          structuredContent: { flag: res.data },
        };
      },
    }),
  ];
}
