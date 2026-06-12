#!/usr/bin/env node
/**
 * Sheepit MCP server — stdio transport.
 *
 * Surface (v1):
 *   - 2  Help / discovery tools (sheepit_help, sheepit_quickstart) —
 *     surface "what can I do?" inside the chat itself
 *   - 11 Campaign tools (list / get / create / update / preview /
 *     launch / pause / resume / complete / archive / results)
 *   - 7  Destination tools (catalog / list / get / create / update /
 *     delete / test)
 *   - 11 Dashboard tools (list / get / create / update / delete /
 *     template_list / template_get / widget_create / widget_update /
 *     widget_delete / insights_query) — Layer 4a
 *   - 3  Release-verdict tools (release_list / release_health /
 *     release_regressions) — pre-computed health verdicts + regression feed
 *   - 1  Feedback tool (feedback_submit) — pain-point capture in stream
 *
 * Auth: reads `~/.sheepit/credentials.json` populated by `sheepit login`.
 * No additional setup needed — same OAuth round-trip works for every
 * surface.
 *
 * Layer 4 follow-ups still queued:
 *   - Flag tools (list / create / kill / restore + per-rule edit)
 *   - Experiment tools
 *   - Funnel + retention insight kinds (currently timeseries only)
 *   - Campaign cohort_id forward-compat once Cohort lands
 *
 * Usage:
 *   npx @sheepit-ai/mcp serve     # default — stdio MCP server
 *   npx @sheepit-ai/mcp version
 */

import { stderr, exit, argv, platform as nodePlatform, version as nodeVersion } from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { resolveCredentials, MissingCredentialsError } from "./lib/credentials.js";
import { ApiError, createApiClient, recoveryHint } from "./lib/api-client.js";
import { VERSION } from "./generated/build-meta.js";
import { wrapUntrusted } from "./lib/untrust.js";
import { classifyError, trackTelemetry } from "./lib/track.js";
import { buildCampaignTools } from "./tools/campaigns.js";
import { buildDestinationTools } from "./tools/destinations.js";
import { buildDashboardTools } from "./tools/dashboards.js";
import { buildHelpTools } from "./tools/help.js";
import { buildFeedbackTools } from "./tools/feedback.js";
import { buildEventCatalogTools } from "./tools/event-catalog.js";
import { buildGroupTools } from "./tools/groups.js";
import { buildReleaseTools } from "./tools/releases.js";
import { runInstall } from "./install.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";

/** Threshold for the `dead` flag on `$mcp_session_ended`. A session that
 *  was open this long with zero tool calls is the failure mode the
 *  alert pipeline cares about. Single source of truth — the API-side
 *  scheduler re-asserts this in its candidate query. */
const DEAD_SESSION_MS = 60_000;

