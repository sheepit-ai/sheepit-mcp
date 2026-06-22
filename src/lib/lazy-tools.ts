/**
 * On-demand tool loading (Tool-Search pattern) for the MCP server.
 *
 * The server registers 40 tools; by default `tools/list` returns all 40 schemas,
 * which load into the customer's agent context every session — a permanent token
 * tax (see `Docs/Advisors/harness/tools-and-mcp.md`). When `SHEEPIT_MCP_LAZY_TOOLS`
 * is enabled, `tools/list` instead returns a small eager CORE set plus two
 * discovery tools (`search_tools` / `load_tool`); the remaining tools stay in the
 * server's `toolMap` and are still callable by name (the CallTool handler dispatches
 * any tool in the map), so the agent discovers + loads schemas on demand.
 *
 * MCP 1.0 has no `tools/list_changed` notification, so this server-side
 * eager-core + discovery-meta-tool pair is the pragmatic path on the current SDK.
 *
 * DEFAULT OFF. This ships the mechanism + the before/after measurement
 * (`$mcp_tools_listed.advertised_count` / `.schema_bytes` / `.lazy`); the default
 * is only flipped once telemetry shows lazy mode is at least as reliable.
 * See `Docs/Technical/HARNESS_PLAN.md` § B.
 */

/**
 * The eager core advertised in lazy mode — the tools a first session is most
 * likely to need before it knows what else exists: discovery/help, the event
 * catalog (needed to build any insight), the common campaign + insight reads,
 * a destination list, and feedback. Everything else is discoverable via
 * `search_tools` + `load_tool`. Picked by reasoning about first-session needs;
 * revisit with `$mcp_tool_invoked` usage data before flipping the default.
 */
export const CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "sheepit_help",
  "sheepit_quickstart",
  "event_catalog_canonical",
  "campaign_list",
  "campaign_create",
  "insights_query",
  "destination_list",
  "feedback_submit",
]);

/** Names of the discovery meta-tools, advertised only in lazy mode. */
export const DISCOVERY_TOOL_NAMES = ["search_tools", "load_tool"] as const;

/**
 * Whether on-demand tool loading is enabled. Read at call time (not module load)
 * so tests can mutate the env between cases. Honors `1` / `true` (case-insensitive).
 */
export function lazyToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.SHEEPIT_MCP_LAZY_TOOLS?.toLowerCase();
  return v === "1" || v === "true";
}

/**
 * Select which tools `tools/list` advertises.
 * - lazy OFF → all tools (current behavior, fully backward-compatible).
 * - lazy ON  → the CORE subset (in registry order) + the discovery tools.
 *
 * Pure + generic so it can be unit-tested and reused for the byte-measurement.
 */
export function selectAdvertisedTools<T extends { name: string }>(
  allTools: T[],
  discoveryTools: T[],
  lazy: boolean,
): T[] {
  if (!lazy) return allTools;
  const core = allTools.filter((t) => CORE_TOOL_NAMES.has(t.name));
  return [...core, ...discoveryTools];
}
