/**
 * English content for `sheepit_help` and `sheepit_quickstart`.
 *
 * **File-budget exemption:** this is a pure i18n data file — no logic,
 * no imports beyond types. The 800-LOC cap in CLAUDE.md applies to code
 * complexity; data fixtures (the spirit of the "Generated files +
 * shared-type aggregators are exempt" clause) shouldn't pay the same
 * tax. Sister file: `help-content-es.ts`. Tool wiring + the language
 * arg lives in the slim `help.ts`.
 *
 * Stable contract:
 *   - `HELP_TOPICS` is the canonical topic enum. `help-content-es.ts`
 *     MUST cover every key — drift is caught at type-check time via
 *     the `Record<(typeof HELP_TOPICS)[number], string>` index.
 *   - `QUICKSTART_RECIPES` is the canonical recipe enum. Same drift
 *     guarantee for `help-content-es.ts`.
 *   - Translations may localize prose freely but MUST keep tool names,
 *     code fences, endpoint paths, env vars, and identifier strings
 *     byte-identical to the English source — those are addressable
 *     contracts, not human prose.
 */

import { TOOL_COUNT } from "../generated/build-meta.js";

export const HELP_TOPICS = [
  "overview",
  "campaigns",
  "destinations",
  "dashboards",
  "insights",
  "feedback",
  "credentials",
  // Integration-coach topics — teach the LLM how to instrument the
  // customer's app correctly, not just how to drive the platform.
  "sdk_integration",
  "event_conventions",
  "flag_patterns",
  "debugging_with_sheepit",
] as const;

export const QUICKSTART_RECIPES = [
  "send_email_campaign",
  "create_dashboard",
  "analyze_signups",
  "ship_feedback",
  "wire_webhook_destination",
  // Integration recipes — concrete N-step recipes for adding Sheepit
  // capabilities to the customer's codebase.
  "instrument_signup_funnel",
  "add_first_flag",
  "wire_release_health",
  "diagnose_a_regression",
] as const;