async function runServer(): Promise<void> {
  let creds;
  try {
    creds = await resolveCredentials();
  } catch (err) {
    if (err instanceof MissingCredentialsError) {
      stderr.write(`[sheepit-mcp] ${err.message}\n`);
      exit(2);
    }
    throw err;
  }

  const api = createApiClient(creds);
  const tools = [
    ...buildHelpTools(),
    ...buildEventCatalogTools({ api }),
    ...buildGroupTools({ api }),
    ...buildCampaignTools({ api }),
    ...buildDestinationTools({ api }),
    ...buildDashboardTools({ api }),
    ...buildReleaseTools({ api }),
    ...buildFeedbackTools({ api, mcpVersion: VERSION }),
  ];
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: "sheepit-mcp", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  // Session-scoped state. `sessionId` joins lifecycle events to the
  // tool-invocation events that fire inside the same session — so a
  // single dead session looks like one `$mcp_session_started` →
  // `$mcp_session_ended` pair with `tool_calls_count: 0`, no
  // `$mcp_tool_invoked` rows in between, on a shared sessionId.
  const sessionId = randomUUID();
  const sessionStartedAtMs = Date.now();
  let toolCallsCount = 0;
  let toolsListedCount = 0;
  let lifecycleEnded = false;

  // Hashed profile so the row is correlatable across this user's own
  // sessions without leaking their human-chosen profile label
  // ("my-project", "client-acme", etc.) into the customer's
  // events_raw — which they can read in their own dashboards. 8 hex
  // chars = 32 bits of entropy, enough to disambiguate within one
  // user's profile set without being reverse-able.
  const profileHash = createHash("sha256").update(creds.profileName).digest("hex").slice(0, 8);

  /** Properties common to every session-scoped emit. */
  const sessionProps = (): Record<string, unknown> => ({
    session_id: sessionId,
    profile_hash: profileHash,
    project_slug: creds.projectSlug ?? null,
    tool_count: tools.length,
    node_version: nodeVersion,
    platform: nodePlatform,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    toolsListedCount += 1;
    void trackTelemetry(api, {
      event: "$mcp_tools_listed",
      properties: {
        ...sessionProps(),
        // Per-call ordinal — distinguishes "first list (discovery)" from
        // "later refreshes". Most healthy sessions list exactly once.
        listed_count: toolsListedCount,
      },
      namespace: "mcp",
      version: VERSION,
    });
    return {
      tools: tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema, { target: "openApi3" }) as Record<
          string,
          unknown
        >,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const startedAt = Date.now();
    const toolName = req.params.name;
    toolCallsCount += 1;
    /** Fire-and-forget telemetry helper. Promises returned by
     *  `trackTelemetry` are intentionally not awaited so the user-facing
     *  response isn't blocked on our own ingest call. */
    const emit = (success: boolean, errorCode?: string): void => {
      void trackTelemetry(api, {
        event: "$mcp_tool_invoked",
        properties: {
          ...sessionProps(),
          tool_name: toolName,
          success,
          duration_ms: Date.now() - startedAt,
          ...(errorCode ? { error_code: errorCode } : {}),
        },
        namespace: "mcp",
        version: VERSION,
      });
    };

    const tool = toolMap.get(toolName);
    if (!tool) {
      emit(false, "unknown_tool");
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      } as never;
    }
    const parsed = tool.inputSchema.safeParse(req.params.arguments ?? {});
    if (!parsed.success) {
      emit(false, "invalid_arguments");
      // Zod issue messages can echo received literal values verbatim
      // (`Expected string, received "..."`). Wrap with sentinel
      // markers so a hostile input arg containing prompt-injection
      // text cannot escape into the host context.
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      return {
        content: [{ type: "text", text: `Invalid arguments: ${wrapUntrusted(msg, 1000)}` }],
        isError: true,
      } as never;
    }
    try {
      const result = await tool.handler(parsed.data);
      const isError = (result as { isError?: boolean }).isError === true;
      emit(!isError, isError ? "tool_returned_error" : undefined);
      // The SDK's stricter ServerResult union includes optional `task`
      // shapes we don't emit in v1; our `{content, structuredContent,
      // isError}` shape is wire-compatible with the basic CallToolResult.
      return result as never;
    } catch (err) {
      emit(false, classifyError(err));
      // API + Zod error messages routinely echo customer-controlled input
      // (duplicate-key responses, validation failures). Treat them as
      // untrusted at the boundary.
      if (err instanceof ApiError) {
        // Append a recovery hint per HTTP status + code so the LLM has a
        // next-action to suggest instead of merely re-narrating the
        // failure. Bare 4xx with no hint still works.
        const hint = recoveryHint(err.status, err.code);
        return {
          content: [
            {
              type: "text",
              text:
                `Sheepit API error (${err.status} ${err.code}): ` +
                wrapUntrusted(err.message, 1000) +
                (hint ? `\n\n${hint}` : ""),
            },
          ],
          isError: true,
        } as never;
      }
      return {
        content: [
          { type: "text", text: `Tool failure: ${wrapUntrusted((err as Error).message, 1000)}` },
        ],
        isError: true,
      } as never;
    }
  });

  /**
   * Best-effort emit of `$mcp_session_ended`. Called from every plausible
   * shutdown path (transport close, server close, SIGINT, SIGTERM,
   * uncaughtException) so we still get a row when the host kills the
   * process before the SDK cleanly tears the transport down.
   *
   * Returns the in-flight ingest promise so callers that need to block
   * for it (signal handlers) can race it against a deadline. Idempotent
   * via `lifecycleEnded`: subsequent calls return a resolved promise
   * without re-firing the post — the first emit's `reason` wins.
   */
  const emitSessionEnded = (reason: string): Promise<void> => {
    if (lifecycleEnded) return Promise.resolve();
    lifecycleEnded = true;
    return trackTelemetry(api, {
      event: "$mcp_session_ended",
      properties: {
        ...sessionProps(),
        duration_ms: Date.now() - sessionStartedAtMs,
        tool_calls_count: toolCallsCount,
        tools_listed_count: toolsListedCount,
        // `dead` is the headline boolean for the dead-session detector:
        // session was open >DEAD_SESSION_MS with zero tool calls.
        // Stamped at the source (not in the scheduler) so the row is
        // self-describing. NOTE: client-asserted, informational only —
        // the API-side dead-session alerter independently re-validates
        // duration_ms + tool_calls_count and doesn't trust this flag.
        dead: toolCallsCount === 0 && Date.now() - sessionStartedAtMs > DEAD_SESSION_MS,
        reason,
      },
      namespace: "mcp",
      version: VERSION,
    });
  };

  const transport = new StdioServerTransport();
  // Hook close BEFORE connect so an immediate-close transport (broken
  // pipe, host EOF on attach) still fires `_session_ended`. Both
  // handlers go through `emitSessionEnded`, which is idempotent.
  transport.onclose = () => {
    void emitSessionEnded("transport_closed");
  };
  server.onclose = () => {
    void emitSessionEnded("server_closed");
  };

  await server.connect(transport);
  // Emit started AFTER connect so a connect failure (rare for stdio,
  // but possible on a misconfigured host) doesn't write a phantom
  // session row that never gets paired with `_ended`.
  void trackTelemetry(api, {
    event: "$mcp_session_started",
    properties: sessionProps(),
    namespace: "mcp",
    version: VERSION,
  });

  // Process-exit fallbacks. Stdio MCP servers usually die from stdin
  // EOF (host disconnected) which fires `transport.onclose` reliably,
  // but a SIGTERM from a host that wraps us (Claude Desktop on quit)
  // doesn't always reach the transport before the process is torn
  // down. Race the telemetry post against a 2s deadline, then exit
  // with the POSIX-conventional `128 + signo` so wrappers + shells
  // see the right termination code. `lifecycleEnded` keeps this
  // safe to call multiple times.
  const exitOnSignal = async (sig: "SIGINT" | "SIGTERM"): Promise<void> => {
    const signo = sig === "SIGINT" ? 2 : 15;
    try {
      await Promise.race([
        emitSessionEnded(sig.toLowerCase()),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000).unref()),
      ]);
    } catch {
      // trackTelemetry already swallows; this catch is belt-and-braces
      // so a future change to it can't crash the shutdown path.
    }
    exit(128 + signo);
  };
  process.once("SIGINT", () => {
    void exitOnSignal("SIGINT");
  });
  process.once("SIGTERM", () => {
    void exitOnSignal("SIGTERM");
  });
  // Uncaught crash — let the host see a non-zero exit code (Node's
  // default for unhandled exceptions is 1) but emit `crashed` first
  // so we can distinguish "user gave up" from "process died".
  process.once("uncaughtException", (err: Error) => {
    void emitSessionEnded("uncaught_exception");
    stderr.write(`[sheepit-mcp] uncaught: ${err.message}\n`);
    setTimeout(() => exit(1), 2_000).unref();
  });
  process.once("unhandledRejection", (reason) => {
    void emitSessionEnded("unhandled_rejection");
    stderr.write(`[sheepit-mcp] unhandled rejection: ${String(reason)}\n`);
    setTimeout(() => exit(1), 2_000).unref();
  });

  stderr.write(
    `[sheepit-mcp] connected as ${creds.profileName}${creds.projectSlug ? ` (project: ${creds.projectSlug})` : ""} — ${tools.length} tools registered (session ${sessionId})\n`,
  );
}

