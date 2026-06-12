/**
 * Feedback capture tool. Lets a dogfooder (or the LLM on their behalf)
 * file a bug / feature / general note WITHOUT leaving the chat.
 *
 * Posts to the public `POST /feedback` endpoint (root-level, optional
 * auth, IP-rate-limited 10/h server-side). The MCP API client already
 * sends the user's `Authorization: Bearer` header, so the server attaches
 * `userId` automatically when the credential is JWT/sec-keyed.
 *
 * The tool auto-stamps `metadata.source = "mcp"` plus client version +
 * Node + platform so the admin Feedback queue can filter MCP-origin
 * reports out of the larger stream.
 */

import { z } from "zod";
import type { ApiClient } from "../lib/api-client.js";
import { type Tool, defineTool } from "./define.js";

interface FeedbackToolDeps {
  api: ApiClient;
  /** MCP package version, stamped into metadata so we can correlate
   *  reports to client builds (older clients may have different bugs). */
  mcpVersion: string;
}

interface FeedbackResponse {
  data: { id: string; createdAt: string };
}

export function buildFeedbackTools(deps: FeedbackToolDeps): Tool[] {
  return [
    defineTool({
      name: "feedback_submit",
      title: "Submit feedback to the Sheepit team",
      description: [
        "File a bug report, feature request, or general note for the Sheepit",
        "team. The friction barrier between 'this is annoying' and 'report",
        "filed' is one tool call — use it.",
        "",
        "Call this proactively when the user expresses frustration ('this is",
        "confusing', 'I wish I could…', 'it should…'), when a tool returns a",
        "confusing error, or when you hit an obvious gap (a missing connector,",
        "a missing widget type, an unclear field name). Always confirm with",
        "the user before calling — quote their words back so the message is",
        "their voice, not yours.",
        "",
        "Returns the feedback id and createdAt timestamp. The MCP auto-stamps",
        "source/version metadata; you only supply type + message.",
      ].join(" "),
      inputSchema: z.object({
        type: z
          .enum(["bug", "feature", "general"])
          .describe(
            "bug = something is broken; feature = an obvious missing capability; general = UX rough edges, doc gaps, slow tools, confusing names.",
          ),
        message: z
          .string()
          .min(5)
          .max(5000)
          .describe(
            "The narrative. Quote the user's own words when possible — the team reads these to understand the user's mental model, not just the symptom.",
          ),
      }),
      async handler(input) {
        const body = {
          feedbackType: input.type,
          message: input.message,
          metadata: {
            source: "mcp",
            mcp_version: deps.mcpVersion,
            node_version: process.version,
            platform: process.platform,
          },
        };
        const res = await deps.api.post<FeedbackResponse>("/feedback", body);
        const summary = `Feedback filed (${input.type}): id=${res.data.id} at ${res.data.createdAt}. The team will see it in the admin Feedback queue.`;
        return {
          content: [{ type: "text", text: summary }],
          structuredContent: {
            feedback_id: res.data.id,
            created_at: res.data.createdAt,
            type: input.type,
          },
        };
      },
    }),
  ];
}
