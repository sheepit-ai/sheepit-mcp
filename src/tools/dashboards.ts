/**
 * Dashboard / Widget / Insights tools for the MCP server (Layer 4a).
 *
 * Closes the analytics loop in conversation: an LLM can list dashboards,
 * read existing ones, create new ones from a template OR from scratch,
 * add / update / remove widgets, and run arbitrary timeseries queries.
 *
 * The killer tool is `insights_query` — once an LLM can run any timeseries
 * against `events_raw`, it can answer "did signup rate drop after the last
 * deploy?" / "which UTM source converts best?" / "what's our crash-free
 * rate this morning?" without you ever opening a dashboard.
 *
 * Pairs with the existing campaign + destination surfaces:
 *   1. campaign_launch  → emails go out
 *   2. insights_query   → "did anyone open them?"
 *   3. dashboard_create → snapshot the answer for later
 */

import { z } from "zod";
import {
  createDashboardSchema,
  updateDashboardSchema,
  dashboardListQuerySchema,
  createWidgetSchema,
  updateWidgetSchema,
  insightsQueryRequestSchema,
  templateIdSchema,
  DASHBOARD_TEMPLATE_BLUEPRINTS,
  findTemplateBlueprint,
} from "../vendor/index.js";
import type { ApiClient } from "../lib/api-client.js";
import { wrapUntrusted, sanitizeUntrustedFields } from "../lib/untrust.js";
import { type Tool, defineTool } from "./define.js";

// Customer-controlled fields on Dashboards / Widgets that round-trip
// via the structuredContent channel.
const DASHBOARD_FIELDS = ["name", "description"];
const DASHBOARD_LIST_FIELDS = DASHBOARD_FIELDS.map((f) => `*.${f}`);
const WIDGET_FIELDS = ["name", "description"];

interface DashboardsToolDeps {
  api: ApiClient;
}

interface DashboardEnvelope {
  data: {
    id: string;
    name: string;
    description: string | null;
    [k: string]: unknown;
  };
}

interface ListDashboardsEnvelope {
  data: Array<{ id: string; name: string; description: string | null; created_at: string }>;
}

interface WidgetEnvelope {
  data: {
    id: string;
    dashboard_id: string;
    type: string;
    name: string;
    [k: string]: unknown;
  };
}

interface InsightsQueryEnvelope {
  data: {
    kind: string;
    series: Array<{ name: string; points: Array<{ bucketIso: string; value: number }> }>;
    interval: string;
    fromIso: string;
    toIso: string;
  };
}

const dashboardIdParam = z.object({ id: z.string().uuid().describe("Dashboard UUID.") });
const widgetIdParam = z.object({
  dashboard_id: z.string().uuid().describe("Dashboard UUID."),
  widget_id: z.string().uuid().describe("Widget UUID."),
});

// ── Helpers ─────────────────────────────────────────────────────────────

