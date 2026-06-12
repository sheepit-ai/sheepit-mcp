/**
 * Zod contracts for the Campaign composite primitive — vendored from the
 * Sheepit API contract.
 *
 * A `Campaign` bundles audience + channels + creative + (optional)
 * experiment + success metric + budget + schedule into a single object an
 * LLM can reason about end-to-end.
 *
 * State machine (enforced server-side):
 *
 *   draft → scheduled → running → paused → running → completed → archived
 *
 * Mutations via PATCH are only allowed in `draft | paused`. Transitions go
 * through dedicated endpoints with preview/apply discipline on /launch.
 */

import { z } from "zod";
import { ruleConditionsSchema } from "./rule-conditions.js";

// ── Status ──────────────────────────────────────────────────────────────

export const campaignStatusSchema = z.enum([
  "draft",
  "scheduled",
  "running",
  "paused",
  "completed",
  "archived",
]);
export type CampaignStatus = z.infer<typeof campaignStatusSchema>;

/** Machine-readable slug — same shape as flag/experiment keys. */
const campaignKeyRegex = /^[a-z][a-z0-9_]{1,127}$/;

// ── Channels ────────────────────────────────────────────────────────────

export const channelKindSchema = z.enum([
  "email",
  "meta",
  "google",
  "tiktok",
  "linkedin",
  "webhook",
]);
export type ChannelKind = z.infer<typeof channelKindSchema>;

/**
 * Per-channel config. Each kind ships its own (currently permissive) shape
 * so MCP/JSON-Schema codegen can emit a clean `oneOf` discriminator — an
 * LLM picks `kind` first, the JSON Schema then constrains the rest of the
 * entry. Bounded keys + leaf values keep the payload size sane.
 */
const boundedConfigValue = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const boundedConfigRecord = z
  .record(z.string().min(1).max(64), boundedConfigValue)
  .refine((r) => Object.keys(r).length <= 32, {
    message: "channel.config is limited to 32 keys",
  });

const baseChannelFields = {
  config: boundedConfigRecord.default({}),
  destination_config_id: z.string().uuid().optional(),
  enabled: z.boolean().default(true),
} as const;

const emailChannelSchema = z.object({ kind: z.literal("email"), ...baseChannelFields });
const metaChannelSchema = z.object({ kind: z.literal("meta"), ...baseChannelFields });
const googleChannelSchema = z.object({ kind: z.literal("google"), ...baseChannelFields });
const tiktokChannelSchema = z.object({ kind: z.literal("tiktok"), ...baseChannelFields });
const linkedinChannelSchema = z.object({ kind: z.literal("linkedin"), ...baseChannelFields });
const webhookChannelSchema = z.object({ kind: z.literal("webhook"), ...baseChannelFields });

const channelEntrySchema = z.discriminatedUnion("kind", [
  emailChannelSchema,
  metaChannelSchema,
  googleChannelSchema,
  tiktokChannelSchema,
  linkedinChannelSchema,
  webhookChannelSchema,
]);

export const channelsSchema = z.array(channelEntrySchema).max(20);
export type Channel = z.infer<typeof channelEntrySchema>;

// ── Creative ────────────────────────────────────────────────────────────

/**
 * One creative variant. `payload` is per-channel-shaped (subject/body/
 * image_url/cta_text/cta_url/...) — kept loose since the same Campaign may
 * target multiple channels with different fields. `id` is optional on input
 * — when omitted, the API mints a UUID.
 */
