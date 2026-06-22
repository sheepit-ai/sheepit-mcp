import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTool, type Tool } from "./define.js";
import { buildDiscoveryTools, scoreTool, searchRegistry } from "./discovery.js";

/** A small synthetic registry standing in for the 40 real tools. */
const registry: Tool[] = [
  defineTool({
    name: "dashboard_create",
    title: "Create dashboard",
    description: "Create a new analytics dashboard.",
    inputSchema: z.object({ name: z.string(), description: z.string().optional() }),
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  }),
  defineTool({
    name: "release_health",
    title: "Release health",
    description: "Get the health verdict for a release.",
    inputSchema: z.object({ release_id: z.string() }),
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  }),
  defineTool({
    name: "campaign_list",
    title: "List campaigns",
    description: "List email campaigns.",
    inputSchema: z.object({}),
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  }),
];

const discovery = buildDiscoveryTools({ registry });
const search = discovery.find((t) => t.name === "search_tools")!;
const load = discovery.find((t) => t.name === "load_tool")!;

describe("buildDiscoveryTools", () => {
  it("registers exactly search_tools and load_tool", () => {
    expect(discovery.map((t) => t.name).sort()).toEqual(["load_tool", "search_tools"]);
  });
});

describe("scoreTool / searchRegistry", () => {
  it("scores keyword hits, weighting the name field", () => {
    const dash = registry[0];
    expect(scoreTool(dash, "dashboard")).toBeGreaterThan(0);
    expect(scoreTool(dash, "release")).toBe(0);
  });

  it("ranks the best match first and excludes non-matches", () => {
    const results = searchRegistry(registry, "release health", 10);
    expect(results[0].name).toBe("release_health");
    expect(results.map((r) => r.name)).not.toContain("campaign_list");
  });

  it("never returns the discovery tools themselves", () => {
    const withDiscovery = [...registry, ...discovery];
    const results = searchRegistry(withDiscovery, "tool search load", 25);
    expect(results.map((r) => r.name)).not.toContain("search_tools");
    expect(results.map((r) => r.name)).not.toContain("load_tool");
  });
});

describe("search_tools handler", () => {
  it("returns matching tools as structured content", async () => {
    const res = await search.handler({ query: "dashboard" });
    expect(res.isError).toBeFalsy();
    const matches = (res.structuredContent as { matches: { name: string }[] }).matches;
    expect(matches.map((m) => m.name)).toContain("dashboard_create");
  });

  it("returns an empty match set (not an error) for no hits", async () => {
    const res = await search.handler({ query: "zzzznotanything" });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { matches: unknown[] }).matches).toHaveLength(0);
  });
});

describe("load_tool handler", () => {
  it("returns the input schema for a known tool", async () => {
    const res = await load.handler({ name: "dashboard_create" });
    expect(res.isError).toBeFalsy();
    const sc = res.structuredContent as { name: string; inputSchema: Record<string, unknown> };
    expect(sc.name).toBe("dashboard_create");
    expect(sc.inputSchema).toBeTruthy();
    expect(JSON.stringify(sc.inputSchema)).toContain("name");
  });

  it("errors on an unknown tool name", async () => {
    const res = await load.handler({ name: "no_such_tool" });
    expect(res.isError).toBe(true);
  });

  it("refuses to load a discovery tool by name", async () => {
    const res = await load.handler({ name: "search_tools" });
    expect(res.isError).toBe(true);
  });
});
