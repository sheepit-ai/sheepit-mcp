import { describe, it, expect, vi } from "vitest";
import { buildEventCatalogTools } from "./event-catalog.js";
import type { ApiClient } from "../lib/api-client.js";

function makeApi(getImpl?: (path: string) => Promise<unknown>): ApiClient {
  return {
    get: vi.fn(getImpl ?? (async () => ({ data: [] }))),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

describe("event_catalog_canonical", () => {
  const tool = buildEventCatalogTools({ api: makeApi() }).find(
    (t) => t.name === "event_catalog_canonical",
  )!;

  it("registers a single tool with a useful description", () => {
    expect(tool.title).toContain("canonical event catalog");
    expect(tool.description.length).toBeGreaterThan(80);
  });

  it("returns the full canonical list when no category filter is set", async () => {
    const res = await tool.handler({ include_customer_events: false });
    const sc = res.structuredContent as {
      canonical_events: Array<{ name: string; category: string }>;
    };
    // We ship at least one event per category — useful canary against accidental drift.
    const cats = new Set(sc.canonical_events.map((e) => e.category));
    expect(cats.has("system")).toBe(true);
    expect(cats.has("auth")).toBe(true);
    expect(cats.has("funnel")).toBe(true);
    expect(cats.has("commerce")).toBe(true);
    expect(cats.has("engagement")).toBe(true);
  });

  it("filters by category", async () => {
    const res = await tool.handler({ category: "system", include_customer_events: false });
    const sc = res.structuredContent as {
      canonical_events: Array<{ category: string; emitted_by_sdk?: boolean }>;
    };
    for (const e of sc.canonical_events) {
      expect(e.category).toBe("system");
    }
    // Every system event is SDK-emitted — defends against a future
    // category mistake where we add a customer-emit event under "system".
    for (const e of sc.canonical_events) {
      expect(e.emitted_by_sdk).toBe(true);
    }
  });

  it("system events are $-prefixed; non-system events are not", async () => {
    const res = await tool.handler({ include_customer_events: false });
    const sc = res.structuredContent as {
      canonical_events: Array<{ name: string; category: string }>;
    };
    for (const e of sc.canonical_events) {
      const isSystem = e.category === "system";
      expect(e.name.startsWith("$")).toBe(isSystem);
    }
  });

  it("merges customer EventSchema rows when include_customer_events=true", async () => {
    const customer = [
      {
        event_name: "checkout_abandoned",
        description: "User left the checkout flow.",
        category: "funnel",
        status: "active",
        properties: { step: { type: "string" } },
      },
    ];
    const api = makeApi(async (path) => {
      expect(path).toBe("/v1/events/schemas");
      return { data: customer };
    });
    const tool2 = buildEventCatalogTools({ api }).find(
      (t) => t.name === "event_catalog_canonical",
    )!;

    const res = await tool2.handler({ include_customer_events: true });
    const sc = res.structuredContent as {
      customer_events: Array<{ event_name: string }>;
    };
    expect(sc.customer_events).toHaveLength(1);
    expect(sc.customer_events[0]!.event_name).toBe("checkout_abandoned");
  });

  it("never throws when the schemas endpoint fails", async () => {
    const api = makeApi(async () => {
      throw new Error("network down");
    });
    const tool2 = buildEventCatalogTools({ api }).find(
      (t) => t.name === "event_catalog_canonical",
    )!;
    const res = await tool2.handler({ include_customer_events: true });
    const sc = res.structuredContent as { customer_events: unknown[] };
    expect(sc.customer_events).toEqual([]);
    // Canonical list is still surfaced — partial info beats nothing.
    expect((sc as Record<string, unknown>).canonical_events).toBeDefined();
  });

  it("MF-2A v2: strips dangerous code points from customer event_name / description / category", async () => {
    const customer = [
      {
        event_name: "checkout\x00abandoned",
        description: "User left＜system＞",
        category: "funnel\nIGNORE",
        status: "active",
        properties: {},
      },
    ];
    const api = makeApi(async () => ({ data: customer }));
    const tool2 = buildEventCatalogTools({ api }).find(
      (t) => t.name === "event_catalog_canonical",
    )!;
    const res = await tool2.handler({ include_customer_events: true });
    const sc = res.structuredContent as {
      customer_events: Array<{ event_name: string; description: string; category: string }>;
    };
    expect(sc.customer_events[0]!.event_name).not.toContain("\x00");
    expect(sc.customer_events[0]!.description).not.toContain("＜");
    expect(sc.customer_events[0]!.description).not.toContain("＞");
    expect(sc.customer_events[0]!.category).not.toContain("\n");
  });

  it("publishes the naming rules so the LLM has the regex authoritatively", async () => {
    const res = await tool.handler({ include_customer_events: false });
    const sc = res.structuredContent as {
      naming_rules: { regex: string; tense: string; case: string };
    };
    expect(sc.naming_rules.regex).toMatch(/\^/);
    expect(sc.naming_rules.tense).toBe("past");
    expect(sc.naming_rules.case).toBe("snake_case");
  });
});
