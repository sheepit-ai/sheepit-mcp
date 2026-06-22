# `@sheepit-ai/mcp`

MCP (Model Context Protocol) server for Sheepit. Lets Claude / Cursor / any
MCP-compatible client drive your Sheepit project — campaigns, destinations,
flags, dashboards, insights queries — directly from a chat.

The same `~/.sheepit/credentials.json` file `sheepit login` writes
authenticates this server. One OAuth round-trip, both surfaces unlocked.

## 1.0.0 — npm scope rename + breaking install path

This release renames the package from `@goatech/mcp` to `@sheepit-ai/mcp`
as part of the broader Sheepit product rebrand. The legal entity
(GoaTech AI LLC) is unchanged; the npm scope is the customer-facing
brand.

**Breaking changes (hard cutover — no legacy fallback):**

- **Package name** — `@goatech/mcp` → `@sheepit-ai/mcp`. Update your
  IDE config + `npx` invocations.
- **Binary** — `goatech-mcp` → `sheepit-mcp`.
- **Credentials path** — `~/.goatech/credentials.json` →
  `~/.sheepit/credentials.json`. **No automatic migration** —
  `mv ~/.goatech/credentials.json ~/.sheepit/credentials.json` or
  re-run `sheepit login`.
- **Environment variables** — `GOATECH_API_KEY` / `GOATECH_PROFILE` /
  `GOATECH_API_URL` → `SHEEPIT_API_KEY` / `SHEEPIT_PROFILE` /
  `SHEEPIT_API_URL`. The old names are not honored as fallbacks.
- **LLM-facing tool names** — `goatech_help` / `goatech_quickstart` →
  `sheepit_help` / `sheepit_quickstart`. LLMs re-discover tool names
  from `tools/list` on every session start, so no client-side change is
  needed beyond restarting the IDE.
- **IDE config key** — `mcpServers.goatech` → `mcpServers.sheepit`.
  `sheepit-mcp install --yes` detects + migrates the old key
  automatically (no `--force` required); the existing config file is
  backed up to `<path>.bak.<unix-ms>.<pid>.<rand>` (mode 0600) before
  any write, the write itself is atomic via tmp+fsync+rename, and
  symlinks at the config path are refused.

**Migration aid (operator step, after `@sheepit-ai/mcp@1.0.0`
publishes):** the Sheepit team plans to also publish an exact-pin
alias at `@goatech/mcp@1.0.0` that depends on `@sheepit-ai/mcp@1.0.0`,
followed by `npm deprecate '@goatech/mcp@"<2.0.0"'`. Until that lands,
existing `npx @goatech/mcp` invocations resolve to the old
`@goatech/mcp@0.3.0` (different binary, different creds path) — so
update your IDE config first.

**What did NOT change:**

- API URL (`api.goatech.ai`) — flips with the AWS migration on its own
  cadence, not with this rename.
- API key prefix (`lp_pub_*` / `lp_sec_*`) — production data + customer
  `.env` files are scoped by it.
- Legal entity name (`GoaTech AI LLC`) — invoices / contracts / billing.

## Quick start (3 commands)

```bash
# 1. One-time OAuth login (PKCE — opens your browser)
npx @sheepit-ai/cli login

# 2. Auto-write the MCP entry into your IDE config.
#    Dry-run first; pass --yes to apply. Backs up the existing file.
npx @sheepit-ai/mcp install
npx @sheepit-ai/mcp install --yes

# 3. Restart your IDE. In Claude / Cursor, ask:
#    "what can I do with Sheepit?"
```

The first thing the LLM should call is `sheepit_help` — it returns a
curated overview of every surface and how to chain tools together.
For a concrete recipe, ask for `sheepit_quickstart` with one of:
`send_email_campaign`, `create_dashboard`, `analyze_signups`,
`ship_feedback`, `wire_webhook_destination`.

The CLI / MCP key the OAuth flow mints is stamped `source = "cli" | "mcp"`
on the Sheepit side, so you can audit which tool produced any given event.

## What the LLM can do

40 tools as of `1.0.0` (live build-time count is in
`src/generated/build-meta.ts`; this README counter is bumped per release):

- **2 Discovery tools** — `sheepit_help` (top-level "what is this?" or
  a per-topic deep-dive) and `sheepit_quickstart` (concrete N-step
  recipe for a goal). Call `sheepit_help` first when the user is new.
- **1 Event-catalog tool** — `event_catalog_canonical`. Returns the
  events Sheepit understands out of the box (plus the project's own
  registered `EventSchema` rows) so the LLM knows which `event` names
  are valid before building an `insights_query`.
- **4 Group tools** — `group_list / create / add_member /
remove_member`. Manage user groups (named cohorts) that audiences
  and targeting rules reference.
