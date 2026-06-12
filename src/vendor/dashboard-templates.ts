/**
 * Dashboard template blueprints — vendored from the Sheepit API contract.
 *
 * These are the "starter dashboards" a project can be seeded with. Each
 * blueprint is UI-agnostic: it describes the dashboard NAME, DESCRIPTION,
 * ICON, and the full WIDGET SET (each widget = a query + viz + position),
 * nothing more. The MCP `dashboard_template_list` / `dashboard_template_get`
 * tools read these so an LLM can "show me the templates" → "create one."
 *
 * The five v1 templates:
 *   1. soft-launch-funnel — sessions → enrollments funnel
 *   2. dau-engagement     — DAU / WAU + engagement timeseries
 *   3. acquisition        — UTM attribution + signup funnel
 *   4. friction           — rage clicks, dead clicks, page leaves, signup errors
 *   5. errors             — error rate + version breakdown
 *
 * Adding a template = append a `DashboardTemplateBlueprint` to
 * `DASHBOARD_TEMPLATE_BLUEPRINTS`; the MCP tool picks it up automatically.
 */

import type { TimeseriesQuery, WidgetViz, WidgetPosition } from "./insights-query.js";

// ── Public types ────────────────────────────────────────────────────────

export interface DashboardTemplateWidget {
  /** Optional — empty string lets the renderer derive a name from the query. */
  name: string;
  query: TimeseriesQuery;
  viz?: WidgetViz;
  position: WidgetPosition;
}

export interface DashboardTemplateBlueprint {
  /** Stable id (kebab-case). Used by the picker, the MCP tool, and any
   *  future "is_template" rows seeded into a real project. */
  id: string;
  name: string;
  /** Short, scannable subtitle (≤ 60 chars typical). */
  tagline: string;
  /** Longer paragraph shown on hover/preview. */
  description: string;
  /** Single emoji shown in the picker tile. */
  icon: string;
  widgets: DashboardTemplateWidget[];
}

// ── Helpers ─────────────────────────────────────────────────────────────

function tsCount(
  event: string,
  opts: {
    interval?: TimeseriesQuery["interval"];
    range?: "1h" | "24h" | "7d" | "30d" | "90d";
    breakdown?: string;
    filters?: TimeseriesQuery["filters"];
  } = {},
): TimeseriesQuery {
  return {
    kind: "timeseries",
    event,
    filters: opts.filters ?? [],
    interval: opts.interval ?? "day",
    range: { kind: "relative", last: opts.range ?? "30d" },
    aggregation: { kind: "count" },
    ...(opts.breakdown ? { breakdownProperty: opts.breakdown } : {}),
  };
}

function tsUnique(
  event: string,
  field: string,
  opts: {
    interval?: TimeseriesQuery["interval"];
    range?: "1h" | "24h" | "7d" | "30d" | "90d";
    breakdown?: string;
  } = {},
): TimeseriesQuery {
  return {
    kind: "timeseries",
    event,
    filters: [],
    interval: opts.interval ?? "day",
    range: { kind: "relative", last: opts.range ?? "30d" },
    aggregation: { kind: "count_distinct", field },
    ...(opts.breakdown ? { breakdownProperty: opts.breakdown } : {}),
  };
}

const lineViz: WidgetViz = { kind: "timeseries", chartType: "line" };
const areaViz: WidgetViz = { kind: "timeseries", chartType: "area" };
const tileViz: WidgetViz = { kind: "timeseries", chartType: "single_metric" };

// ── Soft Launch Funnel ──────────────────────────────────────────────────
//
// The single most useful dashboard during soft launch (~first 8 weeks).
// At <500 weekly visitors, copy A/B tests can't reach significance — but
// stage-by-stage drop-off is visible after ~50 sessions. Read this daily.
//
// The funnel:
//   $session_start → course_viewed → module_started → module_completed
//                  → course_enrolled → signup_completed
//
// Two highest-leverage drops to watch:
//   1. course_viewed → module_started      (catalog interest → free trial)
//   2. module_completed → course_enrolled  (free trial → buy decision)

