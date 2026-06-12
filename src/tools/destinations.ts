/**
 * Destination tools for the MCP server.
 *
 * Mirrors the campaign tool surface — list / get / create / update /
 * delete / test — plus a `destination_catalog` read-only enumeration of
 * adapters available in the running build. The LLM uses this to answer
 * "which channels can I send through?" without baking the list into
 * the model.
 *
 * Pairs with the campaign tools: a typical conversation now is
 *   1) destination_catalog → "ok, you have webhook + resend"
 *   2) destination_create  → install Resend with from + API key
 *   3) campaign_create     → audience + channels: [{kind: "resend"}]
 *   4) campaign_preview → campaign_launch → server fans out via the
 *      installed Resend destination → emails actually go out.
 */

import { z } from "zod";
import {
  createDestinationSchema,
  destinationListQuerySchema,
  testDestinationSchema,
  updateDestinationSchema,
} from "../vendor/index.js";
import type { ApiClient } from "../lib/api-client.js";
import { wrapUntrusted, sanitizeUntrustedFields } from "../lib/untrust.js";

// Customer-controlled fields on Destinations that round-trip via the
// structuredContent channel. Adapter catalog entries (title /
// description / category) are server-static; not sanitized.
// `description` dropped — Destination schema has no description field
// (verified against the Destination schema).
// The `config` blob ships raw — a design-heavy follow-up is tracked
// separately (sanitize-vs-display-wrap on a per-adapter basis).
const DESTINATION_FIELDS = ["name"];
const DESTINATION_LIST_FIELDS = ["*.name"];
import { type Tool, defineTool } from "./define.js";

interface DestinationsToolDeps {
  api: ApiClient;
}

interface DestinationEnvelope {
  data: {
    id: string;
    connector_id: string;
    name: string;
    status: string;
    [k: string]: unknown;
  };
}

interface ListEnvelope {
  data: Array<{ id: string; connector_id: string; name: string; status: string }>;
  pagination: { cursor: string | null; has_more: boolean };
}

interface CatalogEnvelope {
  data: Array<{
    id: string;
    version: string;
    category: string;
    title: string;
    description: string;
  }>;
}

interface TestEnvelope {
  data:
    | { ok: true; remoteId?: string; message?: string; payloadBytes?: number }
    | { ok: false; code: string; message: string; retryable: boolean };
}

const idParam = z.object({ id: z.string().uuid().describe("Destination UUID.") });

