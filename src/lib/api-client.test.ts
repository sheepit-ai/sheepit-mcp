/**
 * Regression tests for the MCP api-client wrapper.
 *
 * The most important assertion here is the `content-type` discipline:
 * Fastify rejects empty-body requests with `content-type: application/json`
 * set (FST_ERR_CTP_EMPTY_JSON_BODY → 400). Pre-fix, every DELETE call from
 * the MCP (dashboard_delete, destination_delete, campaign_archive) hit
 * this bug in prod even though every unit test passed against a mocked
 * api-client. We mock fetch directly here so the regression is wire-true.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createApiClient, ApiError, recoveryHint } from "./api-client.js";
import type { ResolvedCredential } from "./credentials.js";

const creds: ResolvedCredential = {
  profileName: "test",
  apiKey: "lp_sec_test_0000000000000000000000000000000000000000000000000000000000000000",
  apiUrl: "https://api.example.com",
  projectSlug: "test",
};

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function mockFetch(captured: CapturedRequest[], response: Partial<Response> = {}): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : "";
    const headersObj: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headersObj[k.toLowerCase()] = String(v);
    }
    captured.push({
      url,
      method: init?.method ?? "GET",
      headers: headersObj,
      body: init?.body as string | undefined,
    });
    return new Response(response.body ?? null, {
      status: response.status ?? 204,
      headers: response.headers,
    });
  }) as unknown as typeof fetch;
}

describe("api-client request shape", () => {
  let captured: CapturedRequest[];
  beforeEach(() => {
    captured = [];
    globalThis.fetch = mockFetch(captured, { status: 204 });
  });

  it("DELETE without body must NOT send content-type", async () => {
    // Pre-fix this would silently include `content-type: application/json`,
    // and Fastify would reply 400 FST_ERR_CTP_EMPTY_JSON_BODY in prod.
    const api = createApiClient(creds);
    await api.delete("/v1/dashboards/00000000-0000-0000-0000-000000000001");

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.method).toBe("DELETE");
    expect(req.headers["content-type"]).toBeUndefined();
    // Body must not be set on a no-body DELETE.
    expect(req.body).toBeUndefined();
  });

  it("GET without body must NOT send content-type", async () => {
    globalThis.fetch = mockFetch(captured, {
      status: 200,
      body: JSON.stringify({ data: [] }),
      headers: { "content-type": "application/json" },
    });
    const api = createApiClient(creds);
    await api.get("/v1/dashboards");
    const req = captured[0]!;
    expect(req.headers["content-type"]).toBeUndefined();
  });

  it("POST with body MUST send content-type", async () => {
    globalThis.fetch = mockFetch(captured, {
      status: 201,
      body: JSON.stringify({ data: { id: "x" } }),
      headers: { "content-type": "application/json" },
    });
    const api = createApiClient(creds);
    await api.post("/v1/dashboards", { name: "x" });
    const req = captured[0]!;
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body).toBe(JSON.stringify({ name: "x" }));
  });

  it("POST with no body argument must NOT send content-type", async () => {
    // POSTs that take no body (e.g. some test endpoints) should also
    // skip content-type so the server's body parser doesn't 400.
    const api = createApiClient(creds);
    await api.post("/v1/destinations/abc/test");
    const req = captured[0]!;
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toBeUndefined();
    expect(req.body).toBeUndefined();
  });

  it("PATCH with body MUST send content-type", async () => {
    globalThis.fetch = mockFetch(captured, {
      status: 200,
      body: JSON.stringify({ data: { id: "x" } }),
      headers: { "content-type": "application/json" },
    });
    const api = createApiClient(creds);
    await api.patch("/v1/dashboards/abc", { name: "x" });
    const req = captured[0]!;
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body).toBe(JSON.stringify({ name: "x" }));
  });

  it("authorization + user-agent are always sent", async () => {
    const api = createApiClient(creds);
    await api.delete("/v1/x");
    const req = captured[0]!;
    expect(req.headers["authorization"]).toBe(`Bearer ${creds.apiKey}`);
    expect(req.headers["user-agent"]).toMatch(/^sheepit-mcp\//);
  });

  it("204 No Content resolves with undefined", async () => {
    const api = createApiClient(creds);
    const result = await api.get<unknown>("/v1/dashboards/204");
    expect(result).toBeUndefined();
  });

  it("4xx with structured error envelope throws ApiError with code/message", async () => {
    globalThis.fetch = mockFetch(captured, {
      status: 404,
      body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Dashboard not found." } }),
      headers: { "content-type": "application/json" },
    });
    const api = createApiClient(creds);
    await expect(api.get("/v1/dashboards/missing")).rejects.toMatchObject({
      status: 404,
      code: "NOT_FOUND",
      message: "Dashboard not found.",
    });
  });

  it("4xx without structured envelope falls back to UNKNOWN code", async () => {
    globalThis.fetch = mockFetch(captured, {
      status: 400,
      body: JSON.stringify({
        statusCode: 400,
        code: "FST_ERR_CTP_EMPTY_JSON_BODY",
        message: "Body cannot be empty when content-type is set to 'application/json'",
      }),
      headers: { "content-type": "application/json" },
    });
    const api = createApiClient(creds);
    let caught: ApiError | null = null;
    try {
      await api.delete("/v1/x");
    } catch (e) {
      caught = e as ApiError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.status).toBe(400);
    expect(caught!.code).toBe("UNKNOWN");
  });
});

describe("recoveryHint (M5)", () => {
  it("names sheepit login on 401", () => {
    expect(recoveryHint(401, "UNAUTHORIZED")).toMatch(/sheepit login/);
    expect(recoveryHint(401, "ANY")).toMatch(/SHEEPIT_API_KEY/);
  });

  it("names admin-scope on 403", () => {
    expect(recoveryHint(403, "FORBIDDEN")).toMatch(/admin/);
  });

  it("suggests retry on 503", () => {
    expect(recoveryHint(503, "SERVICE_UNAVAILABLE")).toMatch(/retry/i);
  });

  it("points at destination_catalog for UNKNOWN_CONNECTOR (400)", () => {
    expect(recoveryHint(400, "UNKNOWN_CONNECTOR")).toMatch(/destination_catalog/);
  });

  it("suggests backoff on 429", () => {
    expect(recoveryHint(429, "TOO_MANY")).toMatch(/Retry-After/);
  });

  it("suggests retry-once on 5xx", () => {
    expect(recoveryHint(500, "INTERNAL")).toMatch(/retry/i);
    expect(recoveryHint(502, "BAD_GATEWAY")).toMatch(/retry/i);
  });

  it("returns empty string for 200 / 400 without recognized code", () => {
    expect(recoveryHint(200, "OK")).toBe("");
    expect(recoveryHint(400, "VALIDATION_ERROR")).toBe("");
  });
});