const softLaunchFunnel: DashboardTemplateBlueprint = {
  id: "soft-launch-funnel",
  name: "Soft Launch Funnel",
  tagline: "End-to-end course funnel — sessions → enrollments",
  description:
    "Find where visitors drop off in the course funnel. KPI tiles for the four key gates (sessions / course detail views / free module starts / enrollments) over the last 24h, plus 30-day trends below. The two drops to watch hardest: course_viewed → module_started (interest → trial) and module_completed → course_enrolled (trial → buy).",
  icon: "🪜",
  widgets: [
    // Row 0 — KPI tiles for the four conversion gates (last 24h).
    {
      name: "Sessions (24h)",
      query: tsUnique("$session_start", "anonymous_id", { interval: "hour", range: "24h" }),
      viz: tileViz,
      position: { x: 0, y: 0, w: 3, h: 2 },
    },
    {
      name: "Course detail views (24h)",
      query: tsCount("course_viewed", { interval: "hour", range: "24h" }),
      viz: tileViz,
      position: { x: 3, y: 0, w: 3, h: 2 },
    },
    {
      name: "Free module starts (24h)",
      query: tsCount("module_started", { interval: "hour", range: "24h" }),
      viz: tileViz,
      position: { x: 6, y: 0, w: 3, h: 2 },
    },
    {
      name: "Enrollments (24h)",
      query: tsCount("course_enrolled", { interval: "hour", range: "24h" }),
      viz: tileViz,
      position: { x: 9, y: 0, w: 3, h: 2 },
    },
    // Row 2 — top-of-funnel: visitors → catalog interest.
    {
      name: "Sessions per day (30d)",
      query: tsUnique("$session_start", "anonymous_id", { interval: "day", range: "30d" }),
      viz: areaViz,
      position: { x: 0, y: 2, w: 6, h: 3 },
    },
    {
      name: "Course detail views per day (30d)",
      query: tsCount("course_viewed", { interval: "day", range: "30d" }),
      viz: areaViz,
      position: { x: 6, y: 2, w: 6, h: 3 },
    },
    // Row 5 — middle-of-funnel: free trial engagement (THE biggest expected drop).
    {
      name: "Free module starts per day (30d)",
      query: tsCount("module_started", { interval: "day", range: "30d" }),
      viz: areaViz,
      position: { x: 0, y: 5, w: 6, h: 3 },
    },
    {
      name: "Free module completions per day (30d)",
      query: tsCount("module_completed", { interval: "day", range: "30d" }),
      viz: areaViz,
      position: { x: 6, y: 5, w: 6, h: 3 },
    },
    // Row 8 — bottom-of-funnel: actual conversion + signup attribution.
    {
      name: "Enrollments per day (30d)",
      query: tsCount("course_enrolled", { interval: "day", range: "30d" }),
      viz: areaViz,
      position: { x: 0, y: 8, w: 6, h: 3 },
    },
    {
      name: "Signups by source (30d)",
      query: tsCount("signup_completed", {
        interval: "day",
        range: "30d",
        breakdown: "event_context.attribution.utm_source",
      }),
      viz: lineViz,
      position: { x: 6, y: 8, w: 6, h: 3 },
    },
    // Row 11 — drop-off diagnostics: where in a module do users bail?
    {
      name: "Module scroll depth — 50% reached (30d)",
      query: tsCount("module_scrolled_50", { interval: "day", range: "30d" }),
      viz: lineViz,
      position: { x: 0, y: 11, w: 6, h: 3 },
    },
    {
      name: "Module scroll depth — 100% reached (30d)",
      query: tsCount("module_scrolled_100", { interval: "day", range: "30d" }),
      viz: lineViz,
      position: { x: 6, y: 11, w: 6, h: 3 },
    },
    // Row 14 — early-launch signal tiles:
    //   - early-access cohort isolated from total enrollments
    //   - feedback velocity (proxy for "are users engaged enough to
    //     bother telling us things are wrong?")
    {
      name: "Early-access enrollments (24h)",
      query: tsCount("course_enrolled", {
        interval: "hour",
        range: "24h",
        filters: [{ field: "event_properties.source", op: "eq", value: "early_access" }],
      }),
      viz: tileViz,
      position: { x: 0, y: 14, w: 3, h: 2 },
    },
    {
      name: "Feedback (24h)",
      query: tsCount("feedback_submitted", { interval: "hour", range: "24h" }),
      viz: tileViz,
      position: { x: 3, y: 14, w: 3, h: 2 },
    },
    {
      name: "NPS responses (24h)",
      query: tsCount("nps_submitted", { interval: "hour", range: "24h" }),
      viz: tileViz,
      position: { x: 6, y: 14, w: 3, h: 2 },
    },
    {
      name: "Feedback opened — widget clicked (24h)",
      query: tsCount("feedback_opened", { interval: "hour", range: "24h" }),
      viz: tileViz,
      position: { x: 9, y: 14, w: 3, h: 2 },
    },
    // Row 16 — attribution detail. The 20-distinct-values cap collapses the
    // long tail into "(other)" — fine for a dashboard.
    {
      name: "Sessions by referrer host (30d)",
      query: tsUnique("$session_start", "anonymous_id", {
        interval: "day",
        range: "30d",
        breakdown: "event_context.attribution.referrer_host",
      }),
      viz: lineViz,
      position: { x: 0, y: 16, w: 6, h: 3 },
    },
    {
      name: "Sessions by landing page (30d)",
      query: tsUnique("$session_start", "anonymous_id", {
        interval: "day",
        range: "30d",
        breakdown: "event_context.attribution.landing_page",
      }),
      viz: lineViz,
      position: { x: 6, y: 16, w: 6, h: 3 },
    },
    // Row 19 — feedback by type so the bug/feature/general/nps split is
    // visible at-a-glance.
    {
      name: "Feedback per day by type (30d)",
      query: tsCount("feedback_submitted", {
        interval: "day",
        range: "30d",
        breakdown: "event_properties.feedback_type",
      }),
      viz: lineViz,
      position: { x: 0, y: 19, w: 12, h: 3 },
    },
  ],
};

