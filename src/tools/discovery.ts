/**
 * Discovery meta-tools for on-demand tool loading (Tool-Search pattern).
 *
 * Advertised only when `SHEEPIT_MCP_LAZY_TOOLS` is enabled (see
 * `../lib/lazy-tools.ts`). They let an agent find + load the schemas of the
 * tools NOT in the eager core, instead of paying for all 40 schemas upfront:
 *   - `search_tools(query)` → matching tools as {name, title, description}.
 *   - `load_tool(name)`     → the full input schema for one tool, so the agent
 *                             can then call it by name (the CallTool handler
 *                             dispatches any tool in the registry, listed or not).
 *
 * The registry passed in is the full tool list; the discovery tools introspect
 * it but never include themselves in results.
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { defineTool, type Tool } from "./define.js";
import { DISCOVERY_TOOL_NAMES } from "../lib/lazy-tools.js";

const DISCOVERY_NAMES: ReadonlySet<string> = new Set(DISCOVERY_TOOL_NAMES);

/** Lowercase haystack for a tool: name + title + description. */
function haystack(t: Tool): string {
  return `${t.name} ${t.title} ${t.description}`.toLowerCase();
}

/**
 * Score a tool against a query. Token-overlap: each query token that appears in
 * the tool's name/title/description scores 1, with a small bonus for a hit in
 * the name (the highest-signal field). Zero score = not a match. Deterministic,
 * no embeddings — exact-term recall is what an agent needs here.
 */
export function scoreTool(t: Tool, query: string): number {
  const hay = haystack(t);
  const name = t.name.toLowerCase();
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.length === 0) return 0;
  let score = 0;
  for (const tok of tokens) {
    if (hay.includes(tok)) score += 1;
    if (name.includes(tok)) score += 1;
  }
  return score;
}

export interface ToolSummary {
  name: string;
  title: string;
  description: string;
}

/** Rank the registry against a query, excluding the discovery tools themselves. */
export function searchRegistry(registry: Tool[], query: string, limit: number): ToolSummary[] {
  return registry
    .filter((t) => !DISCOVERY_NAMES.has(t.name))
    .map((t) => ({ tool: t, score: scoreTool(t, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ tool }) => ({ name: tool.name, title: tool.title, description: tool.description }));
}

export function buildDiscoveryTools({ registry }: { registry: Tool[] }): Tool[] {
  const searchTools = defineTool({
    name: "search_tools",
    title: "Search tools",
    description:
      "Find Sheepit tools by keyword when the tool you need isn't in the initial list. " +
      "Returns matching tools as {name, title, description}. Then call load_tool(name) to get " +
      "the tool's input schema, then call the tool directly by name.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          "Keywords describing what you want to do, e.g. 'dashboard widget' or 'release health'.",
        ),
      limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)."),
    }),
    handler: async (input) => {
      const { query, limit } = input as { query: string; limit?: number };
      const matches = searchRegistry(registry, query, limit ?? 10);
      if (matches.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No tools matched "${query}". Try broader keywords (e.g. campaign, dashboard, release, destination, group).`,
            },
          ],
          structuredContent: { matches: [] },
        };
      }
      const lines = matches.map((m) => `- ${m.name} — ${m.title}: ${m.description}`).join("\n");
      return {
        content: [
          {
            type: "text",
            text: `${matches.length} tool(s) matched "${query}":\n${lines}\n\nCall load_tool(name) to get a tool's input schema, then call it by name.`,
          },
        ],
        structuredContent: { matches },
      };
    },
  });

  const loadTool = defineTool({
    name: "load_tool",
    title: "Load tool schema",
    description:
      "Get the full input schema for a Sheepit tool by name (use after search_tools). " +
      "Once you have the schema you can call the tool directly by its name.",
    inputSchema: z.object({
      name: z.string().min(1).describe("Exact tool name, e.g. 'dashboard_create'."),
    }),
    handler: async (input) => {
      const { name } = input as { name: string };
      const tool = registry.find((t) => t.name === name && !DISCOVERY_NAMES.has(t.name));
      if (!tool) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}. Use search_tools to find available tools.`,
            },
          ],
          isError: true,
        };
      }
      const schema = zodToJsonSchema(tool.inputSchema, { target: "openApi3" });
      return {
        content: [
          {
            type: "text",
            text: `${tool.name} — ${tool.title}\n${tool.description}\n\nInput schema:\n${JSON.stringify(schema, null, 2)}\n\nYou can now call ${tool.name} directly with arguments matching this schema.`,
          },
        ],
        structuredContent: {
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: schema,
        },
      };
    },
  });

  return [searchTools, loadTool];
}
