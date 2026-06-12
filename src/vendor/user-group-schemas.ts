/**
 * Zod schemas for the UserGroup primitive — vendored from the Sheepit API
 * contract.
 *
 * UserGroups are project-scoped, named collections of users referenced from
 * flag rules / campaign audiences / cohort matchers via the
 * `{field: "user_group", op: "in", values: ["<key>"]}` condition shape.
 */

import { z } from "zod";

/** Same regex as flag keys: snake_case, 2-128 chars, no leading number. */
const groupKeyRegex = /^[a-z][a-z0-9_]{1,127}$/;

export const userGroupKeySchema = z.string().regex(groupKeyRegex, {
  message:
    "Group key must start with a lowercase letter, be 2–128 chars, use only lowercase letters, numbers, underscores.",
});

export const createUserGroupSchema = z.object({
  key: userGroupKeySchema,
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
});

export const updateUserGroupSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  /** Pass `true` to archive (soft-delete), `false` to restore. */
  archived: z.boolean().optional(),
});

export const userGroupListQuerySchema = z.object({
  search: z.string().max(200).optional(),
  /** Default false — list excludes archived groups. */
  include_archived: z.coerce.boolean().optional().default(false),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const addUserGroupMemberSchema = z
  .object({
    user_id: z.string().uuid().optional(),
    /** Convenience: lookup by email. Server resolves to user_id and 4xxs if
     *  the email matches no user in the project's reach. */
    email: z.string().email().max(320).optional(),
  })
  .refine((v) => Boolean(v.user_id) !== Boolean(v.email), {
    message: "Provide exactly one of user_id or email.",
  });

export const userGroupMemberListQuerySchema = z.object({
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type CreateUserGroupInput = z.infer<typeof createUserGroupSchema>;
export type UpdateUserGroupInput = z.infer<typeof updateUserGroupSchema>;
export type AddUserGroupMemberInput = z.infer<typeof addUserGroupMemberSchema>;

/**
 * Reserved condition field name. When a Rule / Rollout / Campaign audience
 * condition has this field, the evaluator dispatches to group-membership
 * matching instead of profile-attribute matching. Operators supported:
 * `in` / `not_in` / `eq` / `neq`.
 */
export const USER_GROUP_CONDITION_FIELD = "user_group" as const;

/** Operators meaningful for user_group conditions. */
export const USER_GROUP_CONDITION_OPS = ["in", "not_in", "eq", "neq"] as const;
