/**
 * Tests for the experiment MCP tools.
 *
 * Cover: registry shape, input-schema validation (accept + reject paths,
 * including the variant/metric cardinality the client schema CAN catch),
 * create/update wiring, list passthrough, and structuredContent sanitisation
 * of tool-poisoning vectors (key / name / hypothesis / variant + metric names).
 *
 * NOTE: the cross-field invariants (exactly-one-control, weights sum to 100,
 * ≥1 primary metric) are enforced SERVER-SIDE, not in the vendored client
 * schema — these tests assert the client doesn't pre-reject otherwise-valid
 * shapes, leaving the authoritative check to the API (returns 400).
 */

import { describe, it, expect, vi } from "vitest";
import { buildExperimentTools } from "./experiments.js";
import type { ApiClient } from "../lib/api-client.js";
import { UNTRUSTED_REPLACEMENT_CHAR } from "../lib/untrust.js";

function makeApi(): ApiClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

const EXP_ID = "00000000-0000-0000-0000-000000000077";
const ENV_ID = "00000000-0000-0000-0000-000000000020";

const validCreateInput = {
  key: "checkout_copy_test",
  name: "Checkout Copy Test",
  hypothesis: "Shorter CTA copy lifts conversion.",
  environment_id: ENV_ID,
  traffic_pct: 20,
  variants: [
    { key: "control", name: "Control", is_control: true, weight: 50, payload: {} },
    { key: "short", name: "Short Copy", is_control: false, weight: 50, payload: {} },
  ],
  metrics: [
    {
      event_name: "checkout_completed",
      metric_type: "conversion" as const,
      is_primary: true,
      is_guardrail: false,
    },
  ],
};

const mockExperiment = {
  id: EXP_ID,
  key: "checkout_copy_test",
  name: "Checkout Copy Test",
  description: null,
  hypothesis: "Shorter CTA copy lifts conversion.",
  status: "draft",
  environment_id: ENV_ID,
  traffic_pct: 20,
  variants: [
    { key: "control", name: "Control", is_control: true, weight: 50 },
    { key: "short", name: "Short Copy", is_control: false, weight: 50 },
  ],
  metrics: [{ event_name: "checkout_completed", metric_type: "conversion", is_primary: true }],
  created_at: "2026-06-14T10:00:00.000Z",
  updated_at: "2026-06-14T10:00:00.000Z",
};

describe("Experiment tool registry", () => {
  it("registers exactly the 4 experiment tools", () => {
    const names = buildExperimentTools({ api: makeApi() })
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      "experiment_create",
      "experiment_get",
      "experiment_list",
      "experiment_update",
    ]);
  });

  it("every tool has a non-empty title + a substantive description", () => {
    for (const t of buildExperimentTools({ api: makeApi() })) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  it("create description names the secret-key/editor scope requirement", () => {
    const d = buildExperimentTools({ api: makeApi() })
      .find((t) => t.name === "experiment_create")!
      .description.toLowerCase();
    expect(d).toContain("secret");
    expect(d).toContain("editor");
  });
});

describe("experiment_create input validation", () => {
  const tool = () =>
    buildExperimentTools({ api: makeApi() }).find((t) => t.name === "experiment_create")!;

  it("accepts a well-formed experiment", () => {
    expect(tool().inputSchema.safeParse(validCreateInput).success).toBe(true);
  });

  it("rejects fewer than 2 variants", () => {
    const res = tool().inputSchema.safeParse({
      ...validCreateInput,
      variants: [validCreateInput.variants[0]],
    });
    expect(res.success).toBe(false);
  });

  it("rejects zero metrics", () => {
    const res = tool().inputSchema.safeParse({ ...validCreateInput, metrics: [] });
    expect(res.success).toBe(false);
  });

  it("rejects a non-uuid environment_id", () => {
    const res = tool().inputSchema.safeParse({ ...validCreateInput, environment_id: "prod" });
    expect(res.success).toBe(false);
  });

  it("rejects an unknown metric_type", () => {
    const res = tool().inputSchema.safeParse({
      ...validCreateInput,
      metrics: [{ event_name: "x", metric_type: "median", is_primary: true }],
    });
    expect(res.success).toBe(false);
  });

  it("rejects a malformed key", () => {
    const res = tool().inputSchema.safeParse({ ...validCreateInput, key: "Checkout-Test" });
    expect(res.success).toBe(false);
  });
});

