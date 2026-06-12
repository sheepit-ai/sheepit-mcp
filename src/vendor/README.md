# `src/vendor/` — vendored Sheepit API-contract schemas

These files are **vendored copies** of the Zod request-schemas that the
Sheepit API publishes as its public contract. They were previously imported
from an internal workspace package; they are copied here so this package
builds standalone with zero private dependencies.

Nothing in this directory is secret — every schema here describes the shape
of a request body the public Sheepit API already accepts and documents. The
vendored set is intentionally minimal: only the schemas the MCP tools
actually send, plus their transitive Zod dependencies.

## Files

| File | Contract |
|---|---|
| `rule-conditions.ts` | `RuleCondition[]` predicate shape (audiences, filters) |
| `insights-query.ts` | the Insights Query DSL (timeseries) + widget viz/position |
| `campaign-schemas.ts` | campaign create / update / launch / list |
| `destination-schemas.ts` | destination create / update / test / list |
| `user-group-schemas.ts` | user-group create / list |
| `dashboard-schemas.ts` | dashboard + widget CRUD + insights-query request |
| `dashboard-templates.ts` | starter-dashboard blueprints |
| `index.ts` | thin barrel — re-exports exactly what the tools import |

## Keeping in sync

If the Sheepit API tightens or extends one of these request schemas, mirror
the change here. The server is always the source of truth — these copies are
a build-time convenience, not an independent contract. A mismatch surfaces as
a `400 VALIDATION_ERROR` from the API, which is the safe failure mode (the
server re-validates every request regardless of what this client sends).
