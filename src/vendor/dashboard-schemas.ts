/**
 * Dashboard / widget / insights-query input schemas — vendored from the
 * Sheepit API contract.
 *
 * The widget-shape primitives (`widgetTypeSchema`, `widgetVizSchema`,
 * `widgetPositionSchema`, `insightsQuerySchema`) live in `./insights-query`
 * and are re-used here.
 */

import { z } from "zod";
import {
  insightsQuerySchema,
  widgetTypeSchema,
  widgetVizSchema,
  widgetPositionSchema,
} from "./insights-query.js";

// ── Dashboard CRUD ──────────────────────────────────────────────────────

export const createDashboardSchema = z.object({
  name: z.string().min(1).max(120).describe("Human-readable name."),
  description: z.string().max(500).optional(),
  layout: z.record(z.string(), z.unknown()).optional(),
});
export type CreateDashboardInput = z.infer<typeof createDashboardSchema>;

export const updateDashboardSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    /** `null` clears the description; omitted leaves it unchanged. */
    description: z.string().max(500).nullable().optional(),
    layout: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type UpdateDashboardInput = z.infer<typeof updateDashboardSchema>;

export const dashboardListQuerySchema = z.object({}).strict();
export type DashboardListQuery = z.infer<typeof dashboardListQuerySchema>;

// ── Widget CRUD ─────────────────────────────────────────────────────────

export const createWidgetSchema = z.object({
  type: widgetTypeSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  position: widgetPositionSchema.optional(),
  query: insightsQuerySchema,
  viz: widgetVizSchema.optional(),
});
export type CreateWidgetInput = z.infer<typeof createWidgetSchema>;

export const updateWidgetSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).nullable().optional(),
    position: widgetPositionSchema.optional(),
    query: insightsQuerySchema.optional(),
    viz: widgetVizSchema.optional(),
  })
  .strict();
export type UpdateWidgetInput = z.infer<typeof updateWidgetSchema>;

// ── Insights query (the LLM power tool) ─────────────────────────────────

export const insightsQueryRequestSchema = z.object({
  /** Optional environment override; defaults to the API-key's environment. */
  environment_id: z.string().uuid().optional(),
  query: insightsQuerySchema,
});
export type InsightsQueryRequest = z.infer<typeof insightsQueryRequestSchema>;

// ── Materialize (atomic dashboard + widgets in one call) ─────────────────

/**
 * Payload schema for `POST /v1/dashboards/materialize`.
 * Creates the Dashboard + all Widget rows in a single Prisma $transaction.
 *
 * Keep in sync with `packages/shared/src/insights/materialize.ts`.
 */
export const materializeWidgetSchema = z.object({
  type: widgetTypeSchema,
  name: z.string().max(120),
  description: z.string().max(500).optional(),
  query: insightsQuerySchema,
  viz: widgetVizSchema.optional(),
  position: widgetPositionSchema.optional(),
});
export type MaterializeWidgetInput = z.infer<typeof materializeWidgetSchema>;

export const dashboardMaterializeSchema = z.object({
  name: z.string().min(1).max(120).describe("Human-readable name for the new dashboard."),
  description: z.string().max(500).optional(),
  layout: z.record(z.string(), z.unknown()).optional(),
  widgets: z.array(materializeWidgetSchema).min(1).max(24),
});
export type DashboardMaterializeInput = z.infer<typeof dashboardMaterializeSchema>;

// ── Template id (string, validated against the registry at use-site) ────

/**
 * Template ids are validated against `findTemplateBlueprint(id)` rather than
 * enumerated in zod. Keeping this loose lets templates be added without a
 * coordinated SDK release; the MCP tool re-validates the id against the live
 * registry and 400s if unknown.
 */
export const templateIdSchema = z.string().min(1).max(80);