describe("experiment_create wiring", () => {
  it("POSTs /v1/experiments and surfaces the draft in structuredContent", async () => {
    const api = makeApi();
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: mockExperiment });

    const tool = buildExperimentTools({ api }).find((t) => t.name === "experiment_create")!;
    const result = await tool.handler(validCreateInput);

    expect(api.post).toHaveBeenCalledWith(
      "/v1/experiments",
      expect.objectContaining({
        key: "checkout_copy_test",
        environment_id: ENV_ID,
      }),
    );
    const sc = result.structuredContent as { experiment: { id: string; status: string } };
    expect(sc.experiment.id).toBe(EXP_ID);
    expect(result.content[0].text).toContain("Created draft experiment");
  });

  it("sanitises hypothesis + variant names in structuredContent", async () => {
    const api = makeApi();
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        ...mockExperiment,
        hypothesis: "lift\x00<script>evil</script>",
        variants: [
          { key: "control", name: "Control\x1Fhack", is_control: true, weight: 50 },
          { key: "short", name: "Short", is_control: false, weight: 50 },
        ],
      },
    });

    const tool = buildExperimentTools({ api }).find((t) => t.name === "experiment_create")!;
    const result = await tool.handler(validCreateInput);

    const sc = result.structuredContent as {
      experiment: { hypothesis: string; variants: Array<{ name: string }> };
    };
    expect(sc.experiment.hypothesis).toContain(UNTRUSTED_REPLACEMENT_CHAR);
    expect(sc.experiment.hypothesis).not.toContain("<");
    expect(sc.experiment.variants[0].name).toContain(UNTRUSTED_REPLACEMENT_CHAR);
  });
});

describe("experiment_get sanitisation", () => {
  it("strips nested string values inside variant payload (tool-poisoning vector)", async () => {
    const api = makeApi();
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: {
        ...mockExperiment,
        variants: [
          {
            key: "control",
            name: "Control",
            is_control: true,
            weight: 50,
            payload: { headline: "evil\x00<script>x</script>" },
          },
          { key: "short", name: "Short", is_control: false, weight: 50, payload: {} },
        ],
      },
    });

    const tool = buildExperimentTools({ api }).find((t) => t.name === "experiment_get")!;
    const result = await tool.handler({ id: EXP_ID });

    const sc = result.structuredContent as {
      experiment: { variants: Array<{ payload: { headline?: string } }> };
    };
    expect(sc.experiment.variants[0].payload.headline).toContain(UNTRUSTED_REPLACEMENT_CHAR);
    expect(sc.experiment.variants[0].payload.headline).not.toContain("<");
  });
});

describe("experiment_update wiring", () => {
  it("strips id from the body and PATCHes /v1/experiments/:id", async () => {
    const api = makeApi();
    (api.patch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: { ...mockExperiment, traffic_pct: 35 },
    });

    const tool = buildExperimentTools({ api }).find((t) => t.name === "experiment_update")!;
    await tool.handler({ id: EXP_ID, traffic_pct: 35 });

    expect(api.patch).toHaveBeenCalledWith(`/v1/experiments/${EXP_ID}`, { traffic_pct: 35 });
  });

  it("rejects traffic_pct out of range at the boundary", () => {
    const tool = buildExperimentTools({ api: makeApi() }).find(
      (t) => t.name === "experiment_update",
    )!;
    expect(tool.inputSchema.safeParse({ id: EXP_ID, traffic_pct: 0 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ id: EXP_ID, traffic_pct: 101 }).success).toBe(false);
  });
});

describe("experiment_list", () => {
  it("defaults limit to 20 and forwards status filter", async () => {
    const api = makeApi();
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data: [mockExperiment],
      pagination: { cursor: null, has_more: false },
    });

    const tool = buildExperimentTools({ api }).find((t) => t.name === "experiment_list")!;
    await tool.handler({ status: "draft", limit: 20 });

    expect(api.get).toHaveBeenCalledWith("/v1/experiments", { limit: 20, status: "draft" });
  });
});
