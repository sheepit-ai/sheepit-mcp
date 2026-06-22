import { describe, it, expect } from "vitest";
import {
  lazyToolsEnabled,
  selectAdvertisedTools,
  CORE_TOOL_NAMES,
  DISCOVERY_TOOL_NAMES,
} from "./lazy-tools.js";

const tool = (name: string) => ({ name });

// A stand-in registry: a couple of core tools + several non-core.
const ALL = [
  tool("sheepit_help"),
  tool("campaign_list"),
  tool("campaign_create"),
  tool("insights_query"),
  tool("dashboard_create"), // non-core
  tool("widget_delete"), // non-core
  tool("release_health"), // non-core
  tool("group_add_member"), // non-core
];
const DISCOVERY = DISCOVERY_TOOL_NAMES.map(tool);

describe("lazyToolsEnabled", () => {
  it("is off by default and for unset/other values", () => {
    expect(lazyToolsEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(lazyToolsEnabled({ SHEEPIT_MCP_LAZY_TOOLS: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(lazyToolsEnabled({ SHEEPIT_MCP_LAZY_TOOLS: "no" } as NodeJS.ProcessEnv)).toBe(false);
  });
  it("is on for 1 / true (case-insensitive)", () => {
    expect(lazyToolsEnabled({ SHEEPIT_MCP_LAZY_TOOLS: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(lazyToolsEnabled({ SHEEPIT_MCP_LAZY_TOOLS: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(lazyToolsEnabled({ SHEEPIT_MCP_LAZY_TOOLS: "TRUE" } as NodeJS.ProcessEnv)).toBe(true);
  });
});

describe("selectAdvertisedTools", () => {
  it("returns ALL tools unchanged when lazy is off (backward compatible)", () => {
    expect(selectAdvertisedTools(ALL, DISCOVERY, false)).toBe(ALL);
  });

  it("returns only core + discovery tools when lazy is on", () => {
    const advertised = selectAdvertisedTools(ALL, DISCOVERY, true);
    const names = advertised.map((t) => t.name);
    // every advertised non-discovery tool is in the core set
    for (const n of names) {
      if (!DISCOVERY_TOOL_NAMES.includes(n as (typeof DISCOVERY_TOOL_NAMES)[number])) {
        expect(CORE_TOOL_NAMES.has(n)).toBe(true);
      }
    }
    expect(names).toContain("search_tools");
    expect(names).toContain("load_tool");
    expect(names).not.toContain("dashboard_create");
    expect(names).not.toContain("widget_delete");
  });

  it("advertises strictly fewer tools in lazy mode than the full set", () => {
    expect(selectAdvertisedTools(ALL, DISCOVERY, true).length).toBeLessThan(ALL.length);
  });
});
