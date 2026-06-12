# Security model — `@sheepit-ai/mcp`

This document states the trust boundary the MCP server operates within.
It is the single source of truth for "what does the MCP enforce vs. what
does the backend enforce?" — read it before assuming a guarantee.

## The API key IS the tenant boundary

The MCP server is a **thin client**. It holds one credential — the API
key (or OAuth-minted token) in `~/.sheepit/credentials.json` — and sends
it as `Authorization: Bearer` on every request to `api.goatech.ai`. That
key is scoped to exactly one project/environment on the Sheepit side.

**Everything that matters for isolation is enforced by the backend, not
by this client:**

- **Tenant isolation.** Which project/environment/organization a request
  can read or write is decided server-side from the authenticated key.
  The MCP cannot reach another tenant's data even if a tool were asked to
  — the backend scopes every query by the key's tenant. Do not rely on,
  or add, any client-side "tenant check"; it would be security theatre.
- **Webhook-URL SSRF protection.** `destination_create` / `destination_test`
  accept a webhook URL, but the actual outbound fetch (and its SSRF
  guards — private-IP / metadata-endpoint / redirect restrictions) runs
  on the backend adapter, not in this process. The MCP only forwards the
  URL; it does not itself fetch arbitrary user-supplied URLs.
- **Event-quota enforcement.** Per-project ingest quotas and the
  preview daily caps are enforced server-side (`429` /
  `402 PREVIEW_LIMIT_EXCEEDED`). The MCP's own telemetry counts against
  the same quota and is also gated server-side — there is no client-side
  bypass.

If you find a way to cross any of these boundaries **from the client**,
that's a backend bug to report, not an MCP one — but please report it
(see below).

## What this client IS responsible for

Two things, both about the LLM channel rather than tenant isolation:

1. **Tool-poisoning containment.** Customer- and receiver-controlled
   strings (campaign / destination / dashboard / widget names, release
   versions, UTM values, webhook `test` response `message`/`code`,
   `insights_query` series names) round-trip through the LLM's context.
   A crafted value could try to hijack the agent. The MCP wraps such
   values in sentinel markers on the text channel (`wrapUntrusted`) and
   strips dangerous code points on the `structuredContent` channel
   (`sanitizeUntrustedFields`). See `src/lib/untrust.ts`.
2. **Error-message containment.** API + Zod error messages can echo
   customer-controlled input verbatim. The central handler in
   `src/index.ts` wraps those with the same sentinels before they reach
   the host.

These are **defense-in-depth for the prompt-injection surface**, not
tenant isolation. They reduce the blast radius of a malicious string; the
authoritative isolation guarantee is still the backend's.

## Credentials & telemetry

- Credentials live in `~/.sheepit/credentials.json` (written by
  `sheepit login`) or `SHEEPIT_API_KEY`. Never commit them.
- Telemetry is coarse and non-PII (tool name, success, duration, error
  code only) and can be disabled with `DO_NOT_TRACK=1` or
  `SHEEPIT_TELEMETRY=0`. See README → "Telemetry & opt-out".

## Reporting a vulnerability

File via `feedback_submit` (type `bug`) or email the Sheepit team. Please
do not open a public GitHub issue for a security report.
