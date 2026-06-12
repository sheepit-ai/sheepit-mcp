/**
 * Insights Query DSL — vendored from the Sheepit API contract.
 *
 * A discriminated union of analysis "kinds" that widgets request from the
 * server. The server pattern-matches on `kind`, builds a parameterized SQL
 * query against the event store, and returns shaped data. Customers never
 * write raw SQL — every query is encoded as one of these shapes.
 *
 * V1 ships `timeseries` only. Unrecognized `kind` values are a 400 (no
 * graceful forward-compat — the server tells the client to upgrade).
 */

import { z } from "zod";

// ── Filters ────────────────────────────────────────────────────────────

export const filterOpSchema = z.enum([
  "eq",
  "neq",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_null",
  "is_not_null",
]);
export type FilterOp = z.infer<typeof filterOpSchema>;

/**
 * One predicate against an event column or property.
 *
 *   - `field` is either a top-level column name (`event_name`, `device_id`,
 *     `user_id`, `platform`, etc.) or a JSON path into `event_properties` /
 *     `event_context` using dot notation (`event_properties.outcome`,
 *     `event_context.attribution.utm_source`). The query builder maps this
 *     safely — no raw SQL injection.
 *   - `value` types match the operator. `is_null`/`is_not_null` ignore it.
 */
export const queryFilterSchema = z.object({
  field: z.string().min(1).max(120),
  op: filterOpSchema,
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.array(z.number())])
    .optional(),
});
export type QueryFilter = z.infer<typeof queryFilterSchema>;

// ── Time range ─────────────────────────────────────────────────────────

/**
 * Either a relative window expressed as a "last N period" preset, OR an
 * absolute ISO range. The server resolves relative windows to absolute
 * timestamps at query time.
 */
export const timeRangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("relative"),
    last: z.enum(["1h", "24h", "7d", "30d", "90d"]),
  }),
  z.object({
    kind: z.literal("absolute"),
    fromIso: z.string().datetime(),
    toIso: z.string().datetime(),
  }),
]);
export type TimeRange = z.infer<typeof timeRangeSchema>;

export const intervalSchema = z.enum(["minute", "hour", "day", "week"]);
export type QueryInterval = z.infer<typeof intervalSchema>;

// ── Query: timeseries ──────────────────────────────────────────────────

/**
 * Timeseries: count events grouped by time bucket. Optionally split by a
 * single property (breakdown) into multiple series.
 *
 * Examples:
 *   - "page views per day for the last 7d"     → event=$page_view, interval=day
 *   - "errors per hour split by browser"        → event=$error, interval=hour, breakdown=browser
 *   - "module_started per day, course=foo only" → filters=[{field:"event_properties.course_slug", op:"eq", value:"foo"}]
 */
export const timeseriesQuerySchema = z.object({
  kind: z.literal("timeseries"),
  event: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[$a-zA-Z][a-zA-Z0-9_]*$/, "Invalid event name"),
  filters: z.array(queryFilterSchema).max(20).default([]),
  /** Optional property name to split into series. Caps at 20 distinct
   * values; everything else collapses into "(other)". */
  breakdownProperty: z.string().min(1).max(120).optional(),
  interval: intervalSchema,
  range: timeRangeSchema,
  /** Aggregation: count rows OR count distinct values of a property
   * (e.g. unique users via `count_distinct: "user_id"`). */
  aggregation: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("count") }),
      z.object({ kind: z.literal("count_distinct"), field: z.string().min(1).max(120) }),
    ])
    .default({ kind: "count" }),
});
export type TimeseriesQuery = z.infer<typeof timeseriesQuerySchema>;

// ── Insights query (discriminated union — extend per phase) ────────────

export const insightsQuerySchema = z.discriminatedUnion("kind", [timeseriesQuerySchema]);
export type InsightsQuery = z.infer<typeof insightsQuerySchema>;

// ── Query result shape ─────────────────────────────────────────────────

/**
 * Timeseries result: one or more named series, each a list of
 * `{bucketIso, value}` points. The server fills missing buckets with 0
 * so the renderer can plot a continuous line without gap detection.
 */
export interface TimeseriesPoint {
  bucketIso: string;
  value: number;
}

export interface TimeseriesSeries {
  name: string;
  points: TimeseriesPoint[];
}

export interface TimeseriesResult {
  kind: "timeseries";
  series: TimeseriesSeries[];
  /** Echoed for the renderer so it can label axes correctly. */
  interval: QueryInterval;
  /** Resolved absolute time bounds. */
  fromIso: string;
  toIso: string;
}

export type InsightsQueryResult = TimeseriesResult;

// ── Visualization config (query says WHAT, viz says HOW) ─────────────────

export const widgetChartTypeSchema = z.enum([
  "line",
  "bar",
  "area",
  "stacked_bar",
  /**
   * Display the result as a single big number (sum / last value of the
   * timeseries) — KPI tile. The query is still a timeseries; only the
   * presentation collapses to a scalar + a small sparkline.
   */
  "single_metric",
]);
export type WidgetChartType = z.infer<typeof widgetChartTypeSchema>;

export const timeseriesVizSchema = z.object({
  kind: z.literal("timeseries"),
  chartType: widgetChartTypeSchema.default("line"),
  /** Optional Y-axis label. */
  yLabel: z.string().max(60).optional(),
});
export type TimeseriesViz = z.infer<typeof timeseriesVizSchema>;

export const widgetVizSchema = z.discriminatedUnion("kind", [timeseriesVizSchema]);
export type WidgetViz = z.infer<typeof widgetVizSchema>;

// ── Widget type (string for forward-compat — not all types exist in V1) ──

export const widgetTypeSchema = z.enum([
  "timeseries",
  // future: "single_metric", "top_n", "table", "funnel", "retention"
]);
export type WidgetType = z.infer<typeof widgetTypeSchema>;

// ── Widget position (react-grid-layout convention) ─────────────────────

export const widgetPositionSchema = z.object({
  x: z.number().int().min(0).max(48),
  y: z.number().int().min(0).max(1024),
  w: z.number().int().min(1).max(48),
  h: z.number().int().min(1).max(48),
});
export type WidgetPosition = z.infer<typeof widgetPositionSchema>;
