/**
 * `event_catalog_canonical` — returns the events GoaTech "understands"
 * out of the box (so they show up in pre-built dashboards and templates
 * without manual rework) merged with the project's own registered
 * EventSchema rows (the customer's custom events).
 *
 * The point: when the LLM is about to write `track("UserSignedUp")`, it
 * should call this tool first, see that the canonical name is
 * `signup_completed`, and use that instead. New name → goes into the
 * pre-built funnel template automatically. Wrong name → invisible to
 * every default dashboard.
 *
 * Catalog grain:
 *   - `system`     events emitted automatically by the SDK
 *                  (`$session_start`, `$pageview`, `$error`,
 *                  `$rage_click`, `$dead_click`, `$page_leave`).
 *                  Customers do NOT emit these; the SDK does.
 *   - `auth`       customer-emit lifecycle events GoaTech's signup
 *                  template watches.
 *   - `funnel`     conversion events (course_viewed, course_enrolled,
 *                  module_completed, etc.) — these power the Funnel
 *                  archetype + retention widgets.
 *   - `commerce`   payment / checkout / subscription events.
 *   - `engagement` content / feature interaction events.
 *
 * Customer events: when called against a project that has registered
 * `EventSchema` rows, those merge in under `customer_events` so the
 * LLM sees what's already in use and avoids creating accidental
 * duplicates.
 *
 * The catalog is hand-curated in this file. Drift between this list and
 * what the dashboard templates actually query is a real problem — keep
 * them in lockstep. When you add a new template that watches a new event
 * name, add it here too.
 */

import { z } from "zod";
import type { ApiClient } from "../lib/api-client.js";
import { sanitizeUntrustedFields } from "../lib/untrust.js";
import { type Tool, defineTool } from "./define.js";

// Customer-controlled string fields on EventSchema that round-trip via
// the structuredContent channel. `properties` is opaque JSON — see
// runtime walk below.
const CUSTOMER_EVENT_FIELDS = ["*.event_name", "*.description", "*.category"];

interface EventCatalogToolDeps {
  api: ApiClient;
}

interface CanonicalEvent {
  name: string;
  category: "system" | "auth" | "funnel" | "commerce" | "engagement";
  description: string;
  /** Properties GoaTech's default dashboards / archetypes / templates
   *  read. Listing them so the LLM emits the right keys; missing them
   *  doesn't break anything but makes the customer's data thinner in
   *  pre-built views. */
  recommended_properties: Array<{
    name: string;
    type: "string" | "number" | "boolean" | "object" | "array";
    description: string;
    optional?: boolean;
  }>;
  /** When (in customer code) this fires. */
  when_to_emit: string;
  /** True for events the SDK auto-fires; the customer should NOT call
   *  `track()` for these manually. */
  emitted_by_sdk?: boolean;
}