function printVersion(): void {
  stderr.write(`sheepit-mcp ${VERSION}\n`);
}

function printHelp(): void {
  stderr.write(
    [
      "Sheepit MCP server",
      "",
      "Usage:",
      "  sheepit-mcp serve       Run the stdio MCP server (default)",
      "  sheepit-mcp install     Auto-write the MCP entry into your IDE config",
      "                          (Claude Desktop / Cursor / Codex). Dry-run by",
      "                          default; pass --yes to apply.",
      "  sheepit-mcp version     Print version",
      "  sheepit-mcp help        Print this help",
      "",
      "Setup:",
      "  1) sheepit login                # populates ~/.sheepit/credentials.json",
      "  2) sheepit-mcp install --yes    # writes the IDE config",
      "  3) Restart your IDE, then ask: 'what can I do with Sheepit?'",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const cmd = argv[2] ?? "serve";
  switch (cmd) {
    case "serve":
      await runServer();
      return;
    case "install":
      runInstall(argv.slice(3));
      return;
    case "version":
    case "--version":
    case "-v":
      printVersion();
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      stderr.write(`Unknown command: ${cmd}\n`);
      printHelp();
      exit(1);
  }
}

main().catch((err) => {
  stderr.write(`[sheepit-mcp] fatal: ${(err as Error).message}\n`);
  exit(1);
});
