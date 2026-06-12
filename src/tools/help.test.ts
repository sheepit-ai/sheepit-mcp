import { describe, it, expect } from "vitest";
import { buildHelpTools } from "./help.js";
import { HELP_BODY_EN } from "./help-content-en.js";
import { HELP_BODY_ES } from "./help-content-es.js";
import { insightsQueryRequestSchema } from "../vendor/index.js";

/**
 * Discovery tools must:
 *   - register exactly the two documented tools
 *   - return non-trivial text for every topic / recipe in EVERY supported
 *     language (no silent stubs, no English leaking into a Spanish reply)
 *   - reject unknown topics + recipes + languages at the schema layer
 */

describe("Help tool registry", () => {
  it("registers sheepit_help + sheepit_quickstart", () => {
    const names = buildHelpTools()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(["sheepit_help", "sheepit_quickstart"]);
  });

  it("every tool has a non-empty description", () => {
    for (const t of buildHelpTools()) {
      expect(t.description.length).toBeGreaterThan(40);
    }
  });

  it("every tool description mentions Spanish so the LLM knows to pass language=es", () => {
    for (const t of buildHelpTools()) {
      expect(t.description.toLowerCase()).toMatch(/spanish|español/);
    }
  });
});

describe("sheepit_help", () => {
  const tool = buildHelpTools().find((t) => t.name === "sheepit_help")!;

  it("returns the overview when no topic is supplied (default English)", async () => {
    const parsed = tool.inputSchema.safeParse({});
    expect(parsed.success).toBe(true);
    const res = await tool.handler({});
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("Sheepit MCP");
    expect(res.content[0].text).toContain("sheepit_quickstart");
  });

  it("returns Spanish overview when language=es", async () => {
    const res = await tool.handler({ language: "es" });
    expect(res.content[0].text).toContain("Sheepit MCP");
    expect(res.content[0].text).toContain("qué puedes hacer");
    // Spanish-specific phrasing — won't match English content.
    expect(res.content[0].text).toMatch(/audiencia|campaña|previsualiza/);
  });

  it("returns topic-specific text for each known topic in BOTH languages", async () => {
    const overview = await tool.handler({});
    const topics = (overview.structuredContent as { available_topics: readonly string[] })
      .available_topics;
    expect(topics.length).toBeGreaterThanOrEqual(7);

    for (const topic of topics) {
      for (const language of ["en", "es"] as const) {
        const res = await tool.handler({ topic, language });
        const text = res.content[0].text;
        expect(text.length).toBeGreaterThan(200);
      }
    }
  });

  it("Spanish content differs from English content for every topic", async () => {
    const overview = await tool.handler({});
    const topics = (overview.structuredContent as { available_topics: readonly string[] })
      .available_topics;
    for (const topic of topics) {
      const en = await tool.handler({ topic, language: "en" });
      const es = await tool.handler({ topic, language: "es" });
      expect(es.content[0].text).not.toEqual(en.content[0].text);
    }
  });

  it("integration-coach topics ship — sdk_integration / event_conventions / flag_patterns / debugging_with_sheepit", async () => {
    const overview = await tool.handler({});
    const topics = (overview.structuredContent as { available_topics: readonly string[] })
      .available_topics;
    for (const required of [
      "sdk_integration",
      "event_conventions",
      "flag_patterns",
      "debugging_with_sheepit",
    ]) {
      expect(topics).toContain(required);
    }
  });

  it("rejects unknown topics at the schema layer", () => {
    const parsed = tool.inputSchema.safeParse({ topic: "campaigns_v2" });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown languages at the schema layer", () => {
    const parsed = tool.inputSchema.safeParse({ language: "fr" });
    expect(parsed.success).toBe(false);
  });

  it("structuredContent reports the language back so the LLM can verify routing", async () => {
    const en = await tool.handler({});
    expect((en.structuredContent as { language: string }).language).toBe("en");
    const es = await tool.handler({ language: "es" });
    expect((es.structuredContent as { language: string }).language).toBe("es");
  });
});

