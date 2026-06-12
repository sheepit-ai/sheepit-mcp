import { describe, it, expect } from "vitest";
import { SERVER_INSTRUCTIONS } from "./instructions.js";

// Regression guard: the MCP instructions string is what the host LLM
// sees at `initialize` time. After a hallucination incident where an
// early Spanish-speaking dogfooder hit `/clear` → "qué herramientas
// tiene goatech?" → "Race Pulse?", specific phrases here are
// load-bearing — they're what routes the LLM to `sheepit_help` instead
// of falling back to world knowledge. If a future edit drops one of
// these phrases, this test catches it.

describe("SERVER_INSTRUCTIONS", () => {
  it("identifies the product as Sheepit", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/Sheepit/);
  });

  it("names the sheepit_help tool as the discovery entry point", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/sheepit_help/);
  });

  it("names the sheepit_quickstart tool for goal-driven flows", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/sheepit_quickstart/);
  });

  it("includes a Spanish trigger phrase so the LLM routes Spanish questions correctly", () => {
    // ¿qué es sheepit? is the post-rename equivalent of the literal
    // phrase that triggered the hallucination incident pre-rebrand. If
    // the string ever stops including a Spanish "what is" / "what can I
    // do" form, that failure mode comes back.
    expect(SERVER_INSTRUCTIONS.toLowerCase()).toMatch(/qué es sheepit|qué puedo hacer/);
  });

  it("anchors anti-hallucination with the connector_id rule", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/connector ids|connector_id/i);
  });

  it("mentions feedback_submit for in-conversation pain capture", () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/feedback_submit/);
  });

  it("stays under the 4 KB MCP-spec soft limit", () => {
    // The MCP spec doesn't hard-cap instructions length, but hosts
    // (Claude Desktop, Cursor) inline this into the system prompt —
    // bloating it costs every conversation tokens. 4 KB ≈ 1k tokens
    // and still leaves room for room for routing rules.
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(4_096);
  });
});