export function buildDestinationTools({ api }: DestinationsToolDeps): Tool[] {
  return [
    defineTool({
      name: "destination_catalog",
      title: "List available destination adapters",
      description:
        "Read-only enumeration of every destination adapter the server currently knows about (webhook, resend, etc.). Use this to discover which `connector_id` values are valid for destination_create. Returns id / version / category / title / description per adapter.",
      inputSchema: z.object({}).strict(),
      async handler() {
        const res = await api.get<CatalogEnvelope>("/v1/destinations/catalog");
        const lines = res.data.map((a) => ` • ${a.id} (${a.category}) — ${a.title}`);
        return {
          content: [
            {
              type: "text",
              text:
                res.data.length === 0
                  ? "No adapters registered."
                  : `${res.data.length} destination adapter${res.data.length === 1 ? "" : "s"} available:\n${lines.join("\n")}`,
            },
          ],
          structuredContent: { adapters: res.data },
        };
      },
    }),

    defineTool({
      name: "destination_list",
      title: "List installed destinations",
      description:
        "List destination configs installed in the current project. Filter by connector_id (e.g. only Resend installs) or status (active|paused|failed).",
      inputSchema: destinationListQuerySchema,
      async handler(input) {
        const res = await api.get<ListEnvelope>(
          "/v1/destinations",
          input as Record<string, string | number | boolean | undefined>,
        );
        return {
          content: [
            {
              type: "text",
              text:
                res.data.length === 0
                  ? "No destinations installed."
                  : `${res.data.length} destination${res.data.length === 1 ? "" : "s"}${res.pagination.has_more ? " (more available — pass `cursor` to paginate)" : ""}:\n` +
                    res.data
                      .map(
                        (d) =>
                          ` • ${wrapUntrusted(d.name)} — ${d.connector_id} — ${d.status} — id ${d.id}`,
                      )
                      .join("\n"),
            },
          ],
          structuredContent: {
            destinations: sanitizeUntrustedFields(res.data, DESTINATION_LIST_FIELDS),
            pagination: res.pagination,
          },
        };
      },
    }),

    defineTool({
      name: "destination_get",
      title: "Read one destination config",
      description:
        "Fetch a single destination config by id with the full saved config + filters + last delivery state.",
      inputSchema: idParam,
      async handler({ id }) {
        const res = await api.get<DestinationEnvelope>(`/v1/destinations/${id}`);
        return {
          content: [
            {
              type: "text",
              text: `Destination ${wrapUntrusted(res.data.name)} (${res.data.connector_id}) is ${res.data.status}.`,
            },
          ],
          structuredContent: { destination: sanitizeUntrustedFields(res.data, DESTINATION_FIELDS) },
        };
      },
    }),

    defineTool({
      name: "destination_create",
      title: "Install a new destination",
      description:
        "Install a destination adapter into the current project. " +
        '`connector_id` must come from destination_catalog (e.g. "webhook", "resend"). ' +
        "`config` is per-adapter — the server validates it against the adapter's own schema and 400s on shape errors. " +
        'Webhook config: { url: "https://...", signing_secret?: string, timeout_ms?: number }. ' +
        'Resend config: { from: "Name <addr@domain>", reply_to?: string, audience_limit?: number, batch_size?: number }. ' +
        "Returns the destination id — pass it as `channel.destination_config_id` on a Campaign to bind explicitly.",
      inputSchema: createDestinationSchema,
      async handler(input) {
        const res = await api.post<DestinationEnvelope>("/v1/destinations", input);
        return {
          content: [
            {
              type: "text",
              text: `Installed ${res.data.connector_id} destination ${wrapUntrusted(res.data.name)}. Id: ${res.data.id}.`,
            },
          ],
          structuredContent: { destination: sanitizeUntrustedFields(res.data, DESTINATION_FIELDS) },
        };
      },
    }),

    defineTool({
      name: "destination_update",
      title: "Update an installed destination",
      description:
        "Update name / config / filters / status of an existing destination. " +
        'Status transitions allowed: active ↔ paused (the "failed" state is system-set after consecutive delivery errors and cannot be set manually). ' +
        "Trinary semantics for nullable fields: omit = preserve, send a new value to overwrite.",
      inputSchema: updateDestinationSchema.extend({ id: z.string().uuid() }),
      async handler(input) {
        const { id, ...body } = input;
        const res = await api.patch<DestinationEnvelope>(`/v1/destinations/${id}`, body);
        return {
          content: [
            {
              type: "text",
              text: `Updated destination ${wrapUntrusted(res.data.name)} (${res.data.status}).`,
            },
          ],
          structuredContent: { destination: sanitizeUntrustedFields(res.data, DESTINATION_FIELDS) },
        };
      },
    }),

    defineTool({
      name: "destination_delete",
      title: "Soft-delete (archive) a destination",
      description:
        "Soft-delete a destination — it stops being eligible for campaign dispatch but its history (audit log of past deliveries) is retained.",
      inputSchema: idParam,
      async handler({ id }) {
        await api.delete(`/v1/destinations/${id}`);
        return {
          content: [{ type: "text", text: `Archived destination ${id}.` }],
          structuredContent: { id, archived: true },
        };
      },
    }),

    defineTool({
      name: "destination_test",
      title: "Test a destination's saved config",
      description:
        "Run the adapter's connection check against the saved config. For webhooks: GETs the URL to verify it's reachable. For Resend: lists domains with the API key to verify auth. Does NOT send a real campaign payload.",
      inputSchema: testDestinationSchema.extend({ id: z.string().uuid() }),
      async handler({ id }) {
        const res = await api.post<TestEnvelope>(`/v1/destinations/${id}/test`, {});
        const r = res.data;
        // Adapter `message` is controlled by the destination receiver
        // (a customer-installed webhook URL is third-party-controlled).
        // Wrap so a crafted reply body can't inject prompt instructions
        // via the test surface. Same risk on the structuredContent
        // channel — strip dangerous code points from r.message / r.code
        // so a host that surfaces structuredContent direct-to-model also
        // sees sanitised text.
        sanitizeUntrustedFields(r, ["message", "code"]);
        if (r.ok) {
          return {
            content: [
              { type: "text", text: `✓ ${wrapUntrusted(r.message ?? "Connection OK.", 500)}` },
            ],
            structuredContent: r,
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                `✗ ${wrapUntrusted(r.code, 64)}: ${wrapUntrusted(r.message, 500)}` +
                (r.retryable ? " (retryable)" : ""),
            },
          ],
          structuredContent: r,
          isError: false, // test is informational; not a tool failure
        };
      },
    }),
  ];
}