const boundedPayloadValue = z.union([
  z.string().max(8000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const boundedPayloadRecord = z
  .record(z.string().min(1).max(64), boundedPayloadValue)
  .refine((r) => Object.keys(r).length <= 32, {
    message: "creative.payload is limited to 32 keys",
  });

const creativeEntrySchema = z.object({
  /** Stable id used for variant correlation. The server fills this when
   *  omitted (LLM-friendly default). */
  id: z.string().min(1).max(64).optional(),
  /** Optional kind hint — when set, downstream adapters can early-reject
   *  creatives that don't belong to a channel they support. */
  kind: channelKindSchema.optional(),
  name: z.string().min(1).max(200),
  payload: boundedPayloadRecord.default({}),
});

export const creativeSchema = z.array(creativeEntrySchema).max(20);
export type Creative = z.infer<typeof creativeEntrySchema>;

// ── Success metric ──────────────────────────────────────────────────────

/**
 * What we count. A single event_name with optional filter + conversion
 * window.
 */
export const successMetricSchema = z.object({
  event_name: z.string().min(1).max(200),
  filter: ruleConditionsSchema.optional(),
  /** Conversion window in seconds. Defaults to 7 days. */
  window_seconds: z
    .number()
    .int()
    .min(60)
    .max(60 * 60 * 24 * 90)
    .default(60 * 60 * 24 * 7),
});
export type SuccessMetric = z.infer<typeof successMetricSchema>;

// ── Budget ──────────────────────────────────────────────────────────────

/**
 * Spend cap. `spent_cents` is server-managed (write-protected on input) and
 * re-added on read; only the cap + currency are accepted on write.
 */
export const budgetSchema = z.object({
  cap_cents: z.number().int().min(0).max(1_000_000_00), // $1M ceiling
  currency: z
    .string()
    .length(3)
    .regex(/^[A-Z]{3}$/, "Currency must be ISO 4217 (e.g. USD)"),
});
export type Budget = z.infer<typeof budgetSchema>;

// ── Audience ────────────────────────────────────────────────────────────

/** Inline audience (RuleCondition[]). */
export const audienceSchema = ruleConditionsSchema;

// ── Create ──────────────────────────────────────────────────────────────

export const createCampaignSchema = z.object({
  key: z.string().regex(campaignKeyRegex, {
    message:
      "Key must start with a lowercase letter, be 2-128 chars, use only lowercase letters, numbers, underscores",
  }),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  goal: z.string().max(2000).optional(),

  environment_id: z.string().uuid().optional(),

  audience: audienceSchema.default([]),
  channels: channelsSchema.default([]),
  creative: creativeSchema.default([]),

  experiment_id: z.string().uuid().optional(),
  success_metric: successMetricSchema.optional(),
  budget: budgetSchema.optional(),

  scheduled_start: z.string().datetime().optional(),
  scheduled_end: z.string().datetime().optional(),
  timezone: z.string().min(1).max(64).default("UTC"),
});
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

// ── Update (draft|paused only) ──────────────────────────────────────────

/**
 * PATCH semantics for nullable-optional fields:
 *   - omit (undefined) → preserve current value
 *   - explicit null    → clear the field
 *   - non-null value   → set to value
 *
 * MCP tool descriptions MUST repeat this trinary so LLMs don't send `null`
 * when they mean "no change."
 */
export const updateCampaignSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  /** null = clear, omit = preserve. */
  description: z.string().max(2000).nullable().optional(),
  /** null = clear, omit = preserve. */
  goal: z.string().max(2000).nullable().optional(),

  audience: audienceSchema.optional(),
  channels: channelsSchema.optional(),
  creative: creativeSchema.optional(),

  /** null = unlink experiment, omit = preserve. The API verifies the
   *  experiment belongs to the same project before linking. */
  experiment_id: z.string().uuid().nullable().optional(),
  /** null = clear (campaign can't launch without one), omit = preserve. */
  success_metric: successMetricSchema.nullable().optional(),
  /** null = no spend cap, omit = preserve. */
  budget: budgetSchema.nullable().optional(),

  /** null = clear schedule (immediate-launch), omit = preserve. */
  scheduled_start: z.string().datetime().nullable().optional(),
  scheduled_end: z.string().datetime().nullable().optional(),
  timezone: z.string().min(1).max(64).optional(),
});
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>;

// ── List query ──────────────────────────────────────────────────────────

export const campaignListQuerySchema = z.object({
  status: campaignStatusSchema.optional(),
  search: z.string().max(200).optional(),
  include_archived: z.coerce.boolean().default(false),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type CampaignListQuery = z.infer<typeof campaignListQuerySchema>;

// ── Launch (preview/apply) ──────────────────────────────────────────────

/**
 * Launch is the only state-transition with user-visible side effects
 * (scheduled or running with budget burn). To prevent an LLM firing
 * launches without intent, the body MUST carry a `preview_token` returned
 * by a prior `POST /campaigns/:id/preview` call. The token is minted +
 * verified server-side and is single-use.
 */
export const launchCampaignSchema = z.object({
  /** Token minted by `POST /v1/campaigns/:id/preview`. */
  preview_token: z.string().min(43).max(64),
  /** Optional: skip the schedule and start running now even if
   *  scheduled_start is in the future. Off by default. */
  launch_now: z.boolean().default(false),
});
export type LaunchCampaignInput = z.infer<typeof launchCampaignSchema>;

// ── State-transition stubs ──────────────────────────────────────────────
//
// `.strict()` on every transition body — extra fields are an LLM "did you
// mean to set X?" smell, and silently dropping them masks intent. A loud
// 400 is better than quiet success-with-discarded-input.

export const pauseCampaignSchema = z.object({ reason: z.string().max(500).optional() }).strict();
export const resumeCampaignSchema = z.object({}).strict();
export const completeCampaignSchema = z.object({ reason: z.string().max(500).optional() }).strict();
export const archiveCampaignSchema = z.object({}).strict();