describe("sheepit_quickstart", () => {
  const tool = buildHelpTools().find((t) => t.name === "sheepit_quickstart")!;

  it("requires a recipe (no implicit default)", () => {
    const parsed = tool.inputSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it("returns recipe text for each known recipe in BOTH languages", async () => {
    const someRecipe = await tool.handler({ recipe: "send_email_campaign" });
    const recipes = (someRecipe.structuredContent as { available_recipes: readonly string[] })
      .available_recipes;
    expect(recipes.length).toBeGreaterThanOrEqual(5);

    for (const recipe of recipes) {
      for (const language of ["en", "es"] as const) {
        const res = await tool.handler({ recipe, language });
        const text = res.content[0].text;
        expect(text.length).toBeGreaterThan(200);
        // Every recipe must reference at least one tool, command, or
        // canonical event name — otherwise it's not actually actionable.
        // Code identifiers stay byte-identical across translations, so
        // this regex catches BOTH languages.
        expect(text).toMatch(
          /(campaign_|destination_|dashboard_|widget_|insights_query|feedback_submit|event_catalog_canonical|useFlag|useTrack|signup_completed|sheepit )/,
        );
      }
    }
  });

  it("Spanish recipes preserve every code identifier byte-identical to English", async () => {
    // Translation contract: code identifiers (tool names, endpoint paths,
    // env vars, JSON snippets) are addressable contracts and must NOT be
    // translated. Prose may be localized freely. Spot-check on a recipe
    // that exercises many identifiers.
    const en = await tool.handler({ recipe: "send_email_campaign" });
    const es = await tool.handler({ recipe: "send_email_campaign", language: "es" });
    const enText = en.content[0].text;
    const esText = es.content[0].text;

    const sentinels = [
      "destination_catalog",
      "destination_create",
      "destination_test",
      "campaign_create",
      "campaign_preview",
      "campaign_launch",
      "campaign_results",
      "connector_id",
      "preview_token",
      "course_enrolled",
      // Email From — display name is Sheepit (matches the help content
      // post-rebrand) but the @goatech.ai domain stays per the AWS-
      // migration gate (see `~/.sheepit/credentials.json` docstring).
      "Sheepit <noreply@goatech.ai>",
    ];
    for (const s of sentinels) {
      expect(enText).toContain(s);
      expect(esText).toContain(s);
    }
  });

  it("integration recipes ship — instrument_signup_funnel / add_first_flag / wire_release_health / diagnose_a_regression", async () => {
    const someRecipe = await tool.handler({ recipe: "send_email_campaign" });
    const recipes = (someRecipe.structuredContent as { available_recipes: readonly string[] })
      .available_recipes;
    for (const required of [
      "instrument_signup_funnel",
      "add_first_flag",
      "wire_release_health",
      "diagnose_a_regression",
    ]) {
      expect(recipes).toContain(required);
    }
  });

  it("rejects unknown recipes", () => {
    const parsed = tool.inputSchema.safeParse({ recipe: "send_sms_campaign" });
    expect(parsed.success).toBe(false);
  });

  it("rejects unknown languages at the schema layer", () => {
    const parsed = tool.inputSchema.safeParse({
      recipe: "send_email_campaign",
      language: "pt",
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * Schema drift gate: the `insights` topic in `help-content-en.ts` +
 * `help-content-es.ts` embeds a JSON example of `insights_query`'s wire
 * envelope. If the schema drifts (renamed field, removed enum value, new
 * required field), this test fails — surfaces doc drift in CI instead of
 * silently misleading an LLM caller.
 *
 * The example is extracted from the markdown by locating the first
 * fenced ```json block in each language's insights topic and running it
 * through `insightsQueryRequestSchema.safeParse`.
 */
function extractFirstJsonFence(markdown: string): string | null {
  const match = markdown.match(/```json\n([\s\S]*?)\n```/);
  return match ? match[1]! : null;
}

describe("insights help-content example matches insightsQueryRequestSchema", () => {
  for (const [lang, body] of [
    ["en", HELP_BODY_EN.insights],
    ["es", HELP_BODY_ES.insights],
  ] as const) {
    it(`${lang}: the documented JSON example parses against insightsQueryRequestSchema`, () => {
      const json = extractFirstJsonFence(body);
      expect(json, `no json fence found in ${lang} insights help`).not.toBeNull();
      const parsed = JSON.parse(json!);
      const result = insightsQueryRequestSchema.safeParse(parsed);
      if (!result.success) {
        // Surface the first issue verbatim — makes drift debuggable.
        throw new Error(
          `${lang} insights help example does not match insightsQueryRequestSchema:\n` +
            JSON.stringify(result.error.issues, null, 2),
        );
      }
    });
  }
});
