/**
 * Zod schemas for the Experiment primitive — vendored from the Sheepit API
 * contract (`packages/shared/src/schemas/platform.ts`).
 *
 * Experiments are project-scoped A/B/n tests bound to one environment, with
 * weighted variants (exactly one control, weights summing to 100) and at
 * least one primary metric. The MCP `experiment_*` tools wrap the existing
 * `/v1/experiments` routes (all require a secret key — the route registers
 * `requireSecretKey` as an onRequest hook for the whole plugin):
 *   POST  /v1/experiments      → experiment_create (secret key + editor role)
 *   PATCH /v1/experiments/:id  → experiment_update (secret key + editor; draft-only)
 *   GET   /v1/experiments      → experiment_list   (secret key + viewer)
 *   GET   /v1/experiments/:id  → experiment_get    (secret key + viewer)
 *
 * The server is always the source of truth — mirror any API tightening here.
 * The cross-field invariants (one control, weights = 100, a primary metric,
 * environment belongs to project) are re-checked server-side and surface as
 * 400s, so this client only enforces the per-field shape.
 */

import { z } from "zod";

/** snake_case, 2-128 chars, no leading number — same as flag keys. */
const experimentKeyRegex = /^[a-z][a-z0-9_]{1,127}$/;

export const createExperimentSchema = z.object({
  key: z.string().regex(experimentKeyRegex, {
    message:
      "Key must start with a lowercase letter, be 2–128 chars, use only lowercase letters, numbers, underscores",
  }),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  hypothesis: z.string().max(2000).optional(),
  environment_id: z.string().uuid(),
  traffic_pct: z.number().int().min(1).max(100).default(10),
  variants: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        name: z.string().min(1).max(200),
        is_control: z.boolean().default(false),
        weight: z.number().int().min(1).max(100),
        payload: z.record(z.unknown()).default({}),
      }),
    )
    .min(2)
    .max(10),
  metrics: z
    .array(
      z.object({
        event_name: z.string().min(1).max(200),
        metric_type: z.enum(["conversion", "count", "sum", "average", "p50", "p95", "p99"]),
        aggregation_field: z.string().max(128).optional(),
        is_primary: z.boolean().default(false),
        is_guardrail: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(20),
});

export const updateExperimentSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  hypothesis: z.string().max(2000).optional(),
  traffic_pct: z.number().int().min(1).max(100).optional(),
});

export const experimentListQuerySchema = z.object({
  status: z.enum(["draft", "running", "paused", "completed", "archived"]).optional(),
  search: z.string().max(200).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateExperimentInput = z.infer<typeof createExperimentSchema>;
export type UpdateExperimentInput = z.infer<typeof updateExperimentSchema>;
