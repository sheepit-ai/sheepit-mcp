<!-- Logo: drop a centered wordmark/logo image here once the public mirror has an assets/ dir. -->
<div align="center">

# @sheepit-ai/mcp

_Let Claude, Cursor, and Codex drive your Sheepit project from the IDE._

[![npm version](https://img.shields.io/npm/v/@sheepit-ai/mcp)](https://www.npmjs.com/package/@sheepit-ai/mcp)
[![CI](https://github.com/sheepit-ai/sheepit-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/sheepit-ai/sheepit-mcp/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@sheepit-ai/mcp)](./LICENSE)

</div>

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives
your AI coding assistant direct control of your Sheepit project — campaigns,
flags, experiments, dashboards, releases, and insights queries — without
leaving the editor.

## Why it exists

Sheepit holds your flags, experiments, growth campaigns, and product
analytics. Acting on any of it normally means switching to the dashboard,
clicking through forms, and copying values back to your code. This server
removes that round-trip: the assistant already in your IDE reads and writes
Sheepit for you. One `sheepit login` authenticates both the CLI and this MCP
server, so there is no second key to manage and every action the assistant
takes is auditable.

## Example

After installing (below), restart your IDE and ask your assistant in plain
language:

> **You:** Launch the "Fall Promo" email campaign, but show me a preview first.

The assistant calls `campaign_preview`, shows you the rendered subject and
body plus the audience size, and waits. The preview returns a single-use
token; `campaign_launch` requires that token, so the assistant physically
cannot send a campaign you have not seen.

> **You:** Did signups dip yesterday?

The assistant calls `insights_query` against your event stream and answers
with the number, no dashboard needed.

> **You:** Roll out the `new-checkout` flag to 10% of users.

The assistant calls `flag_get` to read the current state, then `flag_update`
to set the rollout.

## How it works

1. `sheepit login` runs a PKCE OAuth flow in your browser and writes
   `~/.sheepit/credentials.json`.
2. `sheepit-mcp install` writes an MCP server entry into your IDE's config
   file (backing up the existing file first).
3. You restart your IDE. It launches `sheepit-mcp serve` over stdio.
4. The server reads `~/.sheepit/credentials.json` (or `SHEEPIT_API_KEY` from
   the environment) and authenticates to the Sheepit API.
5. The assistant calls `tools/list` and discovers every available tool. New
   sessions should call `sheepit_help` first for an overview.
6. When you ask for something, the assistant calls the matching tool. Every
   input is validated with Zod at request time, so an out-of-date client gets
   a structured error instead of silent drift.

## Install

Three commands. The first two are real, published packages
(`@sheepit-ai/cli`, `@sheepit-ai/mcp`).

```bash
# 1. One-time OAuth login (opens your browser)
npx @sheepit-ai/cli login

# 2. Write the MCP entry into your IDE config.
#    The first command is a dry run; the second applies it.
npx @sheepit-ai/mcp install
npx @sheepit-ai/mcp install --yes

# 3. Restart your IDE, then ask: "what can I do with Sheepit?"
```

`install` auto-detects your client. To target one explicitly:

```bash
npx @sheepit-ai/mcp install --yes --client=claude-desktop   # Claude Desktop
npx @sheepit-ai/mcp install --yes --client=cursor           # Cursor
npx @sheepit-ai/mcp install --yes --client=codex            # Codex
```

`install` is idempotent (re-running with the entry already present is a
no-op), backs up the existing config to `<path>.bak.<unix-ms>.<pid>.<rand>`
(mode 0600) before writing, writes atomically via tmp+rename, and refuses to
follow symlinks. Upgrading from a pre-1.0 `@goatech/mcp` install replaces the
old `mcpServers.goatech` entry with `mcpServers.sheepit` in place.

### CLI reference

```bash
sheepit-mcp serve                              # default — stdio MCP server
sheepit-mcp install                            # dry run: show what would change
sheepit-mcp install --yes                      # apply
sheepit-mcp install --force                    # overwrite an existing entry
sheepit-mcp install --client=claude-desktop    # (or cursor | codex)
sheepit-mcp version
sheepit-mcp help
```

## Tools

49 tools across 10 surfaces. The count is generated from the source at build
time (`src/generated/build-meta.ts`), so it does not drift from the registry.

| Surface       | Count | Tools                                                                                                                                                                 |
| ------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery     | 2     | `sheepit_help`, `sheepit_quickstart`                                                                                                                                  |
| Event catalog | 1     | `event_catalog_canonical`                                                                                                                                             |
| Groups        | 4     | `group_list`, `group_create`, `group_add_member`, `group_remove_member`                                                                                               |
| Campaigns     | 11    | `campaign_list` / `get` / `create` / `update` / `preview` / `launch` / `pause` / `resume` / `complete` / `archive` / `results`                                        |
| Destinations  | 7     | `destination_catalog` / `list` / `get` / `create` / `update` / `delete` / `test`                                                                                      |
| Dashboards    | 12    | `dashboard_list` / `get` / `create` / `update` / `delete` / `template_list` / `template_get` / `materialize`, `widget_create` / `update` / `delete`, `insights_query` |
| Experiments   | 4     | `experiment_list`, `experiment_get`, `experiment_create`, `experiment_update`                                                                                         |
| Flags         | 4     | `flag_list`, `flag_get`, `flag_create`, `flag_update`                                                                                                                 |
| Releases      | 3     | `release_list`, `release_health`, `release_regressions`                                                                                                               |
| Feedback      | 1     | `feedback_submit`                                                                                                                                                     |

Start with `sheepit_help` for a guided overview, or `sheepit_quickstart` with
one of `send_email_campaign`, `create_dashboard`, `analyze_signups`,
`ship_feedback`, `wire_webhook_destination` for a concrete step-by-step
recipe.

Two extra meta-tools (`search_tools`, `load_tool`) appear only in on-demand
loading mode (below) and are excluded from the count.

## On-demand tool loading (experimental, opt-in)

By default the server advertises all tools, so their schemas load into your
assistant's context every session. Set `SHEEPIT_MCP_LAZY_TOOLS=1` to advertise
only a small core set plus two discovery tools (`search_tools`, `load_tool`);
the rest stay callable but load their schemas on demand, which cuts upfront
tool-schema context substantially. When the assistant needs a tool that is not
listed, it calls `search_tools` to find it and `load_tool` to fetch its
schema, then calls it by name.

```bash
SHEEPIT_MCP_LAZY_TOOLS=1   # advertise core + discovery tools only (default: off)
```

This is off by default while both modes are measured (the
`$mcp_tools_listed` event carries `lazy`, `advertised_count`, and
`schema_bytes`).

## Telemetry and opt-out

The server emits coarse, non-PII usage events (`$mcp_session_started`,
`$mcp_tools_listed`, `$mcp_tool_invoked`, `$mcp_session_ended`) to your own
project so you can see how the MCP is used and where it fails. Events carry the
tool name, success or failure, duration, and a coarse error code only. They
never carry your tool arguments, query bodies, or any customer data.

To turn telemetry off, set either of these in the environment the server runs
in (your IDE's `mcpServers.sheepit.env`, or your shell):

```bash
DO_NOT_TRACK=1          # the cross-vendor consoledonottrack.com convention
SHEEPIT_TELEMETRY=0     # Sheepit-specific switch (also accepts =false)
```

When either is set, the emit short-circuits to a no-op. Telemetry already never
throws and never blocks your tool calls; the opt-out stops the emit entirely.

## FAQ

**Is this published?** Yes. `@sheepit-ai/mcp` is on npm (latest `1.0.1`,
MIT-licensed). The `npx` commands above resolve against the real package.

**Which clients are supported?** Claude Desktop, Cursor, and Codex out of the
box. The server speaks standard MCP over stdio, so any MCP-compatible client
can run `sheepit-mcp serve` with a manual config entry.

**Do I need a Sheepit account?** Yes. `sheepit login` authenticates against
your Sheepit project. The same credentials file powers both the CLI and this
server.

**Does it send my data anywhere?** Only coarse, non-PII usage events to your
own project, and you can turn those off (see Telemetry and opt-out). Tool
arguments and query results are never included.

**I'm on `@goatech/mcp`. How do I upgrade?** See
[Upgrading from `@goatech/mcp`](#upgrading-from-goatechmcp) below.

**Where's the source?** [github.com/sheepit-ai/sheepit-mcp](https://github.com/sheepit-ai/sheepit-mcp).

## Upgrading from `@goatech/mcp`

`1.0.0` renamed the package from `@goatech/mcp` to `@sheepit-ai/mcp` as part of
the Sheepit product rebrand. The legal entity (GoaTech AI LLC) is unchanged;
the npm scope is the customer-facing brand. This is a hard cutover with no
legacy fallback:

| Was                                                           | Now                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| Package `@goatech/mcp`                                        | `@sheepit-ai/mcp`                                         |
| Binary `goatech-mcp`                                          | `sheepit-mcp`                                             |
| Credentials `~/.goatech/credentials.json`                     | `~/.sheepit/credentials.json`                             |
| Env `GOATECH_API_KEY` / `GOATECH_PROFILE` / `GOATECH_API_URL` | `SHEEPIT_API_KEY` / `SHEEPIT_PROFILE` / `SHEEPIT_API_URL` |
| Tools `goatech_help` / `goatech_quickstart`                   | `sheepit_help` / `sheepit_quickstart`                     |
| Config key `mcpServers.goatech`                               | `mcpServers.sheepit`                                      |

To migrate:

1. Update your IDE config + any `npx` invocations to `@sheepit-ai/mcp`. Running
   `sheepit-mcp install --yes` detects and migrates the old `mcpServers.goatech`
   key automatically.
2. Move your credentials: `mv ~/.goatech/credentials.json
~/.sheepit/credentials.json`, or just re-run `sheepit login`.
3. Rename any `GOATECH_*` env vars to `SHEEPIT_*`. The old names are not honored
   as fallbacks.

Restarting your IDE re-discovers the new tool names from `tools/list`, so no
further client change is needed.

What did **not** change: the API URL (`api.goatech.ai`), the API key prefix
(`lp_pub_*` / `lp_sec_*`, which scopes production data and customer `.env`
files), and the legal entity name (`GoaTech AI LLC`, used on invoices and
contracts).

## Versioning

This package follows Sheepit product releases. A major-version bump signals
either the MCP protocol moving or a breaking change to the API surface the
tools wrap (as in `1.0.0`, an npm-scope rename). Tool inputs are validated with
Zod at request time, so an out-of-date client gets a structured error rather
than silent drift.

## License

MIT. Copyright (c) 2026 GoaTech AI LLC. See [LICENSE](./LICENSE).
