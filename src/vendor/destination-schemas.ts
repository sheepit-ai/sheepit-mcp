/**
 * Destination framework — Zod contracts, vendored from the Sheepit API
 * contract.
 *
 * A `DestinationConfig` is a per-(project, env) install of an adapter
 * (`connectorId` keys into a code-only registry on the API side). The
 * `config` JSONB is validated by the adapter's own configSchema at write
 * time; a generic shape is exposed here.
 */

import { z } from "zod";
import { ruleConditionsSchema } from "./rule-conditions.js";

// ── Status ──────────────────────────────────────────────────────────────

export const destinationStatusSchema = z.enum(["active", "paused", "failed"]);
export type DestinationStatus = z.infer<typeof destinationStatusSchema>;

export const deliveryStatusSchema = z.enum(["pending", "succeeded", "failed", "dlq"]);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

// ── Connector identifier ────────────────────────────────────────────────

/**
 * Connector IDs the API recognises. Only adapters with shipping
 * implementations are listed; calling `destination_create` with an
 * unlisted connector returns `UNKNOWN_CONNECTOR` from the registry. More
 * adapters (Meta CAPI, Google Ads, etc.) are added per release.
 */
export const connectorIdSchema = z.enum(["webhook", "resend"]);
export type ConnectorId = z.infer<typeof connectorIdSchema>;

// ── Config shape (per-adapter; loose at this layer) ─────────────────────

/**
 * Bounded per-adapter config — string keys ≤ 64 chars, leaf values confined
 * to scalars + null. Adapters layer their own stricter validation on top.
 */
const configLeafSchema = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const destinationConfigBlobSchema = z
  .record(z.string().min(1).max(64), configLeafSchema)
  .refine((r) => Object.keys(r).length <= 32, {
    message: "destination.config is limited to 32 keys",
  });

// ── Create / Update ─────────────────────────────────────────────────────

export const createDestinationSchema = z.object({
  connector_id: connectorIdSchema,
  name: z.string().min(1).max(200),
  environment_id: z.string().uuid().optional(),
  config: destinationConfigBlobSchema.default({}),
  filters: ruleConditionsSchema.default([]),
});
export type CreateDestinationInput = z.infer<typeof createDestinationSchema>;

export const updateDestinationSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  config: destinationConfigBlobSchema.optional(),
  filters: ruleConditionsSchema.optional(),
  /** Toggle between active and paused. The "failed" state is system-only
   *  and cannot be set via this endpoint. */
  status: z.enum(["active", "paused"]).optional(),
});
export type UpdateDestinationInput = z.infer<typeof updateDestinationSchema>;

// ── List query ──────────────────────────────────────────────────────────

export const destinationListQuerySchema = z.object({
  connector_id: connectorIdSchema.optional(),
  status: destinationStatusSchema.optional(),
  include_archived: z.coerce.boolean().default(false),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type DestinationListQuery = z.infer<typeof destinationListQuerySchema>;

// ── Test dispatch ───────────────────────────────────────────────────────

/**
 * `POST /v1/destinations/:id/test` runs the adapter's `validateConnection`
 * helper against the saved config and (where supported) sends a synthetic
 * payload. Body is empty — every test is config-only.
 */
export const testDestinationSchema = z.object({}).strict();