export const HELP_BODY_EN: Record<(typeof HELP_TOPICS)[number], string> = {
  overview: `# Sheepit MCP — what you can do

You are connected to a Sheepit project as an authenticated user. From this conversation
you can:

  • **Run growth campaigns end-to-end** — define an audience + creative + channel,
    preview the plan, launch it. Email through Resend works today.
  • **Manage destinations** — wire up the channels campaigns ship through (webhook,
    Resend; Meta CAPI / Google Ads queued).
  • **Compose analytics dashboards** — create dashboards, add widgets, run ad-hoc
    timeseries queries against \`events_raw\`.
  • **Capture pain points** — when something is awkward or broken, call
    \`feedback_submit\` so the Sheepit team sees it without you context-switching.

${TOOL_COUNT} tools are registered:
  - 11 campaign_*       (list / get / create / update / preview / launch /
                         pause / resume / complete / archive / results)
  - 7  destination_*    (catalog / list / get / create / update / delete / test)
  - 11 dashboard / widget / insights tools (list / get / create / update / delete /
                         template_list / template_get / widget_create / widget_update /
                         widget_delete / insights_query)

Common workflows have ready recipes — call \`sheepit_quickstart\` with one of:
  send_email_campaign, create_dashboard, analyze_signups, ship_feedback,
  wire_webhook_destination.

For a deep dive into one area, call \`sheepit_help\` with a topic:
  campaigns, destinations, dashboards, insights, feedback, credentials.`,

  campaigns: `# Campaigns

A **campaign** is a single primitive that bundles audience + channels + creative +
(optional) experiment + success_metric + budget + schedule. One object instead of
stitching cohorts + flags + experiments + destinations across separate APIs.

## State machine

  draft → scheduled → running → paused ⇄ running → completed → archived

Mutations are only allowed in **draft** or **paused**. Status transitions use the
dedicated \`campaign_pause\` / \`campaign_resume\` / \`campaign_complete\` /
\`campaign_archive\` tools — don't try to PATCH \`status\`.

## Preview/launch discipline (anti-hallucination)

\`campaign_launch\` REQUIRES a fresh \`preview_token\` from \`campaign_preview\`.
You physically cannot launch without first previewing the plan with the user. The
token is single-use and snapshot-bound — if any field on the campaign changes
between preview and launch, the token is invalidated and you must re-preview.

## Audience grammar

Audience is a list of \`{field, op, values}\` AND'd together. Profile-only matching
over \`email / role / country / preferred_language / internal / billing_exempt /
created_at\`. Operators: \`eq | neq | in | not_in | gt | gte | lt | lte | contains\`.
\`regex\` is intentionally rejected (catastrophic-backtracking footgun).

Example: signed-up-in-last-7-days US users:
  [{ field: "country", op: "in", values: ["US"] },
   { field: "created_at", op: "gte", values: ["2026-04-22T00:00:00Z"] }]

## Channels

Each channel is \`{kind, config?, destination_config_id?}\`. Discriminated union on
\`kind\`. v1 ships email (Resend) + webhook end-to-end; meta / google / tiktok /
linkedin slots are reserved.

## End-to-end flow

  campaign_create  →  campaign_preview  →  campaign_launch
                                       ↳  (preview_token consumed)`,

  destinations: `# Destinations

A **destination** is a per-(project, environment) install of a connector. Campaigns
deliver through them.

## Always start with destination_catalog

Lists the connector_ids that are actually wired in this build. The LLM can't
hallucinate \`"hubspot"\` or \`"sendgrid"\` — only the catalog's ids are accepted.

Live in v1: \`webhook\`, \`resend\`. Queued: meta-capi, google-ads, tiktok-events,
linkedin-conversions, customerio, onesignal.

## Resend (transactional email)

Config: \`{ from: "Display <addr@domain>", reply_to?, audience_scan_limit? }\`
The actual API key is read server-side from \`RESEND_API_KEY\`; you do NOT pass it
through the destination config.

Audience resolves via \`audience-resolver\` — bounded scan (default 1000) over
\`User\`, profile-only filters, returns \`truncated: true\` if the cap was hit.

## Webhook (universal escape hatch)

Config: \`{ url: "https://...", signing_secret?, timeout_ms? }\`
HTTPS-only. Optional HMAC-SHA256 signing via \`signing_secret\`. Sends one POST
per launch with the full \`CampaignDispatchPayload\`. 4xx → permanent failure;
5xx + network → retryable.

## Test before launch

\`destination_test\` validates the connection (Resend: GET /domains; webhook: cheap
HEAD or sample POST). Run it after \`destination_create\` so a typo'd \`from\`
address doesn't surface only on first \`campaign_launch\`.`,

  dashboards: `# Dashboards + widgets + insights

Multi-tenant analytics — same shape as PostHog / Mixpanel / Amplitude. A
**dashboard** is project-scoped + holds N widgets. A **widget** has a Zod-validated
query (kind: \`timeseries\` in v1) + a viz spec (line / bar / area / single_metric).

## Templates

Don't start from scratch. \`dashboard_template_list\` enumerates the seed
blueprints (DAU & Engagement / Acquisition / Friction / Errors & Health / Soft
Launch Funnel). \`dashboard_template_get\` returns the full widget specs so you can
cherry-pick or materialize the whole template.

## Critical correctness rule (locked)

DAU = \`count_distinct anonymous_id\` of \`$session_start\`, NOT \`user_id\`.
Anonymous content readers (marketing, catalog, learning preview) must count.
The smart-naming heuristic distinguishes:
  count_distinct anonymous_id  → "Daily Active Users"
  count_distinct user_id       → "Daily Active Signed-In Users"

## Ad-hoc analytics: insights_query

The LLM power tool. Runs an arbitrary timeseries query against \`events_raw\` so
you can answer "did signups dip yesterday?" / "errors-per-hour by app version?"
without opening a UI. JSON-base allowlist is \`event_properties\` and
\`event_context\` — both addressable at any depth ≤5
(e.g. \`event_context.attribution.utm_source\`).`,

  insights: `# Insights queries

\`insights_query\` runs ad-hoc analytics. v1 supports \`query.kind: "timeseries"\`.

## Wire envelope (matches \`insightsQueryRequestSchema\`)

\`\`\`json
{
  "environment_id": "00000000-0000-0000-0000-000000000020",
  "query": {
    "kind": "timeseries",
    "event": "signup_completed",
    "interval": "day",
    "range": { "kind": "relative", "last": "30d" },
    "filters": [
      { "field": "event_properties.country", "op": "eq", "value": "US" }
    ],
    "breakdownProperty": "event_properties.utm_source",
    "aggregation": { "kind": "count" }
  }
}
\`\`\`

Field reference:

- \`environment_id\` (optional) — defaults to the API key's environment.
- \`query.kind\` — always \`"timeseries"\` in v1.
- \`query.event\` — event name from \`event_catalog_canonical\`.
- \`query.interval\` — \`"minute" | "hour" | "day" | "week"\`.
- \`query.range\` — either \`{kind: "relative", last: "24h"|"7d"|"30d"|...}\` or
  \`{kind: "absolute", from: iso, to: iso}\`.
- \`query.filters\` (optional) — array of \`{field, op, value}\`. Field is a
  dot-path under \`event_properties\` / \`event_context\` (depth capped at 5).
  \`regex\` op rejected for DoS reasons.
- \`query.breakdownProperty\` (optional) — single property path that splits
  the response into per-value series. Caps at 20 distinct values; the
  remainder collapses into "(other)".
- \`query.aggregation\` (optional, default \`{kind: "count"}\`) — either
  \`{kind: "count"}\` or \`{kind: "count_distinct", field: "user_id"}\`.

## Common workflows

  • "Did signups dip yesterday?" → event=signup_completed, count, interval=day,
                                    range=last 7d
  • "Errors per hour by app version" → event=$error, count, interval=hour,
                                        breakdownProperty=event_context.app.version,
                                        range=last 7d
  • "Daily active anonymous users" → event=$session_start,
                                      aggregation=count_distinct anonymous_id,
                                      interval=day, range=last 30d
  • "Where do US users land?" → event=$pageview,
                                 filters=[{event_properties.country, eq, "US"}],
                                 breakdownProperty=event_context.attribution.landing_page

Returns gap-filled buckets — a missing time bucket renders as 0.`,

  feedback: `# Feedback capture (in-conversation)

When something feels awkward, broken, or surprising, call \`feedback_submit\`.
The Sheepit team sees it in the admin Feedback tab without the user leaving the
chat. **The friction barrier between "this is annoying" and "report submitted"
is one tool call.**

## Three feedback types

  bug      — something is broken (incorrect result, error, crash)
  feature  — an obvious missing capability ("I wish I could…")
  general  — anything else: UX rough edges, doc gaps, slow tools, confusing names

## Auto-stamped metadata

The MCP tool stamps \`metadata.source = "mcp"\` plus client version + Node version
+ platform automatically — you don't pass these. The user only provides the
narrative.

## When you (the LLM) should proactively call this

  • The user said something like "this is confusing" / "it would be nice if…"
    → ask "want me to file that as feedback?" then call feedback_submit on yes.
  • A tool returned a confusing error → after surfacing it to the user, offer to
    file feedback so the team can fix the error message.
  • You hit an obvious gap (a connector_id the user wanted but isn't in the
    catalog yet) → file as a feature request after confirming with the user.`,

  sdk_integration: `# SDK integration playbook

Sheepit ships SDKs for every major surface. Pick the one that matches the
customer's stack:

  @sheepit-ai/sdk-js     Browser-side. Vanilla JS, Vue, Svelte, plain HTML.
  @sheepit-ai/react      React + Next.js. Hooks: useFlag, useExperiment,
                       useTrack. <Provider> at the app root.
  @sheepit-ai/server     Server-side Node. Express / Fastify / Next.js
                       Server Actions / cron jobs. Has a Next.js
                       sub-export (\`@sheepit-ai/server/nextjs\`).
  GoaTechSDK (Swift)  iOS / iPadOS / macOS. SPM. Crash + perf modules.

## Where to call init()

  Web (Next.js App Router):
    Create app/providers.tsx with "use client":
      'use client';
      import { GoaTechProvider } from '@sheepit-ai/react';
      export function Providers({ children }) {
        return (
          <GoaTechProvider
            publishableKey={process.env.NEXT_PUBLIC_GOATECH_KEY!}
            appVersion={process.env.NEXT_PUBLIC_APP_VERSION}
          >{children}</GoaTechProvider>
        );
      }
    Then wrap the body in app/layout.tsx with <Providers>.

  Web (vanilla / Vite / SPA):
    Top of main.ts:
      import { Sheepit } from '@sheepit-ai/sdk-js';
      export const client = await Sheepit.create({
        publishableKey: import.meta.env.VITE_GOATECH_KEY,
        appVersion: import.meta.env.VITE_APP_VERSION,
      });

  Server (Node, Fastify / Express / etc.):
    Top of server bootstrap, BEFORE routes:
      import { GoaTechServer } from '@sheepit-ai/server';
      export const sheepit = await GoaTechServer.init({
        secretKey: process.env.GOATECH_SECRET_KEY!,  // lp_sec_*
      });
    Use \`secretKey\` (lp_sec_*), NEVER the publishable key on the server.
    The publishable key is for client bundles only.

  iOS:
    AppContext.swift singleton:
      let sheepit = await GoaTechSDK.shared.start(
        publishableKey: "lp_pub_...",
        appVersion: Bundle.main.version
      )

## Critical: appVersion

Every SDK accepts an \`appVersion\` config. This MUST be a stable build
identifier (Vercel commit sha for web, semver for mobile, "vX.Y.Z" for
Node). It powers cross-release regression detection. If you skip it,
release_id is null and the Errors-by-version + crash-free templates
report nothing.

  Web (Next.js):     bake VERCEL_GIT_COMMIT_SHA into NEXT_PUBLIC_APP_VERSION
                      via next.config.ts
  Web (Vite):        same idea, into VITE_APP_VERSION
  Server:            \`process.env.npm_package_version\` is fine for v1
  iOS:               Bundle.main.shortVersionString

## Key types

Three key types — pick the right one for the surface:
  publishable (lp_pub_*)  client-side. Browsers + mobile bundles.
                          Cannot read flag definitions / admin endpoints.
                          SAFE to embed in public bundles.
  secret      (lp_sec_*)  server-side. Full project access.
                          Embed in server env vars only.
  dev         (lp_dev_*)  developer / CI. Read-only schemas + definitions.
                          Use for codegen + CI lint, not runtime.

When integrating, mint two keys: a publishable for the client + a secret
for the server.`,

  event_conventions: `# Event naming + property conventions

Sheepit is opinionated. Following these rules means the customer's events
land in pre-built dashboards, funnels, and templates without manual rework.
Breaking the rules works (events are accepted) but they're invisible to
default views.

## Event names

  ✓  snake_case          course_viewed, signup_completed, payment_succeeded
  ✓  past tense          course_viewed (NOT view_course)
  ✓  noun_verb shape     course_viewed (NOT viewed_course)
  ✗  PascalCase          UserSignedUp        — rejected by the regex
  ✗  spaces / dashes     "user signed up"    — rejected
  ✗  leading number      2fa_enabled         — rejected
  ✗  present tense       view_course         — accepted but won't match templates

Regex: \`^\\$?[a-z][a-z0-9_]{0,255}$\`. The optional \`$\` prefix is
RESERVED for system events emitted automatically by the SDK
($session_start, $pageview, $error, etc.). Customers must NOT use it.

## Property names

Same shape: snake_case, no spaces. Stable across calls — \`user_id\` (not
\`userId\`/\`UserId\`/\`user-id\`). PII goes in properties; the SDK never
strips it for you.

## Use canonical names when they exist

Before writing \`track("UserSignedUp")\`, call event_catalog_canonical.
Sheepit ships ~20 canonical event names that pre-built funnel /
acquisition / DAU templates already query. Using the canonical name means
the customer's signup template just-works, no widget rebuild required.

## What NOT to put in properties

  ✗ Raw search queries           leak PII / private content
  ✗ User passwords / tokens      obvious
  ✗ Full HTML / DOM blobs        bloat events_raw
  ✗ Stack traces > 8KB           truncate first
  ✗ Innertext from rage_click    auto-system fields are fine; you
                                  shouldn't add more

Instead: hash, length-only, or category. \`search_performed\` ships
\`query_length: 12, result_count: 4\` not \`query: "credit card details"\`.

## When to track client-side vs server-side

  Client-side       page navigation, button clicks, in-app feature use,
                    UI errors, attribution capture. The SDK auto-attaches
                    session/device/UA context for free.
  Server-side       payment events (webhooks), auth events (after JWT
                    issued), enrollment events (after DB write), admin
                    actions. Use @sheepit-ai/server.

Don't double-track. \`payment_succeeded\` belongs server-side (the webhook
is authoritative); a client-side counterpart will diverge from the
provider's truth and skew revenue dashboards.

## Idempotency for server events

Server-side track calls have at-least-once delivery. Use a stable
\`request_id\` property derived from the upstream event id (Stripe event
id, Resend message id) so dashboards can dedupe.`,

  flag_patterns: `# Flag + experiment patterns

Sheepit unifies feature flags, rollouts, and experiments under a single
"Flag" primitive. Evaluation order: kill-switch → rules → rollout →
default. Per-user variant assignments are deterministic.

## Read flags at the BOUNDARY, not deep in render

  React (good):
    const showNew = useFlag('new_pricing_v2', false);
    if (showNew) return <NewPricingPage />;
    return <OldPricingPage />;

  React (bad):
    function PriceLabel() {
      const flag = useFlag('round_prices', false);  // re-evaluates every render
      ...
    }

Read at the layout / page boundary; pass results down as props. Each
\`useFlag\` call is cheap (memoized) but readability suffers when flags
proliferate inside components.

## Default values matter

  ✓  useFlag('show_dashboard_link', false)    explicit safe default
  ✗  useFlag('show_dashboard_link')           no fallback if SDK hasn't loaded

The default fires when:
  • SDK hasn't initialized yet (first paint of an SSR'd page)
  • Network is offline / SDK never loaded
  • Flag doesn't exist in the dashboard (typo)

Pick a default that means "behavior the user has today" — usually
\`false\` for new features, \`true\` for kill-switches.

## Naming flags

  snake_case, present tense:
    show_dashboard_link, enable_new_checkout, kill_legacy_payments
  prefix with \`enable_\` or \`show_\` for boolean toggles
  prefix with \`kill_\` for kill-switches

Avoid version numbers in the name (\`pricing_v2\` becomes stale once
\`pricing_v3\` ships). Prefer date-bound experiments (\`pricing_october\`)
or feature-bound names (\`pricing_with_seats\`).

## Codegen: type-safe flag constants

Run \`pnpm sheepit codegen:flags\` (or \`npx @sheepit-ai/cli codegen\`).
Generates:
  - TypeScript:  \`generated/flags.ts\` exports \`Flags\` enum
  - Swift:       \`Generated/Flags.swift\`

Then:
    import { Flags } from './generated/flags';
    const enabled = useFlag(Flags.ShowNewPricing, false);

A typo'd flag key won't compile. Re-run codegen any time you create or
rename a flag in the dashboard.

## Experiments

Same primitive, different evaluation. Variants assigned deterministically
by user_id (or anonymous_id pre-login). Use \`useExperiment\`:

    const { variant, payload } = useExperiment('hero_h1_copy_v1');
    return <h1>{payload?.headline ?? 'Default headline'}</h1>;

Variant assignments are stable for the lifetime of the experiment per
user, even if you toggle the flag.

## Killing a flag in incident response

\`sheepit flags kill <key> --reason="<incident detail>"\` flips the
kill-switch. Evaluation skips rules + rollout + default and returns the
kill-switch value (usually \`false\`). Audit-logged with the reason.

\`sheepit flags restore <key>\` undoes it.`,

  debugging_with_sheepit: `# Debugging with Sheepit

Sheepit instruments your app — that means Sheepit is also your post-hoc
debugger when something goes wrong in prod. Three primary tools:

## insights_query — ad-hoc analytics

The LLM power tool. Any timeseries / breakdown the user asks for.
"Did signups dip yesterday?" / "Errors per hour by version?" /
"Where do US users land?".

  Tool:  insights_query
  Power: filter on event_properties.* + event_context.* (depth ≤ 5)
  Limits: timeseries kind only in v1; funnel + retention queued

## ChangeEvent timeline — what shipped before things broke

Every flag / rule / rollout / experiment / release / campaign mutation
writes a \`ChangeEvent\` row. \`GET /v1/changes\` (cursor paginated) +
\`/v1/changes/:id\`. Filter by entity_type / entity_id / time range.

Use case: a regression appeared at 14:32; pull \`/v1/changes\` for the
hour before that to see exactly which flag flip / rollout step / release
deploy correlates. Often instant root-cause.

## Audit log — who did what

\`/v1/admin/audit/events\` (admin-gated) shows every authenticated mutation.
Filter by actor / action / resource_type. Use this when the change
wasn't a release deploy but a config change made by a teammate or admin.

## Releases + health

\`Release\` rows are auto-created from GitHub push webhooks (when the
GitHub integration is wired) and stamped from \`appVersion\` on every
event ingest. Each Release accrues:
  - crash-free rate
  - error rate
  - p50 / p99 latency
  - rolling 30-min health snapshots (every 5 min)

\`/v1/releases/:id/health\` returns the latest snapshot. The Errors &
Health template visualizes this per-release.

## Auto-pause + change regression

If a rolling-out release goes critical with ≥50 sessions, the
snapshotter auto-pauses the rollout and writes \`$release_regression\` /
\`$change_regression\` to events_raw. Watch for those event names in
insights_query — they're early-warning system, not normal operations.

## $error events — uncaught failures

\`@sheepit-ai/sdk-js\` BrowserErrorCapture installs window.onerror +
unhandledrejection. \`@sheepit-ai/server\` does the same for Node. Every
crash / uncaught fires \`$error\` with stack + url + version. Query
recently:

    insights_query {
      kind: "timeseries", event: "$error",
      breakdown_property: "event_properties.message",
      time_window: { kind: "relative", days: 1 },
      granularity: "hour"
    }

If a single error message dominates, that's the regression.`,

  credentials: `# Credentials

The MCP server reads \`~/.sheepit/credentials.json\`, populated by:

  sheepit login

That's a PKCE-OAuth flow against \`api.goatech.ai\` — same flow Vercel / Neon /
Stripe / GitHub use. The same credentials file feeds the CLI AND the MCP server,
so one OAuth round-trip authenticates both surfaces.

## Per-call profile selection

\`credentials.json\` can hold N named profiles. Set \`SHEEPIT_PROFILE=<name>\`
(env var) before launching the MCP to pick one. Default profile is the most
recently used.

## Key source stamping

The OAuth flow mints \`lp_sec_*\` keys stamped \`source = "mcp"\` on the Sheepit
side, so any side effect (campaign launched, destination created, widget written)
is auditable to the MCP origin via \`api_keys.source\` + the AuditLog table.

## Replacing creds

If the user's keys leak: \`sheepit login --force\` redoes the flow + revokes the
old key.`,
};