const CANONICAL_EVENTS: CanonicalEvent[] = [
  // ── system (SDK auto-emits — customers do NOT call track() for these)
  {
    name: "$session_start",
    category: "system",
    description:
      "Fires once per session (30-min idle window) with first-touch attribution. Powers DAU + acquisition templates.",
    recommended_properties: [
      { name: "utm_source", type: "string", description: "from URL", optional: true },
      { name: "utm_medium", type: "string", description: "from URL", optional: true },
      { name: "utm_campaign", type: "string", description: "from URL", optional: true },
      { name: "referrer", type: "string", description: "document.referrer", optional: true },
      { name: "landing_page", type: "string", description: "first path of the session" },
    ],
    when_to_emit: "Auto: SDK fires on first event after session rollover.",
    emitted_by_sdk: true,
  },
  {
    name: "$pageview",
    category: "system",
    description: "SPA route change or initial load. Powers acquisition + funnel templates.",
    recommended_properties: [
      { name: "path", type: "string", description: "URL pathname" },
      { name: "title", type: "string", description: "document.title", optional: true },
    ],
    when_to_emit: "Auto: SDK hooks into history events / Next.js router.",
    emitted_by_sdk: true,
  },
  {
    name: "$page_leave",
    category: "system",
    description:
      "Fires on tab close / navigation away. Carries time-on-page, max-scroll-depth, hidden-time, exit-kind. Powers Friction template.",
    recommended_properties: [
      { name: "path", type: "string", description: "URL of the leaving page" },
      { name: "time_on_page_ms", type: "number", description: "active time" },
      { name: "max_scroll_pct", type: "number", description: "0-100" },
      { name: "exit_kind", type: "string", description: "navigate | close | hidden" },
    ],
    when_to_emit: "Auto: SDK hooks into pagehide / visibilitychange.",
    emitted_by_sdk: true,
  },
  {
    name: "$rage_click",
    category: "system",
    description:
      "3+ clicks within 1s in a 50px radius — frustration signal. Powers Friction template.",
    recommended_properties: [
      { name: "target", type: "string", description: "tag#id.class — never inner text" },
      { name: "click_count", type: "number", description: "always >=3" },
    ],
    when_to_emit: "Auto: SDK installs document listener.",
    emitted_by_sdk: true,
  },
  {
    name: "$dead_click",
    category: "system",
    description:
      "Click on a non-interactive target with no preventDefault — likely missing handler.",
    recommended_properties: [{ name: "target", type: "string", description: "tag#id.class" }],
    when_to_emit: "Auto: SDK installs document listener.",
    emitted_by_sdk: true,
  },
  {
    name: "$error",
    category: "system",
    description:
      "Uncaught error / unhandled rejection / React render crash. Powers the Errors & Health template.",
    recommended_properties: [
      { name: "message", type: "string", description: "error message (truncated)" },
      { name: "stack", type: "string", description: "stack trace (truncated)", optional: true },
      { name: "component_stack", type: "string", description: "React errors only", optional: true },
    ],
    when_to_emit:
      "Auto: SDK BrowserErrorCapture (web) / uncaughtException (server) / ErrorBoundary (React).",
    emitted_by_sdk: true,
  },

  // ── auth (customer emits)
  {
    name: "signup_completed",
    category: "auth",
    description:
      "User finished sign-up (form submitted, account created). Anchors the Acquisition + DAU templates.",
    recommended_properties: [
      { name: "method", type: "string", description: 'e.g. "email" | "google" | "github"' },
      { name: "plan", type: "string", description: "selected plan if applicable", optional: true },
    ],
    when_to_emit:
      "After the server confirms the user record was created and email is verified-or-pending.",
  },
  {
    name: "login_succeeded",
    category: "auth",
    description: "Existing user finished a login round-trip.",
    recommended_properties: [
      { name: "method", type: "string", description: 'e.g. "email" | "google"' },
    ],
    when_to_emit: "After the access token is set in memory; AFTER refresh-cookie set.",
  },
  {
    name: "login_failed",
    category: "auth",
    description: "Login attempt failed. Powers a security-canary widget for credential-stuffing.",
    recommended_properties: [
      {
        name: "reason",
        type: "string",
        description: "invalid_credentials | locked | rate_limited",
      },
    ],
    when_to_emit: "When the auth route returns 401 / 403 / 429.",
  },

  // ── funnel (customer emits)
  {
    name: "course_viewed",
    category: "funnel",
    description: "Student opened a course detail page. Top of the learning funnel.",
    recommended_properties: [
      { name: "course_slug", type: "string", description: "course slug" },
      { name: "course_title", type: "string", description: "for display" },
    ],
    when_to_emit: "On course detail page mount.",
  },
  {
    name: "course_enrolled",
    category: "funnel",
    description:
      "Student completed enrollment (free or paid). Anchors the success_metric for marketing campaigns.",
    recommended_properties: [
      { name: "course_slug", type: "string", description: "course slug" },
      { name: "source", type: "string", description: "checkout | gift | early_access | comp" },
      { name: "price_cents", type: "number", description: "0 for free", optional: true },
    ],
    when_to_emit: "After Enrollment row writes. Always include `source`.",
  },
  {
    name: "module_started",
    category: "funnel",
    description: "Student opened the first module after enrollment.",
    recommended_properties: [
      { name: "course_slug", type: "string", description: "course slug" },
      { name: "module_id", type: "string", description: "uuid" },
    ],
    when_to_emit: "First time the module reader mounts for a given module per session.",
  },
  {
    name: "module_completed",
    category: "funnel",
    description: "Student finished a module (scroll-to-bottom or explicit complete).",
    recommended_properties: [
      { name: "course_slug", type: "string", description: "course slug" },
      { name: "module_id", type: "string", description: "uuid" },
    ],
    when_to_emit: "When ModuleProgress.completed flips true.",
  },
  {
    name: "course_completed",
    category: "funnel",
    description: "All modules in the course are complete. Triggers Certificate generation.",
    recommended_properties: [{ name: "course_slug", type: "string", description: "course slug" }],
    when_to_emit: "After server confirms last module completed + Certificate generated.",
  },

  // ── commerce
  {
    name: "checkout_started",
    category: "commerce",
    description: "User entered a payment flow. Anchors the cart-to-purchase funnel.",
    recommended_properties: [
      { name: "course_slug", type: "string", description: "course slug" },
      { name: "price_cents", type: "number", description: "list price" },
      { name: "currency", type: "string", description: "ISO-4217" },
    ],
    when_to_emit: "User clicks 'Buy' / payment session created.",
  },
  {
    name: "payment_succeeded",
    category: "commerce",
    description: "Provider webhook confirms payment captured.",
    recommended_properties: [
      { name: "amount_cents", type: "number", description: "settled amount" },
      { name: "currency", type: "string", description: "ISO-4217" },
      { name: "provider", type: "string", description: "stripe | paddle | apple" },
    ],
    when_to_emit: "Server-side, on confirmed webhook (NOT client-side).",
  },
  {
    name: "payment_failed",
    category: "commerce",
    description:
      "Provider webhook reports a failed charge. Powers the failed-payment queue widget.",
    recommended_properties: [
      { name: "reason", type: "string", description: "card_declined | insufficient_funds | ..." },
      { name: "provider", type: "string", description: "stripe | paddle | apple" },
    ],
    when_to_emit: "Server-side, on confirmed webhook.",
  },
  {
    name: "subscription_created",
    category: "commerce",
    description: "Recurring subscription started.",
    recommended_properties: [
      { name: "plan", type: "string", description: "plan key" },
      { name: "interval", type: "string", description: "month | year" },
    ],
    when_to_emit: "Server-side, on subscription webhook.",
  },

  // ── engagement (catch-all customer events worth standardizing)
  {
    name: "feature_used",
    category: "engagement",
    description: "Generic 'user did the thing'. Use when no more-specific event applies.",
    recommended_properties: [
      { name: "feature", type: "string", description: "stable feature key, snake_case" },
      { name: "value", type: "string", description: "context", optional: true },
    ],
    when_to_emit: "After the action completes successfully.",
  },
  {
    name: "search_performed",
    category: "engagement",
    description: "User submitted a search query.",
    recommended_properties: [
      {
        name: "query_length",
        type: "number",
        description: "char count, NOT the query itself (PII)",
      },
      { name: "result_count", type: "number", description: "rows returned" },
    ],
    when_to_emit: "After the search response renders.",
  },
];

