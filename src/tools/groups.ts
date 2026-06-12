/**
 * UserGroup tools for the MCP server.
 *
 * Groups are project-scoped collections of users referenced from flag
 * rule conditions / campaign audiences as
 * `{field: "user_group", op: "in", values: ["<key>"]}`.
 *
 * Surface (v1):
 *   - `group_list`             list groups in the current project
 *   - `group_create`           create a new group
 *   - `group_add_member`       add a user (by user_id OR email)
 *   - `group_remove_member`    remove a user from a group
 *
 * Deferred to a future iteration: group_archive / group_unarchive /
 * group_list_members (cursor pagination). Adding a single user to one
 * named group is the dominant first-dogfooder workflow — surface that
 * tightly first; the rest can come behind admin UI.
 */

import { z } from "zod";
import { createUserGroupSchema, userGroupListQuerySchema } from "../vendor/index.js";

// Re-declare locally because the shared `addUserGroupMemberSchema` is a
// ZodEffects (from `.refine()`), and ZodEffects can't be `.merge()`-ed
// onto another object. We need the same xor-of-fields invariant on the
// MCP input but with `id` added — rebuild the object + refine here.
const addMemberInputSchema = z
  .object({
    id: z.string().uuid().describe("Group UUID."),
    user_id: z.string().uuid().optional(),
    email: z.string().email().max(320).optional(),
  })
  .refine((v) => Boolean(v.user_id) !== Boolean(v.email), {
    message: "Provide exactly one of user_id or email.",
  });
import type { ApiClient } from "../lib/api-client.js";
import { wrapUntrusted, sanitizeUntrustedFields } from "../lib/untrust.js";
import { type Tool, defineTool } from "./define.js";

interface GroupsToolDeps {
  api: ApiClient;
}

interface GroupRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  archived_at: string | null;
  created_at: string;
  member_count?: number;
}

interface ListEnvelope {
  data: GroupRow[];
  pagination: { cursor: string | null; has_more: boolean };
}

interface SingleEnvelope {
  data: GroupRow;
}

interface MemberEnvelope {
  data: { id: string; user_id: string; added_at: string };
}

const idParam = z.object({ id: z.string().uuid().describe("Group UUID.") });

export function buildGroupTools({ api }: GroupsToolDeps): Tool[] {
  return [
    defineTool({
      name: "group_list",
      title: "List user groups",
      description: [
        "List user groups in the current project. Cursor-paginated, with",
        "optional free-text search across key and name. Use this BEFORE",
        "group_create to confirm the group doesn't already exist.",
      ].join(" "),
      inputSchema: userGroupListQuerySchema,
      async handler(input) {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (input.search) query.search = input.search;
        if (input.include_archived) query.include_archived = input.include_archived;
        if (input.cursor) query.cursor = input.cursor;
        if (input.limit) query.limit = input.limit;
        const res = await api.get<ListEnvelope>("/v1/groups", query);
        const summary =
          res.data.length === 0
            ? "No user groups in this project yet. Call `group_create` to start one."
            : `Found ${res.data.length} group(s):\n` +
              res.data
                .map(
                  (g) =>
                    `  - ${wrapUntrusted(g.key)} (${g.member_count ?? 0} member${g.member_count === 1 ? "" : "s"})${g.archived_at ? " [archived]" : ""}`,
                )
                .join("\n");
        // Hosts may surface structuredContent direct-to-model. Strip
        // dangerous code points from customer-controlled fields.
        sanitizeUntrustedFields(res.data, ["*.key", "*.name", "*.description"]);
        return {
          content: [{ type: "text", text: summary }],
          structuredContent: { groups: res.data, pagination: res.pagination },
        };
      },
    }),

    defineTool({
      name: "group_create",
      title: "Create a user group",
      description: [
        "Create a new user group in the current project. Group keys are",
        "snake_case slugs unique per project. After creating, add members",
        "with `group_add_member`, then reference the group from a flag",
        "rule via `{field: 'user_group', op: 'in', values: ['<key>']}`.",
        "",
        "Example use cases: 'dogfooders' (early testers see new dashboards),",
        "'beta_users' (cohort of opted-in feature testers), 'internal'",
        "(team members + advisors), 'banned' (denylist for kill-switches).",
      ].join(" "),
      inputSchema: createUserGroupSchema,
      async handler(input) {
        const res = await api.post<SingleEnvelope>("/v1/groups", input);
        // Strip dangerous code points from the structuredContent channel
        // (host may surface direct-to-model).
        sanitizeUntrustedFields(res.data, ["key", "name", "description"]);
        return {
          content: [
            {
              type: "text",
              text:
                `Created group ${wrapUntrusted(res.data.key)} (id=${res.data.id}). ` +
                `Reference it from flag rules as ` +
                `{field: 'user_group', op: 'in', values: ['<the group key shown above>']}. ` +
                `The wrapped value above carries delimiters that are NOT part of the key — ` +
                `read the key from structuredContent.group.key when constructing rules.`,
            },
          ],
          structuredContent: { group: res.data },
        };
      },
    }),

    defineTool({
      name: "group_add_member",
      title: "Add a user to a group",
      description: [
        "Add a user to a user group, by user UUID OR email. Provide",
        "exactly ONE of `user_id` / `email` — the server resolves email",
        "to user_id and 4xxs if no user has that email. Returns the",
        "membership row id.",
        "",
        "Idempotency: re-adding the same user returns 409 ALREADY_MEMBER.",
        "Adding to an archived group returns 409 GROUP_ARCHIVED.",
      ].join(" "),
      inputSchema: addMemberInputSchema,
      async handler(input) {
        const res = await api.post<MemberEnvelope>(`/v1/groups/${input.id}/members`, {
          user_id: input.user_id,
          email: input.email,
        });
        // Customer controls `input.email` (email of the user being
        // added). Wrap before echoing into LLM-readable text so an
        // attacker can't smuggle instructions via an email name. The
        // `input.id` + `res.data.id` are UUIDs (Zod-validated upstream)
        // and don't need wrapping.
        const ref = input.email !== undefined ? wrapUntrusted(input.email) : input.user_id;
        return {
          content: [
            {
              type: "text",
              text: `Added ${ref} to group ${input.id} as membership ${res.data.id}.`,
            },
          ],
          structuredContent: { membership: res.data },
        };
      },
    }),

    defineTool({
      name: "group_remove_member",
      title: "Remove a user from a group",
      description: [
        "Remove a user from a group by group id + user id. Returns 404",
        "if the user wasn't a member. Idempotent in spirit — caller can",
        "treat 404 here as 'already gone' rather than an error.",
      ].join(" "),
      inputSchema: idParam.extend({
        user_id: z.string().uuid().describe("UUID of the user to remove."),
      }),
      async handler(input) {
        await api.delete(`/v1/groups/${input.id}/members/${input.user_id}`);
        return {
          content: [
            {
              type: "text",
              text: `Removed user ${input.user_id} from group ${input.id}.`,
            },
          ],
          structuredContent: { group_id: input.id, user_id: input.user_id, removed: true },
        };
      },
    }),
  ];
}