export const QUICKSTART_BODY_EN: Record<(typeof QUICKSTART_RECIPES)[number], string> = {
  send_email_campaign: `# Recipe: send an email campaign

## Prereqs

  1. \`destination_catalog\` — confirm "resend" is in the list
  2. \`destination_list\` — see if a Resend destination already exists in this project

## If no Resend destination exists

  3. \`destination_create\`:
     {
       connector_id: "resend",
       name: "default",
       config: { from: "Sheepit <noreply@goatech.ai>" }
     }
  4. \`destination_test\` — verify the from-domain is verified at Resend

## Build the campaign

  5. \`campaign_create\`:
     {
       name: "<short name>",
       audience: [
         { field: "country", op: "in", values: ["US"] }
         // add filters; profile-only fields
       ],
       channels: [{ kind: "resend" }],
       creative: [{
         payload: {
           subject: "<subject line>",
           html:    "<html body>",
           text:    "<plain-text body>"   // recommended
         }
       }],
       success_metric: { kind: "event", event: "course_enrolled" }   // optional
     }
  6. \`campaign_preview\` — surface the plan + audience size to the user.
     The user MUST confirm before launch. The response includes a
     \`preview_token\` you'll need next.
  7. \`campaign_launch\`: { id, preview_token }

## After launch

  8. The response carries \`dispatch: {attempted, succeeded, failed, ...}\` —
     surface that to the user so they know how many recipients were attempted.
  9. \`campaign_results\` returns post-hoc metrics once events arrive.`,

  create_dashboard: `# Recipe: create a dashboard from a template

## Discover

  1. \`dashboard_template_list\` — surface the available blueprints to the user
  2. \`dashboard_template_get\` { id: "<picked>" } — get the widget specs

## Materialize

  3. \`dashboard_create\`: { name: "<custom>", description: "..." }
  4. For each widget in the template:
     \`widget_create\`: { dashboard_id, query, viz_type, layout }

## Customize

  5. \`widget_update\` to change the query / viz / breakdown
  6. \`widget_delete\` to drop ones that aren't relevant

## From scratch

  Skip 1+2; start at \`dashboard_create\` and add widgets via \`insights_query\`
  to validate the query first, then \`widget_create\` to persist it.`,

  analyze_signups: `# Recipe: investigate a signup dip

## Surface the dip

  1. \`insights_query\`:
     {
       kind: "timeseries", event: "signup_completed",
       measure: { type: "count" },
       time_window: { kind: "relative", days: 30 },
       granularity: "day"
     }
  2. Read the daily counts back to the user. Identify the drop date.

## Break down by source

  3. \`insights_query\` again with breakdown_property:
     "event_context.attribution.utm_source"  → did one source dry up?
     "event_context.attribution.landing_page" → did a campaign change?
     "event_properties.signup_method"        → did Google OAuth break?

## Cross-reference with errors

  4. \`insights_query\`:
     { kind: "timeseries", event: "$error", measure: { type: "count" },
       breakdown_property: "event_properties.message",
       time_window: { kind: "relative", days: 7 }, granularity: "hour" }
     If a route started 500'ing the day signups dipped, that's the cause.

## Cross-reference with releases

  5. Compare the dip-start timestamp with the latest \`Release\` row's
     \`createdAt\` — if a deploy happened within an hour of the dip, look at
     the diff.

## Persist the answer

  6. If the dip is real, \`feedback_submit\` { type: "bug", message: "<what you found>" }
     so the team is paged.`,

  ship_feedback: `# Recipe: capture pain points inline

  1. \`feedback_submit\`:
     {
       type: "bug" | "feature" | "general",
       message: "<the user's words; quote them when possible>"
     }

The MCP auto-stamps \`metadata.source = "mcp"\` + version info. Returns
\`{ id, created_at }\` on success.

When to call without being asked:
  • User says "this is confusing" / "I expected X but got Y"
  • A tool error message is unhelpful
  • The user had to ask you a question that ANY future user will also ask

When NOT to call:
  • User asked a question and got an answer — that's a happy path
  • The friction is upstream of Sheepit (npm / network / their config)`,

  instrument_signup_funnel: `# Recipe: instrument the signup funnel

Goal: every signup is tracked end-to-end so the Acquisition + DAU + Funnel
templates light up automatically.

## Step 1 — confirm canonical names

  event_catalog_canonical { category: "auth" }

You'll get \`signup_completed\`, \`login_succeeded\`, \`login_failed\`. Use
those exact names — pre-built templates query them.

## Step 2 — client-side: track form submission

  Web (React):
    import { useTrack } from '@sheepit-ai/react';
    function SignupForm() {
      const track = useTrack();
      const onSubmit = async (values) => {
        track('signup_submitted', { method: 'email' });
        try {
          await api.signup(values);
          // success handled server-side (next step)
        } catch (err) {
          track('signup_failed', { reason: err.code });
        }
      };
    }

\`signup_submitted\` is a custom event (not canonical) — it's the
intent-to-signup signal, not the success signal. Include it for funnel
diagnostics; the canonical \`signup_completed\` is server-emit only.

## Step 3 — server-side: track success after DB write

  Node (Fastify / Express):
    import { sheepit } from '../lib/sheepit';
    app.post('/auth/signup', async (req, reply) => {
      const user = await db.user.create({ ... });
      // CRITICAL: track AFTER the DB write, not before
      await sheepit.track({
        userId: user.id,
        event: 'signup_completed',
        properties: { method: 'email', plan: req.body.plan },
      });
      return reply.code(201).send({ user });
    });

The user_id binding here is what lets per-user dashboards / cohorts work
later. If you only emit client-side, anonymous_id is the only id and
re-binding to user_id later is awkward.

## Step 4 — verify

  insights_query {
    kind: "timeseries", event: "signup_completed",
    measure: { type: "count" },
    time_window: { kind: "relative", days: 1 },
    granularity: "hour"
  }

You should see counts within ~30s of a real signup. If not, check the
network tab in dev tools — \`/v1/ingest\` should return 200, not 4xx.

## Step 5 — connect the template

\`dashboard_template_get { id: "acquisition" }\` returns a pre-built
dashboard that watches \`signup_completed\` + UTM breakdowns. Materialize
with \`dashboard_create\` + bulk \`widget_create\`.`,

  add_first_flag: `# Recipe: add the customer's first feature flag

Goal: customer can ship a feature dark + flip it on for a cohort without
a deploy.

## Step 1 — install the SDK (skip if done)

  Web (Next.js):  npm i @sheepit-ai/react @sheepit-ai/sdk-js
  Mount the GoaTechProvider at the app root with the publishable key.
  See \`sheepit_help { topic: "sdk_integration" }\` for the snippet.

## Step 2 — pick a flag name

Convention: snake_case, present tense, action-oriented.
  ✓ show_new_pricing, enable_dark_mode, kill_legacy_checkout
  ✗ NewPricing, pricingV2

## Step 3 — read the flag in code

  React:
    import { useFlag } from '@sheepit-ai/react';
    function PricingPage() {
      const showNew = useFlag('show_new_pricing', false);
      return showNew ? <NewPricing /> : <OldPricing />;
    }

The \`false\` default is what users see if the SDK hasn't initialized or
the flag doesn't exist yet — pick a default that means "what they see
today".

## Step 4 — register the flag in Sheepit

Open https://www.goatech.ai/app/flags → New Flag. Match the key exactly.
Default value \`false\`. Status: \`active\`. (Customers running the CLI
can use \`sheepit flags create show_new_pricing --default=false\` once
the create command lands; today create is dashboard-only.)

## Step 5 — turn it on for a cohort

In the dashboard's flag detail:
  - Add a Rule: \`country eq US\` → value \`true\`. 100% of US users see it.
  - Or add a Rollout: 5% → 25% → 100% over a week. Deterministic per
    user_id, so the same user stays in their bucket as you ramp.

## Step 6 — codegen for type-safety

  npx @sheepit-ai/cli codegen

Generates \`src/generated/flags.ts\` with a \`Flags\` enum. Swap to:

    const showNew = useFlag(Flags.ShowNewPricing, false);

A typo now fails compile, not silent fallback to the default.

## Step 7 — observe

  insights_query {
    kind: "timeseries", event: "$pageview",
    filters: [{ field: "event_properties.path", op: "eq", values: ["/pricing"] }],
    breakdown_property: "event_context.flags.show_new_pricing",
    time_window: { kind: "relative", days: 7 },
    granularity: "day"
  }

Splits pricing-page views by who saw the new vs old variant. Useful for
spotting "did the new pricing tank conversion?".`,

  wire_release_health: `# Recipe: wire release health

Goal: every deploy creates a Release row in Sheepit, accrues crash-free /
error / latency rollups, and auto-pauses if it goes critical.

## Step 1 — bake appVersion into the SDK

  Web (Next.js, next.config.ts):
    env: { NEXT_PUBLIC_APP_VERSION: process.env.VERCEL_GIT_COMMIT_SHA }
  Then:
    <GoaTechProvider appVersion={process.env.NEXT_PUBLIC_APP_VERSION}>

  Server (Node):
    import pkg from './package.json' with { type: 'json' };
    GoaTechServer.init({ appVersion: pkg.version, ... });

  iOS:
    GoaTechSDK.shared.start(appVersion: Bundle.main.shortVersionString!, ...)

Without appVersion every event has \`release_id = null\` — release-health
is silent.

## Step 2 — install the GitHub integration (web stack)

Open /app/settings/integrations → Link a GitHub repo. Generates a
webhook secret you paste into the GitHub repo's webhook config (or use
\`sheepit integrations github link <owner>/<repo>\` from the CLI).

After this, every push to the default branch auto-creates a \`Release\`
row tagged with the commit sha. iOS / native — auto-creation isn't
available; create Releases manually via dashboard or CI.

## Step 3 — verify

  insights_query {
    kind: "timeseries", event: "$pageview",
    breakdown_property: "event_context.app.version",
    time_window: { kind: "relative", days: 1 },
    granularity: "hour"
  }

You should see traffic split by the recent commit shas. The legend
shows \`abc1234 · 2h ago\` (release_resolver enriches with relative
time) once the GH webhook has fired.

## Step 4 — start a rollout

In /app/releases for the new release: choose Rolling out → set initial
percentage (e.g. 5%). The release auto-advances on a schedule, OR
auto-pauses if crash-free drops > 2pp vs. the prior release with ≥50
sessions in the window.

## Step 5 — observe

  insights_query {
    kind: "timeseries", event: "$error",
    breakdown_property: "event_context.app.version",
    time_window: { kind: "relative", days: 1 },
    granularity: "hour"
  }

If the new release has a higher \`$error\` count than the prior one,
\`$change_regression\` will fire and the dashboard's Errors & Health
template flags it. Roll back via the release's Decision panel or
\`POST /v1/admin/ops/releases/:id/decide\` (CLI: queued).`,

  diagnose_a_regression: `# Recipe: diagnose a regression in prod

Goal: a user reports something broke; figure out when + why + what to
roll back.

## Step 1 — get the timestamp + symptom

Ask the user when they hit the issue + what they were doing. "Around 2pm"
is enough — change-windows are minutes wide, not seconds.

## Step 2 — check ChangeEvents for the hour before

  curl -H "Authorization: Bearer $SHEEPIT_API_KEY" \\
       "https://api.goatech.ai/v1/changes?to=2026-04-29T14:30:00Z&from=2026-04-29T13:00:00Z"

Returns every flag / rule / rollout / experiment / release / campaign
mutation in the window. 80% of the time the regression name is in the
list (a flag that flipped, a rollout that advanced, a release that
deployed). Each row has \`actorSource\` (jwt / api_key / cli / scheduler /
webhook) so you know if a teammate or an automated process did it.

## Step 3 — query $error in the same window

  insights_query {
    kind: "timeseries", event: "$error",
    breakdown_property: "event_properties.message",
    filters: [{ field: "timestamp", op: "gte", values: ["2026-04-29T13:00:00Z"] }],
    time_window: { kind: "relative", hours: 2 },
    granularity: "minute"
  }

If a single message dominates, that's likely the regression. Stack +
URL come back as additional properties.

## Step 4 — break down by version + cohort

  insights_query {
    kind: "timeseries", event: "$error",
    breakdown_property: "event_context.app.version",
    time_window: { kind: "relative", hours: 2 },
    granularity: "minute"
  }

If only the latest release has errors, the deploy is the cause. Pause
or roll back the rollout (Step 6).

  insights_query {
    kind: "timeseries", event: "$error",
    breakdown_property: "event_context.flags.<suspect_flag>",
    time_window: { kind: "relative", hours: 2 },
    granularity: "minute"
  }

If errors only appear when the flag is on, the flag is the cause.
Kill it with \`sheepit flags kill <key> --reason=<one-liner>\`.

## Step 5 — confirm fix landed

After the rollback / kill, re-run the Step 3 query for the next 15 min.
Error rate should fall to baseline. If not, you fixed the wrong thing —
go back to Step 2.

## Step 6 — write up the fix

\`feedback_submit { type: "bug", message: "<root cause + remediation>" }\`
so the team has a record. Then in code, write a regression test +
ship a follow-up commit per the bug-fix observability rule (server
telemetry + structured event + test).`,

  wire_webhook_destination: `# Recipe: wire a webhook destination

For the customer who wants to forward campaign launches to their own pipeline.

  1. \`destination_create\`:
     {
       connector_id: "webhook",
       name: "ops-pipeline",
       config: {
         url: "https://example.com/sheepit/campaigns",   // HTTPS-only
         signing_secret: "<shared secret>",              // optional but recommended
         timeout_ms: 10000                                // 1000-30000
       }
     }
  2. \`destination_test\` — sends a sample POST + checks 2xx
  3. The campaign that uses this destination should reference it via
     \`channels: [{ kind: "webhook", destination_config_id: "<from step 1>" }]\`

## What the customer's endpoint receives

\`\`\`
POST <url>
content-type: application/json
x-sheepit-event-id: campaign:<id>:launch
x-sheepit-signature-256: sha256=<hmac>     (when signing_secret set)

{
  campaign: { id, name, ... },
  audience: { count, sample, truncated },
  creative: [...],
  success_metric, budget, schedule,
  project: { id, slug },
  environment: { id, name }
}
\`\`\`

The receiver verifies HMAC with the \`signing_secret\` it gave us. They should
treat \`x-sheepit-event-id\` as the idempotency key — we may retry on 5xx.`,
};
