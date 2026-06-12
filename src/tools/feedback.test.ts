import { describe, it, expect, vi } from "vitest";
import { buildFeedbackTools } from "./feedback.js";
import type { ApiClient } from "../lib/api-client.js";

/**
 * feedback_submit must:
 *   - validate the type enum + message length at the schema layer
 *   - POST exactly /feedback (root-level, NOT /v1/feedback) — server
 *     route is mounted at root
 *   - auto-stamp metadata.source = "mcp" + version info so the admin
 *     queue can distinguish MCP-origin reports from web/iOS/email
 */

function makeApi(): ApiClient & { post: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

const okResponse = {
  data: { id: "fb-123", createdAt: "2026-04-29T17:00:00.000Z" },
};

describe("feedback_submit input validation", () => {
  const tools = buildFeedbackTools({ api: makeApi(), mcpVersion: "0.2.0" });
  const tool = tools.find((t) => t.name === "feedback_submit")!;

  it("accepts a valid bug report", () => {
    const res = tool.inputSchema.safeParse({
      type: "bug",
      message: "campaign_launch returned an opaque error",
    });
    expect(res.success).toBe(true);
  });

  it("rejects messages shorter than 5 chars", () => {
    const res = tool.inputSchema.safeParse({ type: "bug", message: "hi" });
    expect(res.success).toBe(false);
  });

  it("rejects messages over 5000 chars", () => {
    const res = tool.inputSchema.safeParse({ type: "bug", message: "x".repeat(5001) });
    expect(res.success).toBe(false);
  });

  it("rejects unknown feedback types — anti-hallucination", () => {
    const res = tool.inputSchema.safeParse({ type: "support_ticket", message: "broken thing" });
    expect(res.success).toBe(false);
  });
});

describe("feedback_submit handler", () => {
  it("POSTs /feedback (root-level) with auto-stamped metadata", async () => {
    const api = makeApi();
    api.post.mockResolvedValue(okResponse);
    const tool = buildFeedbackTools({ api, mcpVersion: "0.2.0" }).find(
      (t) => t.name === "feedback_submit",
    )!;

    const res = await tool.handler({
      type: "bug",
      message: "destination_test silently returns ok even when the from address is wrong",
    });

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post.mock.calls[0]?.[0]).toBe("/feedback");
    const body = api.post.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.feedbackType).toBe("bug");
    expect(typeof body.message).toBe("string");
    const meta = body.metadata as Record<string, unknown>;
    expect(meta.source).toBe("mcp");
    expect(meta.mcp_version).toBe("0.2.0");
    expect(typeof meta.node_version).toBe("string");
    expect(typeof meta.platform).toBe("string");

    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("fb-123");
    const sc = res.structuredContent as { feedback_id: string; type: string };
    expect(sc.feedback_id).toBe("fb-123");
    expect(sc.type).toBe("bug");
  });

  it("propagates the version stamp the server was constructed with", async () => {
    const api = makeApi();
    api.post.mockResolvedValue(okResponse);
    const tool = buildFeedbackTools({ api, mcpVersion: "9.9.9-test" }).find(
      (t) => t.name === "feedback_submit",
    )!;

    await tool.handler({ type: "general", message: "version stamping check" });
    const body = api.post.mock.calls[0]?.[1] as { metadata: Record<string, unknown> };
    expect(body.metadata.mcp_version).toBe("9.9.9-test");
  });
});