interface CustomerSchemaEnvelope {
  data: Array<{
    event_name: string;
    description?: string | null;
    category?: string | null;
    status?: string | null;
    /** EventSchema.properties is JSON in Prisma — server returns whatever
     *  the customer registered. Treat as opaque from our side. */
    properties?: Record<string, unknown>;
  }>;
  pagination?: { cursor: string | null; has_more: boolean };
}

export function buildEventCatalogTools({ api }: EventCatalogToolDeps): Tool[] {
  return [
    defineTool({
      name: "event_catalog_canonical",
      title: "GoaTech canonical event catalog",
      description: [
        "Returns the events GoaTech understands out of the box (so they",
        "appear in pre-built dashboards / templates without manual rework)",
        "merged with the project's own registered custom events.",
        "",
        "Call this BEFORE writing any new `track()` / `client.track()` /",
        "`useTrack()` callsite — if a canonical event covers what you're",
        "about to emit, use the canonical name (e.g. `signup_completed`,",
        "not `UserSignedUp` or `signup_done`). Customers also benefit:",
        "their custom events show up under `customer_events` so you can",
        "match the convention they've already established.",
        "",
        "Filter to one category with `category` to avoid context bloat.",
      ].join(" "),
      inputSchema: z.object({
        category: z
          .enum(["system", "auth", "funnel", "commerce", "engagement"])
          .optional()
          .describe(
            "Optional filter. system events are SDK-auto-emitted (don't call track for these); auth/funnel/commerce/engagement are customer-emit.",
          ),
        include_customer_events: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Include the project's registered EventSchema rows (set false if you only want the GoaTech canonical list).",
          ),
      }),
      async handler(input) {
        const filtered = input.category
          ? CANONICAL_EVENTS.filter((e) => e.category === input.category)
          : CANONICAL_EVENTS;

        let customerEvents: CustomerSchemaEnvelope["data"] = [];
        if (input.include_customer_events) {
          // Best-effort. If the project has no schemas yet, the endpoint
          // returns an empty list. If the call fails (network, role
          // gate), we still return the canonical list — the LLM gets
          // partial info rather than nothing.
          try {
            const res = await api.get<CustomerSchemaEnvelope>("/v1/events/schemas", {
              limit: 100,
            });
            customerEvents = res.data ?? [];
          } catch {
            customerEvents = [];
          }
        }

        const summary = [
          `${filtered.length} canonical events${input.category ? ` (category=${input.category})` : ""}.`,
          input.include_customer_events
            ? `${customerEvents.length} customer events registered in this project.`
            : "Customer events not requested.",
          "",
          "Naming rules: snake_case, past tense (course_viewed not view_course),",
          "no PascalCase (UserSignedUp), no spaces, no leading number. Property",
          "names follow the same convention.",
          "",
          "System events ($-prefixed) are SDK-auto-emitted — never call track()",
          "for these manually.",
        ].join("\n");

        // EventSchema rows are customer-controlled and reach the host
        // LLM via structuredContent. Strip dangerous code points from
        // every string field on every entry; the `properties` JSON blob
        // remains opaque (server validates the keys' regex, but values
        // could be anything — handled by the LLM as data).
        sanitizeUntrustedFields(customerEvents, CUSTOMER_EVENT_FIELDS);
        return {
          content: [{ type: "text", text: summary }],
          structuredContent: {
            canonical_events: filtered,
            customer_events: customerEvents,
            naming_rules: {
              regex: "^[a-z][a-z0-9_]{0,255}$",
              tense: "past",
              case: "snake_case",
              system_event_prefix: "$",
            },
          },
        };
      },
    }),
  ];
}