// ── DAU & Engagement ────────────────────────────────────────────────────

const dauEngagement: DashboardTemplateBlueprint = {
  id: "dau-engagement",
  name: "DAU & Engagement",
  tagline: "Active users + how they engage",
  description:
    "The health pulse for any product. Daily / weekly active users as KPI tiles, plus session and engagement timeseries. Set a country in the control bar to track adoption in a new market.",
  icon: "📈",
  widgets: [
    {
      name: "",
      query: tsUnique("$session_start", "anonymous_id", { interval: "day", range: "30d" }),
      viz: tileViz,
      position: { x: 0, y: 0, w: 3, h: 2 },
    },
    {
      name: "",
      query: tsUnique("$session_start", "anonymous_id", { interval: "week", range: "90d" }),
      viz: tileViz,
      position: { x: 3, y: 0, w: 3, h: 2 },
    },
    {
      name: "Sessions",
      query: tsCount("$session_start", { interval: "day", range: "30d" }),
      viz: areaViz,
      position: { x: 6, y: 0, w: 6, h: 2 },
    },
    {
      name: "",
      query: tsUnique("$session_start", "anonymous_id", { interval: "day", range: "30d" }),
      viz: lineViz,
      position: { x: 0, y: 2, w: 6, h: 3 },
    },
    {
      name: "",
      query: tsCount("module_started", { interval: "day", range: "30d" }),
      viz: lineViz,
      position: { x: 6, y: 2, w: 6, h: 3 },
    },
    {
      name: "",
      query: tsCount("module_completed", { interval: "day", range: "30d" }),
      viz: lineViz,
      position: { x: 0, y: 5, w: 6, h: 3 },
    },
    {
      name: "Sessions by platform",
      query: tsUnique("$session_start", "anonymous_id", {
        interval: "day",
        range: "30d",
        breakdown: "platform",
      }),
      viz: lineViz,
      position: { x: 6, y: 5, w: 6, h: 3 },
    },
  ],
};

// ── Acquisition ─────────────────────────────────────────────────────────

const acquisition: DashboardTemplateBlueprint = {
  id: "acquisition",
  name: "Acquisition",
  tagline: "Where users come from + which sources convert",
  description:
    "Sessions and signups by attribution source — built on the SDK's first-touch UTM capture. Use the global filters to scope to a country or release.",
  icon: "🪝",
  widgets: [
    {
      name: "Signups (30d)",
      query: tsCount("signup_completed", { interval: "day", range: "30d" }),
      viz: tileViz,
      position: { x: 0, y: 0, w: 3, h: 2 },
    },
    {
      name: "New sessions (30d)",
      query: tsCount("$session_start", { interval: "day", range: "30d" }),
      viz: tileViz,
      position: { x: 3, y: 0, w: 3, h: 2 },
    },
    {
      name: "",
      query: tsCount("$session_start", {
        interval: "day",
        range: "30d",
        breakdown: "event_context.attribution.utm_source",
      }),
      viz: lineViz,
      position: { x: 6, y: 0, w: 6, h: 2 },
    },
    {
      name: "Signups per day",
      query: tsCount("signup_completed", { interval: "day", range: "30d" }),
      viz: areaViz,
      position: { x: 0, y: 2, w: 6, h: 3 },
    },
    {
      name: "Signups by source",
      query: tsCount("signup_completed", {
        interval: "day",
        range: "30d",
        breakdown: "event_context.attribution.utm_source",
      }),
      viz: lineViz,
      position: { x: 6, y: 2, w: 6, h: 3 },
    },
    {
      name: "Course enrollments",
      query: tsCount("course_enrolled", { interval: "day", range: "30d" }),
      viz: lineViz,
      position: { x: 0, y: 5, w: 6, h: 3 },
    },
    {
      name: "Signups by referrer host",
      query: tsCount("signup_completed", {
        interval: "day",
        range: "30d",
        breakdown: "event_context.attribution.referrer_host",
      }),
      viz: lineViz,
      position: { x: 6, y: 5, w: 6, h: 3 },
    },
  ],
};

