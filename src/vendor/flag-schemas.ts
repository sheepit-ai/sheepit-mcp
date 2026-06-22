/**
 * Zod schemas for the Flag primitive — vendored from the Sheepit API
 * contract (`packages/shared/src/schemas/platform.ts`).
 *
 * Flags are project-scoped, typed configuration values an SDK reads at
 * runtime. The MCP `flag_*` tools wrap the existing `/v1/flags` routes:
 *   POST  /v1/flags      → flag_create   (requires a secret key + editor role)
 *   PATCH /v1/flags/:id  → flag_update   (secret key + editor)
 *   GET   /v1/flags      → flag_list     (management key + viewer)
 *   GET   /v1/flags/:id  → flag_get      (management key + viewer)
 *
 * The server is always the source of truth — if the API tightens these
 * schemas, mirror the change here. A drift surfaces as a 400
 * VALIDATION_ERROR from the API (the safe failure mode).
 */

import { z } from "zod";

const PLATFORM_VALUES = ["web", "ios", "ipados", "macos", "android", "server"] as const;

/** snake_case, 2-128 chars, no leading number — same as flag keys server-side. */
const flagKeyRegex = /^[a-z][a-z0-9_]{1,127}$/;

export const createFlagSchema = z.object({
  key: z.string().regex(flagKeyRegex, {
    message:
      "Key must start with a lowercase letter, be 2–128 chars, use only lowercase letters, numbers, underscores",
  }),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  value_type: z.enum(["boolean", "string", "number", "json"]).default("boolean"),
  default_value: z.unknown(),
  platforms: z.array(z.enum(PLATFORM_VALUES)).min(1).max(10),
  tags: z.array(z.string().max(64)).max(20).default([]),
});

export const updateFlagSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  platforms: z.array(z.enum(PLATFORM_VALUES)).min(1).max(10).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  status: z.enum(["active", "archived", "deprecated"]).optional(),
});

export const flagListQuerySchema = z.object({
  status: z.enum(["active", "archived", "deprecated"]).optional(),
  platform: z.enum(PLATFORM_VALUES).optional(),
  tag: z.string().max(64).optional(),
  search: z.string().max(200).optional(),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateFlagInput = z.infer<typeof createFlagSchema>;
export type UpdateFlagInput = z.infer<typeof updateFlagSchema>;
