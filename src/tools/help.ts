/**
 * Discovery tools for the MCP server. Surfaces "what can I do with this?"
 * inside the chat itself so a dogfooder doesn't have to leave the
 * conversation to read docs.
 *
 * Two layers:
 *   - `sheepit_help`           — top-level "what is this?" / "where do I
 *                                start?". Returns one of N curated topics.
 *   - `sheepit_quickstart`     — concrete N-step recipe for a specific
 *                                workflow (send_email_campaign,
 *                                analyze_signups, etc.). Each recipe
 *                                names the exact tool calls to chain.
 *
 * Why two tools, not one with a bigger enum: the LLM picks tools by
 * description, and "help me get started" vs "help me run X" are different
 * intents. Two narrow tools route better than one fat one.
 *
 * Bilingual content via `language` arg (en | es). Default `en`. The
 * server-level `instructions` string tells the LLM to pass `language:
 * "es"` when the user is writing in Spanish. Content lives in the
 * sister files `help-content-en.ts` + `help-content-es.ts` (data only,
 * no logic — see those files for translation contract).
 */

import { z } from "zod";
import { type Tool, defineTool } from "./define.js";
import {
  HELP_TOPICS,
  QUICKSTART_RECIPES,
  HELP_BODY_EN,
  QUICKSTART_BODY_EN,
} from "./help-content-en.js";
import { HELP_BODY_ES, QUICKSTART_BODY_ES } from "./help-content-es.js";

export const HELP_LANGUAGES = ["en", "es"] as const;
type HelpLanguage = (typeof HELP_LANGUAGES)[number];

const HELP_BODY_BY_LANGUAGE: Record<HelpLanguage, typeof HELP_BODY_EN> = {
  en: HELP_BODY_EN,
  es: HELP_BODY_ES,
};

const QUICKSTART_BODY_BY_LANGUAGE: Record<HelpLanguage, typeof QUICKSTART_BODY_EN> = {
  en: QUICKSTART_BODY_EN,
  es: QUICKSTART_BODY_ES,
};

export function buildHelpTools(): Tool[] {
  return [
    defineTool({
      name: "sheepit_help",
      title: "Sheepit help — what can I do?",
      description: [
        "Returns a curated overview of what this MCP server can do, or a deep-dive",
        "on a specific area. Call this WITHOUT a topic when the user asks 'what",
        "can I do?' / 'how do I get started?' / 'what is Sheepit?' (or the Spanish",
        "equivalents — '¿qué es sheepit?' / '¿qué puedo hacer?' / '¿qué",
        "herramientas tiene sheepit?'). Call WITH a topic when the user asks about",
        "a specific area (campaigns, destinations, dashboards, insights, feedback,",
        "credentials). Pass `language: 'es'` when the user is writing in Spanish",
        "so the returned content matches their language.",
      ].join(" "),
      inputSchema: z.object({
        topic: z
          .enum(HELP_TOPICS)
          .optional()
          .describe(
            "Optional area to deep-dive on. Omit for a top-level overview that names every tool surface.",
          ),
        language: z
          .enum(HELP_LANGUAGES)
          .optional()
          .describe(
            "User's conversation language. 'en' (default) or 'es' (neutral Latin American Spanish). Match the language the user is writing in.",
          ),
      }),
      async handler(input) {
        const topic = input.topic ?? "overview";
        const language: HelpLanguage = input.language ?? "en";
        const body = HELP_BODY_BY_LANGUAGE[language][topic];
        return {
          content: [{ type: "text", text: body }],
          structuredContent: {
            topic,
            language,
            available_topics: HELP_TOPICS,
            available_languages: HELP_LANGUAGES,
          },
        };
      },
    }),
    defineTool({
      name: "sheepit_quickstart",
      title: "Sheepit quickstart — concrete recipe for a goal",
      description: [
        "Returns a step-by-step recipe naming the exact tool calls to chain for",
        "a specific goal. Use when the user has a clear intent ('send a marketing",
        "email', 'analyze the signup funnel', 'wire a webhook' — or in Spanish",
        "'enviar un email de marketing', 'analizar el funnel de signups', etc.).",
        "Pass `language: 'es'` when the user is writing in Spanish.",
      ].join(" "),
      inputSchema: z.object({
        recipe: z
          .enum(QUICKSTART_RECIPES)
          .describe(
            "Which recipe to return. send_email_campaign | create_dashboard | analyze_signups | ship_feedback | wire_webhook_destination.",
          ),
        language: z
          .enum(HELP_LANGUAGES)
          .optional()
          .describe(
            "User's conversation language. 'en' (default) or 'es' (neutral Latin American Spanish). Match the language the user is writing in.",
          ),
      }),
      async handler(input) {
        const language: HelpLanguage = input.language ?? "en";
        return {
          content: [{ type: "text", text: QUICKSTART_BODY_BY_LANGUAGE[language][input.recipe] }],
          structuredContent: {
            recipe: input.recipe,
            language,
            available_recipes: QUICKSTART_RECIPES,
            available_languages: HELP_LANGUAGES,
          },
        };
      },
    }),
  ];
}
