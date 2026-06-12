/**
 * `RuleCondition[]` — the predicate shape used by campaign audiences and
 * destination filters.
 *
 * Vendored from the Sheepit API contract. A condition is
 * `{ field, op, values }`; an audience / filter is an array of them
 * (max 20, AND-combined server-side).
 */

import { z } from "zod";

const conditionValueSchema = z.union([z.string().max(1024), z.number(), z.boolean()]);

const conditionSchema = z.object({
  field: z.string().min(1).max(128),
  op: z.enum(["eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "contains", "regex"]),
  values: z.array(conditionValueSchema).min(1).max(100),
});

/** Zod-parseable rule-conditions schema. Used everywhere an audience or a
 *  destination filter is accepted so a malformed value fails closed at the
 *  boundary instead of exploding downstream. */
export const ruleConditionsSchema = z.array(conditionSchema).max(20);
export type RuleConditions = z.infer<typeof ruleConditionsSchema>;