// ── Friction ────────────────────────────────────────────────────────────

const friction: DashboardTemplateBlueprint = {
  id: "friction",
  name: "Friction",
  tagline: "Where users abandon — page leaves, rage clicks, dead clicks",
  description:
    "Powered by the universal SDK frustration events ($rage_click, $dead_click, $page_leave). Every customer using @sheepit-ai/sdk-js gets these events for free.",
  icon: "🥲",
  widgets: [
    {
      name: "Rage clicks (7d)",
      query: tsCount("$rage_click", { interval: "day", range: "7d" }),
      viz: tileViz,
      position: { x: 0, y: 0, w: 3, h: 2 },
    },
    {
      name: "Dead clicks (7d)",
      query: tsCount("$dead_click", { interval: "day", range: "7d" }),
      viz: tileViz,
      position: { x: 3, y: 0, w: 3, h: 2 },
    },
    {
      name: "Page leaves (7d)",
      query: tsCount("$page_leave", { interval: "day", range: "7d" }),
      viz: tileViz,
      position: { x: 6, y: 0, w: 3, h: 2 },
    },
    {
      name: "Signup validation errors (7d)",
      query: tsCount("signup_validation_error", { interval: "day", range: "7d" }),
      viz: tileViz,
      position: { x: 9, y: 0, w: 3, h: 2 },
    },
    {
      name: "Rage clicks per day",
      query: tsCount("$rage_click", { interval: "day", range: "7d" }),
      viz: lineViz,
      position: { x: 0, y: 2, w: 6, h: 3 },
    },
    {
      name: "Dead clicks per day",
      query: tsCount("$dead_click", { interval: "day", range: "7d" }),
      viz: lineViz,
      position: { x: 6, y: 2, w: 6, h: 3 },
    },
    {
      name: "Signup errors by reason",
      query: tsCount("signup_validation_error", {
        interval: "day",
        range: "7d",
        breakdown: "event_properties.reason",
      }),
      viz: lineViz,
      position: { x: 0, y: 5, w: 12, h: 3 },
    },
  ],
};

// ── Errors & Health ─────────────────────────────────────────────────────

const errors: DashboardTemplateBlueprint = {
  id: "errors",
  name: "Errors & Health",
  tagline: "Error rate + uncaught failures by version",
  description:
    "Built on universal SDK error capture. Per-release breakdown helps you spot when a deploy regresses. Add a release_id filter to drill into a specific version.",
  icon: "🚨",
  widgets: [
    {
      name: "Errors (24h)",
      query: tsCount("$error", { interval: "hour", range: "24h" }),
      viz: tileViz,
      position: { x: 0, y: 0, w: 3, h: 2 },
    },
    {
      name: "HTTP errors (24h)",
      query: tsCount("$http_error", { interval: "hour", range: "24h" }),
      viz: tileViz,
      position: { x: 3, y: 0, w: 3, h: 2 },
    },
    {
      name: "Errors per hour",
      query: tsCount("$error", { interval: "hour", range: "24h" }),
      viz: areaViz,
      position: { x: 6, y: 0, w: 6, h: 2 },
    },
    {
      name: "Errors by app version",
      query: tsCount("$error", {
        interval: "hour",
        range: "24h",
        breakdown: "app_version",
      }),
      viz: lineViz,
      position: { x: 0, y: 2, w: 12, h: 3 },
    },
    {
      name: "HTTP errors by status",
      query: tsCount("$http_error", {
        interval: "hour",
        range: "24h",
        breakdown: "event_properties.status",
      }),
      viz: lineViz,
      position: { x: 0, y: 5, w: 12, h: 3 },
    },
  ],
};

// ── Registry ────────────────────────────────────────────────────────────

export const DASHBOARD_TEMPLATE_BLUEPRINTS: DashboardTemplateBlueprint[] = [
  softLaunchFunnel,
  dauEngagement,
  acquisition,
  friction,
  errors,
];

export function findTemplateBlueprint(id: string): DashboardTemplateBlueprint | undefined {
  return DASHBOARD_TEMPLATE_BLUEPRINTS.find((t) => t.id === id);
}