- **11 Campaign tools** — `campaign_list / get / create / update /
preview / launch / pause / resume / complete / archive / results`.
  Preview/launch is enforced via single-use snapshot tokens — the LLM
  physically cannot launch a campaign without first running
  `campaign_preview`.
- **7 Destination tools** — `destination_catalog / list / get /
create / update / delete / test`. Connectors live behind a typed
  catalog so the LLM can't request a destination that isn't actually
  wired (`webhook`, `resend`, …).
- **11 Dashboard tools** — `dashboard_list / get / create / update /
delete / template_list / template_get / widget_create /
widget_update / widget_delete / insights_query`. `insights_query`
  lets the LLM run arbitrary timeseries against `events_raw` so it
  can answer "did signups dip yesterday?" without opening a UI.
- **3 Release tools** — `release_list / release_health /
release_regressions`. Surface the server's pre-computed release
  health verdicts (healthy / degraded / critical) + the regression
  feed so the LLM can narrate "is the latest release safe?" without
  recomputing any math.
- **1 Feedback tool** — `feedback_submit`. The LLM should call this
  proactively when the user expresses frustration ("this is
  confusing") or hits an obvious gap. Auto-stamps `source=mcp` +
  version metadata so the Sheepit team's admin queue can filter
  MCP-origin reports.

Breakdown total: 2 + 1 + 4 + 11 + 7 + 11 + 3 + 1 = **40**.

## Telemetry & opt-out

The server emits coarse, **non-PII** usage events (`$mcp_session_started`,
`$mcp_tools_listed`, `$mcp_tool_invoked`, `$mcp_session_ended`) to your
own project so the Sheepit team — and you, in your dashboards — can see
how the MCP is used and where it fails. Events carry the tool name,
success/failure, duration, and a coarse error code only. **Never** your
tool arguments, query bodies, or any customer data.

To turn it off, set either of these in the environment the MCP server
runs in (your IDE's `mcpServers.sheepit.env`, or your shell):

```bash
DO_NOT_TRACK=1          # the cross-vendor consoledonottrack.com convention
SHEEPIT_TELEMETRY=0     # Sheepit-specific switch (also accepts =false)
```

When either is set, `track()` short-circuits to a no-op — no event
leaves the process for any session or tool call. Telemetry already
never throws and never blocks your tool calls; the opt-out just stops
the emit entirely.

## On-demand tool loading (experimental, opt-in)

By default the server advertises all tools, so their schemas load into your
agent's context every session. Set `SHEEPIT_MCP_LAZY_TOOLS=1` to advertise only
a small **core** set plus two discovery tools (`search_tools`, `load_tool`); the
rest stay callable but load their schemas on demand — ~65% less upfront tool-schema
context. When you need a tool that isn't listed, the agent calls `search_tools` to
find it and `load_tool` to fetch its schema, then calls it by name.

```bash
SHEEPIT_MCP_LAZY_TOOLS=1   # advertise core + discovery tools only (default: off)
```

This is **off by default** while we measure both modes (the
`$mcp_tools_listed` event now carries `lazy`, `advertised_count`, and
`schema_bytes`).

## CLI

```bash
sheepit-mcp serve              # default — runs the stdio MCP server
sheepit-mcp install            # dry-run: show what would change
sheepit-mcp install --yes      # apply: writes IDE config + .bak.<ms>.<pid>.<rand>
sheepit-mcp install --force    # overwrite an existing sheepit entry
sheepit-mcp install --client=claude-desktop|cursor|codex
sheepit-mcp version
sheepit-mcp help
```

`serve` reads `~/.sheepit/credentials.json`; falls back to
`SHEEPIT_API_KEY` / `SHEEPIT_PROFILE` env vars if the file isn't present.

`install` is idempotent (re-running with the same MCP entry already
present is a no-op) and conservative (it backs up existing configs to
`<path>.bak.<unix-ms>.<pid>.<rand>` mode 0600 before writing,
writes atomically via tmp+rename, and refuses to follow symlinks). It supports Claude Desktop,
Cursor, and Codex out of the box. When upgrading from a pre-1.0
`@goatech/mcp` install, the old `mcpServers.goatech` entry is replaced
in-place with the new `mcpServers.sheepit` entry on `--yes`.

## Versioning

This package follows Sheepit product releases. Major-version bumps
signal either the MCP protocol moving, or a breaking change to the API
surface the tools wrap (or, as in `1.0.0`, an npm-scope rename).
Schemas are validated with Zod at request time so an out-of-date client
gets a structured error rather than silent drift.

## License

MIT. Copyright (c) 2026 GoaTech AI LLC. See `LICENSE`.