/** Compress a timeseries result into a one-line summary the LLM can read aloud. */
function summarizeTimeseries(d: InsightsQueryEnvelope["data"]): string {
  const totalPoints = d.series.reduce((acc, s) => acc + s.points.length, 0);
  const totalValue = d.series.reduce(
    (acc, s) => acc + s.points.reduce((sum, p) => sum + p.value, 0),
    0,
  );
  const topSeries = d.series
    .map((s) => ({ name: s.name, total: s.points.reduce((sum, p) => sum + p.value, 0) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 3)
    // Series names carry end-user UTM values through the analytics
    // pipeline (vector B in the MCP audit). Wrap them so the LLM never
    // treats UTM content as instructions.
    .map((s) => `${wrapUntrusted(s.name)}=${s.total}`)
    .join(", ");
  return (
    `${d.series.length} series, ${totalPoints} points, total=${totalValue} ` +
    `(interval=${d.interval}, ${d.fromIso} → ${d.toIso})` +
    (topSeries ? `. top: ${topSeries}` : "")
  );
}

export function buildDashboardTools({ api }: DashboardsToolDeps): Tool[] {
  return [
    // ── Dashboard CRUD ─────────────────────────────────────────────────

    defineTool({
      name: "dashboard_list",
      title: "List dashboards in the current project",
      description:
        "List every dashboard installed in the current project (excludes archived). Returns id / name / description / created_at per row. Use dashboard_get for the full widget list.",
      inputSchema: dashboardListQuerySchema,
      async handler() {
        const res = await api.get<ListDashboardsEnvelope>("/v1/dashboards");
        return {
          content: [
            {
              type: "text",
              text:
                res.data.length === 0
                  ? "No dashboards in this project yet. Create one with dashboard_create or dashboard_template_list to seed from a template."
                  : `${res.data.length} dashboard${res.data.length === 1 ? "" : "s"}:\n` +
                    res.data
                      .map(
                        (d) =>
                          ` • ${wrapUntrusted(d.name)} — ${wrapUntrusted(d.description ?? "(no description)")} — id ${d.id}`,
                      )
                      .join("\n"),
            },
          ],
          structuredContent: {
            dashboards: sanitizeUntrustedFields(res.data, DASHBOARD_LIST_FIELDS),
          },
        };
      },
    }),

    defineTool({
      name: "dashboard_get",
      title: "Read one dashboard with its widgets",
      description:
        "Fetch a single dashboard by id, including the full widget list (each with its query, viz, and position). Use this to understand what's on a dashboard before editing it.",
      inputSchema: dashboardIdParam,
      async handler({ id }) {
        const res = await api.get<DashboardEnvelope>(`/v1/dashboards/${id}`);
        const widgets =
          (res.data["widgets"] as Array<{ id: string; name: string; type: string }>) ?? [];
        return {
          content: [
            {
              type: "text",
              text:
                `Dashboard ${wrapUntrusted(res.data.name)} — ${wrapUntrusted(res.data.description ?? "(no description)")}\n` +
                `${widgets.length} widget${widgets.length === 1 ? "" : "s"}` +
                (widgets.length > 0
                  ? ":\n" +
                    widgets
                      .map((w) => ` • ${wrapUntrusted(w.name)} (${w.type}) — id ${w.id}`)
                      .join("\n")
                  : "."),
            },
          ],
          structuredContent: { dashboard: sanitizeUntrustedFields(res.data, DASHBOARD_FIELDS) },
        };
      },
    }),

    defineTool({
      name: "dashboard_create",
      title: "Create a new (empty) dashboard",
      description:
        "Create an empty dashboard with `name` and optional `description`. Returns the new id. Use widget_create afterward to add widgets, or use dashboard_template_get + a script of widget_create calls to materialize a template manually. " +
        "If you want a fully-populated starter, use dashboard_template_list to see what's available, then dashboard_template_get to get the widget specs.",
      inputSchema: createDashboardSchema,
      async handler(input) {
        const res = await api.post<DashboardEnvelope>("/v1/dashboards", input);
        return {
          content: [
            {
              type: "text",
              text: `Created dashboard ${wrapUntrusted(res.data.name)}. Id: ${res.data.id}.`,
            },
          ],
          structuredContent: { dashboard: sanitizeUntrustedFields(res.data, DASHBOARD_FIELDS) },
        };
      },
    }),

    defineTool({
      name: "dashboard_update",
      title: "Update an existing dashboard",
      description:
        "Update name / description / layout of an existing dashboard. Trinary semantics for nullable fields: omit = preserve, send `null` to clear, send a value to overwrite. Templates (is_template = true) can't be edited via this tool — they're read-only.",
      inputSchema: updateDashboardSchema.extend({ id: z.string().uuid() }),
      async handler(input) {
        const { id, ...body } = input;
        const res = await api.patch<DashboardEnvelope>(`/v1/dashboards/${id}`, body);
        return {
          content: [{ type: "text", text: `Updated dashboard ${wrapUntrusted(res.data.name)}.` }],
          structuredContent: { dashboard: sanitizeUntrustedFields(res.data, DASHBOARD_FIELDS) },
        };
      },
    }),

    defineTool({
      name: "dashboard_delete",
      title: "Soft-delete (archive) a dashboard",
      description:
        "Soft-delete a dashboard — it stops appearing in dashboard_list but its history is retained. Templates can't be deleted.",
      inputSchema: dashboardIdParam,
      async handler({ id }) {
        await api.delete(`/v1/dashboards/${id}`);
        return {
          content: [{ type: "text", text: `Archived dashboard ${id}.` }],
          structuredContent: { id, archived: true },
        };
      },
    }),

    // ── Templates ──────────────────────────────────────────────────────

    defineTool({
      name: "dashboard_template_list",
      title: "List built-in dashboard templates",
      description:
        "Read-only enumeration of every starter dashboard the platform ships with. Returns id / name / tagline / description / icon / widget_count per template. Use dashboard_template_get(id) to retrieve the full widget specs, then materialize via dashboard_create + widget_create calls.",
      inputSchema: z.object({}).strict(),
      async handler() {
        const summary = DASHBOARD_TEMPLATE_BLUEPRINTS.map((t) => ({
          id: t.id,
          name: t.name,
          tagline: t.tagline,
          description: t.description,
          icon: t.icon,
          widget_count: t.widgets.length,
        }));
        const lines = summary.map(
          (t) => ` ${t.icon} ${t.name} — ${t.tagline} (${t.widget_count} widgets) — id "${t.id}"`,
        );
        return {
          content: [
            {
              type: "text",
              text: `${summary.length} template${summary.length === 1 ? "" : "s"} available:\n${lines.join("\n")}`,
            },
          ],
          structuredContent: { templates: summary },
        };
      },
    }),

    defineTool({
      name: "dashboard_template_get",
      title: "Get the full widget specs for a template",
      description:
        "Returns the full blueprint for a template (id, name, description, icon, full widgets array with each query + viz + position). Use this to fetch the recipe, then call dashboard_create + a widget_create per item to materialize it. Returns 404 if the template id is unknown.",
      inputSchema: z.object({
        template_id: templateIdSchema.describe(
          "Template id from dashboard_template_list (e.g. 'soft-launch-funnel').",
        ),
      }),
      async handler({ template_id }) {
        const blueprint = findTemplateBlueprint(template_id);
        if (!blueprint) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown template: "${template_id}". Run dashboard_template_list to see what's available.`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                `Template "${blueprint.name}" (${blueprint.id}) — ${blueprint.tagline}\n` +
                `${blueprint.widgets.length} widgets to materialize.`,
            },
          ],
          structuredContent: { template: blueprint },
        };
      },
    }),

    // ── Widgets ────────────────────────────────────────────────────────

    defineTool({
      name: "widget_create",
      title: "Add a widget to a dashboard",
      description:
        "Create a new widget on the given dashboard. " +
        "`type` is a widget type (V1: 'timeseries' only). " +
        "`query` is an InsightsQuery — a discriminated union on `kind` (V1: 'timeseries' only). " +
        "`viz` controls presentation (chartType: 'line' | 'bar' | 'area' | 'stacked_bar' | 'single_metric'). " +
        "`position` defaults to a sensible {x,y,w,h} if omitted. Templates can't have widgets added via this tool.",
      inputSchema: createWidgetSchema.extend({
        dashboard_id: z.string().uuid().describe("Target dashboard."),
      }),
      async handler(input) {
        const { dashboard_id, ...body } = input;
        const res = await api.post<WidgetEnvelope>(`/v1/dashboards/${dashboard_id}/widgets`, body);
        return {
          content: [
            {
              type: "text",
              text: `Created widget ${wrapUntrusted(res.data.name)} (${res.data.type}). Id: ${res.data.id}.`,
            },
          ],
          structuredContent: { widget: sanitizeUntrustedFields(res.data, WIDGET_FIELDS) },
        };
      },
    }),

    defineTool({
      name: "widget_update",
      title: "Update an existing widget",
      description:
        "Update name / description / position / query / viz of a single widget. Trinary semantics for nullable fields. For bulk position changes (drag/drop save), prefer the dashboard layout endpoint at the API level — this tool is for one-widget edits.",
      inputSchema: updateWidgetSchema.extend({
        dashboard_id: z.string().uuid(),
        widget_id: z.string().uuid(),
      }),
      async handler(input) {
        const { dashboard_id, widget_id, ...body } = input;
        const res = await api.patch<WidgetEnvelope>(
          `/v1/dashboards/${dashboard_id}/widgets/${widget_id}`,
          body,
        );
        return {
          content: [{ type: "text", text: `Updated widget ${wrapUntrusted(res.data.name)}.` }],
          structuredContent: { widget: sanitizeUntrustedFields(res.data, WIDGET_FIELDS) },
        };
      },
    }),

    defineTool({
      name: "widget_delete",
      title: "Remove a widget from a dashboard",
      description:
        "Hard-delete a widget. The dashboard remains; only this single widget is removed.",
      inputSchema: widgetIdParam,
      async handler({ dashboard_id, widget_id }) {
        await api.delete(`/v1/dashboards/${dashboard_id}/widgets/${widget_id}`);
        return {
          content: [{ type: "text", text: `Deleted widget ${widget_id}.` }],
          structuredContent: { dashboard_id, widget_id, deleted: true },
        };
      },
    }),

    // ── Insights query (the LLM power tool) ────────────────────────────

    defineTool({
      name: "insights_query",
      title: "Run an arbitrary timeseries query against your events",
      description:
        "Execute a one-shot InsightsQuery without saving it as a widget. " +
        "Use this to answer questions like 'how many signups yesterday?' / 'errors-per-hour by app version this week?' / 'which utm_source converted best in the last 30 days?'. " +
        // Describe the wire envelope explicitly — every field nests
        // under `query`. Examples below mirror the shapes that pass
        // `insightsQueryRequestSchema.safeParse()`.
        "Input envelope: `{ environment_id?: uuid, query: { kind, event, interval, range, filters?, breakdownProperty?, aggregation? } }`. " +
        "`query.kind` is always 'timeseries' (the v1 surface). " +
        "`query.event` is an event name from event_catalog_canonical. " +
        "`query.interval` is one of 'minute'|'hour'|'day'|'week'. " +
        "`query.range` is either `{kind: 'relative', last: '1h'|'24h'|'7d'|'30d'|'90d'}` or `{kind: 'absolute', fromIso: iso, toIso: iso}` (note: the absolute keys are `fromIso`/`toIso`, both full ISO-8601 datetimes). " +
        "`query.filters` is an array of `{field, op, value}`; field names are dot-paths under `event_properties` / `event_context` (e.g. 'event_properties.course_slug'). " +
        "`query.breakdownProperty` is a single property path that splits the series (caps at 20 distinct values). " +
        "`query.aggregation` is `{kind: 'count'}` (default) or `{kind: 'count_distinct', field: 'user_id'}`. " +
        "Returns gap-filled buckets; a missing time bucket is rendered as 0.",
      inputSchema: insightsQueryRequestSchema,
      async handler(input) {
        const res = await api.post<InsightsQueryEnvelope>("/v1/insights/query", input);
        // series.name comes from a group-by over customer-controlled
        // event_properties (UTM values, custom prop names). Strip
        // dangerous code points before structuredContent exposes the
        // result to the host LLM.
        sanitizeUntrustedFields(res.data, ["series.*.name"]);
        return {
          content: [{ type: "text", text: summarizeTimeseries(res.data) }],
          structuredContent: { result: res.data },
        };
      },
    }),
  ];
}
