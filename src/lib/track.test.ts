import { describe, it, expect, vi, afterEach } from "vitest";
import { classifyError, trackTelemetry, telemetryDisabled } from "./track.js";
import type { ApiClient } from "./api-client.js";

function makeApi(post: (path: string, body: unknown) => Promise<unknown>): ApiClient {
  return {
    get: vi.fn(),
    post: vi.fn(post),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

describe("classifyError", () => {
  it("returns 'unknown' for null / undefined", () => {
    expect(classifyError(null)).toBe("unknown");
    expect(classifyError(undefined)).toBe("unknown");
  });

  it("prefers code over status over name", () => {
    expect(classifyError({ code: "RATE_LIMITED", status: 429, name: "ApiError" })).toBe(
      "RATE_LIMITED",
    );
    expect(classifyError({ status: 429, name: "ApiError" })).toBe("http_429");
    expect(classifyError({ name: "AbortError" })).toBe("AbortError");
  });

  it("falls back to internal_error for unknown shapes", () => {
    expect(classifyError("some string")).toBe("internal_error");
    expect(classifyError(42)).toBe("internal_error");
    expect(classifyError({})).toBe("internal_error");
  });
});

describe("trackTelemetry", () => {
  it("POSTs /v1/ingest with the right batch shape + context", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const api = makeApi(async (path, body) => {
      calls.push({ path, body });
      return undefined;
    });

    await trackTelemetry(api, {
      event: "$mcp_tool_invoked",
      properties: { tool_name: "campaign_list", success: true, duration_ms: 42 },
      namespace: "mcp",
      version: "0.2.0",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/v1/ingest");
    const body = calls[0]!.body as {
      batch: Array<{ type: string; event: string; properties: Record<string, unknown> }>;
      context: { app: { namespace: string; version: string } };
      sent_at: string;
    };
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0]!.type).toBe("track");
    expect(body.batch[0]!.event).toBe("$mcp_tool_invoked");
    expect(body.batch[0]!.properties).toMatchObject({
      tool_name: "campaign_list",
      success: true,
      duration_ms: 42,
    });
    expect(body.context.app.namespace).toBe("mcp");
    expect(body.context.app.version).toBe("0.2.0");
    expect(typeof body.sent_at).toBe("string");
  });

  it("never throws — network failures are swallowed", async () => {
    const api = makeApi(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      trackTelemetry(api, {
        event: "$mcp_tool_invoked",
        properties: {},
        namespace: "mcp",
        version: "0.2.0",
      }),
    ).resolves.toBeUndefined();
  });

  it("never throws — 4xx + 5xx failures are swallowed", async () => {
    const api = makeApi(async () => {
      const err = new Error("Quota exceeded") as Error & { status: number; code: string };
      err.status = 429;
      err.code = "USAGE_LIMIT_EXCEEDED";
      throw err;
    });
    await expect(
      trackTelemetry(api, {
        event: "$mcp_tool_invoked",
        properties: {},
        namespace: "mcp",
        version: "0.2.0",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("telemetry opt-out", () => {
  afterEach(() => {
    delete process.env.DO_NOT_TRACK;
    delete process.env.SHEEPIT_TELEMETRY;
  });

  describe("telemetryDisabled", () => {
    it("is false by default (no env set)", () => {
      expect(telemetryDisabled({})).toBe(false);
    });

    it("honors DO_NOT_TRACK=1", () => {
      expect(telemetryDisabled({ DO_NOT_TRACK: "1" })).toBe(true);
    });

    it("does NOT trip on DO_NOT_TRACK=0", () => {
      expect(telemetryDisabled({ DO_NOT_TRACK: "0" })).toBe(false);
    });

    it("honors SHEEPIT_TELEMETRY=0 and =false (case-insensitive)", () => {
      expect(telemetryDisabled({ SHEEPIT_TELEMETRY: "0" })).toBe(true);
      expect(telemetryDisabled({ SHEEPIT_TELEMETRY: "false" })).toBe(true);
      expect(telemetryDisabled({ SHEEPIT_TELEMETRY: "FALSE" })).toBe(true);
    });

    it("does NOT trip on SHEEPIT_TELEMETRY=1 / true", () => {
      expect(telemetryDisabled({ SHEEPIT_TELEMETRY: "1" })).toBe(false);
      expect(telemetryDisabled({ SHEEPIT_TELEMETRY: "true" })).toBe(false);
    });
  });

  it("trackTelemetry is a no-op (no POST) when DO_NOT_TRACK=1", async () => {
    process.env.DO_NOT_TRACK = "1";
    const post = vi.fn(async () => undefined);
    const api = makeApi(post);
    await trackTelemetry(api, {
      event: "$mcp_tool_invoked",
      properties: { tool_name: "campaign_list" },
      namespace: "mcp",
      version: "0.2.0",
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("trackTelemetry is a no-op (no POST) when SHEEPIT_TELEMETRY=0", async () => {
    process.env.SHEEPIT_TELEMETRY = "0";
    const post = vi.fn(async () => undefined);
    const api = makeApi(post);
    await trackTelemetry(api, {
      event: "$mcp_session_started",
      properties: {},
      namespace: "mcp",
      version: "0.2.0",
    });
    expect(post).not.toHaveBeenCalled();
  });

  it("trackTelemetry still POSTs when no opt-out is set", async () => {
    const post = vi.fn(async () => undefined);
    const api = makeApi(post);
    await trackTelemetry(api, {
      event: "$mcp_tool_invoked",
      properties: {},
      namespace: "mcp",
      version: "0.2.0",
    });
    expect(post).toHaveBeenCalledTimes(1);
  });
});
