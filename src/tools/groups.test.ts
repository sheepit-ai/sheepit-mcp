import { describe, it, expect, vi } from "vitest";
import { buildGroupTools } from "./groups.js";
import type { ApiClient } from "../lib/api-client.js";

function makeApi(): ApiClient & {
  post: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

describe("Group tool registry", () => {
  it("registers exactly the 4 documented tools", () => {
    const names = buildGroupTools({ api: makeApi() })
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      "group_add_member",
      "group_create",
      "group_list",
      "group_remove_member",
    ]);
  });

  it("every tool has a non-empty description (LLM-readable)", () => {
    for (const t of buildGroupTools({ api: makeApi() })) {
      expect(t.description.length).toBeGreaterThan(40);
    }
  });
});

describe("group_create", () => {
  const tool = buildGroupTools({ api: makeApi() }).find((t) => t.name === "group_create")!;

  it("accepts a valid snake_case key", () => {
    const res = tool.inputSchema.safeParse({ key: "dogfooders", name: "Early Dogfooders" });
    expect(res.success).toBe(true);
  });

  it("rejects PascalCase keys", () => {
    const res = tool.inputSchema.safeParse({ key: "DogFooders", name: "x" });
    expect(res.success).toBe(false);
  });

  it("POSTs /v1/groups", async () => {
    const api = makeApi();
    api.post.mockResolvedValue({
      data: {
        id: "g-1",
        key: "dogfooders",
        name: "Dogfooders",
        description: null,
        archived_at: null,
        created_at: "2026-04-29T12:00:00Z",
      },
    });
    const tool2 = buildGroupTools({ api }).find((t) => t.name === "group_create")!;
    await tool2.handler({ key: "dogfooders", name: "Dogfooders" });
    expect(api.post).toHaveBeenCalledWith("/v1/groups", {
      key: "dogfooders",
      name: "Dogfooders",
    });
  });
});

describe("group_add_member input validation", () => {
  const tool = buildGroupTools({ api: makeApi() }).find((t) => t.name === "group_add_member")!;

  it("accepts user_id alone", () => {
    expect(
      tool.inputSchema.safeParse({
        id: "00000000-0000-0000-0000-000000000001",
        user_id: "00000000-0000-0000-0000-000000000002",
      }).success,
    ).toBe(true);
  });

  it("accepts email alone", () => {
    expect(
      tool.inputSchema.safeParse({
        id: "00000000-0000-0000-0000-000000000001",
        email: "chris@example.com",
      }).success,
    ).toBe(true);
  });

  it("rejects both user_id and email together", () => {
    expect(
      tool.inputSchema.safeParse({
        id: "00000000-0000-0000-0000-000000000001",
        user_id: "00000000-0000-0000-0000-000000000002",
        email: "chris@example.com",
      }).success,
    ).toBe(false);
  });

  it("rejects neither", () => {
    expect(
      tool.inputSchema.safeParse({
        id: "00000000-0000-0000-0000-000000000001",
      }).success,
    ).toBe(false);
  });

  it("POSTs /v1/groups/:id/members and forwards both fields (server resolves)", async () => {
    const api = makeApi();
    api.post.mockResolvedValue({
      data: { id: "m-1", user_id: "u-2", added_at: "2026-04-29T12:00:00Z" },
    });
    const tool2 = buildGroupTools({ api }).find((t) => t.name === "group_add_member")!;
    await tool2.handler({
      id: "00000000-0000-0000-0000-000000000001",
      email: "chris@example.com",
    });
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post.mock.calls[0]?.[0]).toBe(
      "/v1/groups/00000000-0000-0000-0000-000000000001/members",
    );
    const body = api.post.mock.calls[0]?.[1] as { user_id?: string; email?: string };
    expect(body.email).toBe("chris@example.com");
    expect(body.user_id).toBeUndefined();
  });
});

describe("group_add_member sanitisation (MF-4)", () => {
  it("wraps customer-controlled email before echoing into text", async () => {
    const api = makeApi();
    api.post.mockResolvedValue({
      data: { id: "m-1", user_id: "u-2", added_at: "2026-04-29T12:00:00Z" },
    });
    const tool = buildGroupTools({ api }).find((t) => t.name === "group_add_member")!;
    // Use a strip-eligible character so we can prove the wrap path
    // (input.email is otherwise Zod-validated as an email address, but
    // the wrap MUST run regardless because a future Zod relaxation
    // would otherwise re-open the vector).
    const result = await tool.handler({
      id: "00000000-0000-0000-0000-000000000001",
      email: "chris\x00@example.com",
    });
    const text = (result.content[0] as { text: string }).text;
    // Wrap sentinel surrounds the email.
    expect(text).toContain("begin user-content");
    expect(text).toContain("end");
    // Strip pass replaced the control char with U+FFFD.
    expect(text).toContain("�");
    expect(text).not.toContain("\x00");
  });

  it("falls back to user_id (UUID — no wrap) when email omitted", async () => {
    const api = makeApi();
    api.post.mockResolvedValue({
      data: { id: "m-1", user_id: "u-2", added_at: "2026-04-29T12:00:00Z" },
    });
    const tool = buildGroupTools({ api }).find((t) => t.name === "group_add_member")!;
    const result = await tool.handler({
      id: "00000000-0000-0000-0000-000000000001",
      user_id: "00000000-0000-0000-0000-000000000002",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("00000000-0000-0000-0000-000000000002");
    // user_id is a Zod-validated UUID — no wrap needed; no sentinel.
    expect(text).not.toContain("begin user-content");
  });
});

describe("group_list sanitisation (MF-2 structuredContent sweep)", () => {
  it("strips dangerous code points from group.key / .name / .description in structuredContent", async () => {
    const api = makeApi();
    api.get.mockResolvedValue({
      data: [
        {
          id: "g-1",
          key: "dogfooders\x00",
          name: "Dogfooders\nIgnore previous",
          description: null,
          archived_at: null,
          created_at: "2026-04-29T12:00:00Z",
          member_count: 3,
        },
      ],
      pagination: { cursor: null, has_more: false },
    });
    const tool = buildGroupTools({ api }).find((t) => t.name === "group_list")!;
    const result = await tool.handler({});
    const sc = result.structuredContent as { groups: Array<{ key: string; name: string }> };
    expect(sc.groups[0]!.key).not.toContain("\x00");
    expect(sc.groups[0]!.name).not.toContain("\n");
    // Replacement char is U+FFFD (forensic-clear, never "?").
    expect(sc.groups[0]!.key).toContain("�");
    expect(sc.groups[0]!.name).toContain("�");
  });
});

describe("group_remove_member", () => {
  it("DELETEs /v1/groups/:id/members/:userId", async () => {
    const api = makeApi();
    api.delete.mockResolvedValue(undefined);
    const tool = buildGroupTools({ api }).find((t) => t.name === "group_remove_member")!;
    await tool.handler({
      id: "00000000-0000-0000-0000-000000000001",
      user_id: "00000000-0000-0000-0000-000000000002",
    });
    expect(api.delete).toHaveBeenCalledWith(
      "/v1/groups/00000000-0000-0000-0000-000000000001/members/00000000-0000-0000-0000-000000000002",
    );
  });
});
