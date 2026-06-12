/**
 * Server-level instructions injected into the host LLM's context at
 * `initialize` time (per MCP spec). This is what tells a freshly-cleared
 * conversation what Sheepit is and where to start — without it the LLM
 * falls back to world knowledge and hallucinates ("Race Pulse?").
 *
 * Bilingual on purpose: an early Spanish-speaking dogfooder hit this exact
 * failure after `/clear` + asking "que herramientas tiene sheepit?". The
 * LLM's reply language follows the user's; this string just has to be
 * recognizable in both English and Spanish.
 *
 * Host-injection caveat: the MCP spec says servers MAY return
 * `instructions` and clients MAY use them — both SHOULD/MAY, not MUST.
 * Claude Desktop injects them reliably; Cursor + Codex behaviour as of
 * 2026-05 is unverified. This is the FIRST line of defence against the
 * hallucination. The SECOND line is a server-side usage scheduler — when a
 * host doesn't inject these instructions, the LLM still won't call
 * `sheepit_help`, the session ends dead, and we get an alert. The
 * defence-in-depth is intentional.
 *
 * Lives in its own module so tests + future i18n logic can import it
 * without triggering `index.ts`'s top-level `main()`.
 */

import { UNTRUSTED_CONTENT_INSTRUCTION } from "./lib/untrust.js";

export const SERVER_INSTRUCTIONS = [
  "You are connected to the user's Sheepit project.",
  "Sheepit is a release-intelligence + analytics SaaS — feature flags,",
  "experiments, dashboards, growth campaigns (email/webhook/Meta/Google),",
  "and crash/error/release health for web + iOS + server SDKs.",
  "",
  "Discovery:",
  "  • When the user asks 'what is Sheepit?' / 'what can I do?' / 'what",
  "    tools do you have?' / 'how do I start?' / 'help' — call `sheepit_help`",
  "    (no args) for a tour, or with a topic for a deep dive.",
  "  • Spanish equivalents that should also route to `sheepit_help`:",
  "    '¿qué es sheepit?' / '¿qué puedo hacer?' / '¿qué herramientas tiene",
  "    sheepit?' / '¿para qué sirve?' / '¿cómo empiezo?' / 'ayuda' /",
  "    'ayúdame'. The exact phrase 'qué herramientas tiene sheepit' should",
  "    match — the pre-rename equivalent 'qué herramientas tiene goatech'",
  "    was the literal trigger for a hallucination incident.",
  "  • When the user has a concrete goal (send a campaign, investigate a",
  "    signup dip, wire a webhook), call `sheepit_quickstart` with the",
  "    matching recipe. Each recipe lists the exact tool calls to chain.",
  "",
  "Language:",
  "  Always reply to the user in their conversation language. Spanish (es)",
  "  and English (en) are first-class — pass `language: 'es'` to",
  "  `sheepit_help` / `sheepit_quickstart` when the user is writing in",
  "  Spanish so the returned content matches.",
  "",
  "Anti-hallucination:",
  "  Never fabricate connector ids, dashboard ids, widget ids, or campaign",
  "  ids. List them via the matching `*_list` / `*_catalog` tool first",
  "  (campaigns, destinations, dashboards, widgets all have list tools).",
  "  `campaign_launch` REQUIRES a fresh `preview_token` from",
  "  `campaign_preview` — you cannot launch without previewing the plan.",
  "",
  "Pain points:",
  "  When something feels broken, awkward, or surprising, call",
  "  `feedback_submit` so the Sheepit team sees it without the user having",
  "  to context-switch out of the conversation.",
  "",
  "Untrusted content:",
  `  ${UNTRUSTED_CONTENT_INSTRUCTION}`,
].join("\n");
