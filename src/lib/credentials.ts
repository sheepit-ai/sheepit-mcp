/**
 * Read Sheepit credentials from `~/.sheepit/credentials.json` — the
 * same file populated by `sheepit login` (see packages/cli). Sharing
 * the file means both surfaces (CLI + MCP) authenticate via a single
 * PKCE round-trip and stay in sync.
 *
 * Resolution order (highest → lowest):
 *   1. SHEEPIT_API_KEY env var (one-shot, no profile required)
 *   2. SHEEPIT_PROFILE env var (named profile from credentials.json)
 *   3. credentials.json `current` profile
 *
 * Throws a typed error with installation guidance when no credential
 * source is available — the MCP server's startup banner echoes this
 * message so Claude / Cursor users see "run sheepit login first."
 *
 * Note (rename wave): hard cutover from `~/.goatech/` + `GOATECH_*`.
 * No legacy fallback — configure `~/.sheepit/credentials.json` or
 * the `SHEEPIT_*` env vars instead.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ResolvedCredential {
  apiKey: string;
  apiUrl: string;
  profileName: string;
  projectSlug?: string;
}

interface Credentials {
  current: string;
  profiles: Record<string, { apiKey: string; apiUrl: string; projectSlug?: string }>;
}

// AWS-migration gate: the `api.goatech.ai` → `api.sheepit.ai` flip is
// owned by the DNS+TLS migration, not by this package rename. Keep
// the API URL on the existing host until that lands.
const DEFAULT_API_URL = "https://api.goatech.ai";

export class MissingCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCredentialsError";
  }
}

export async function resolveCredentials(): Promise<ResolvedCredential> {
  // Env var fast path.
  const envKey = process.env["SHEEPIT_API_KEY"];
  if (envKey) {
    return {
      apiKey: envKey,
      apiUrl: process.env["SHEEPIT_API_URL"] ?? DEFAULT_API_URL,
      profileName: "env",
    };
  }

  const path = join(homedir(), ".sheepit", "credentials.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new MissingCredentialsError(
        `No Sheepit credentials at ${path}. Run \`sheepit login\` (or \`npx @sheepit-ai/cli login\`) to set up — it opens a browser and saves the profile here.`,
      );
    }
    throw err;
  }

  let creds: Credentials;
  try {
    creds = JSON.parse(raw) as Credentials;
  } catch {
    throw new MissingCredentialsError(
      `Couldn't parse ${path}. Re-run \`sheepit login\` to recreate it.`,
    );
  }

  const requested = process.env["SHEEPIT_PROFILE"] ?? creds.current;
  const profile = creds.profiles[requested];
  if (!profile) {
    const available = Object.keys(creds.profiles).join(", ") || "(none)";
    throw new MissingCredentialsError(
      `Profile "${requested}" not found in ${path}. Available: ${available}. Run \`sheepit login\` to add a profile.`,
    );
  }

  return {
    apiKey: profile.apiKey,
    apiUrl: profile.apiUrl,
    profileName: requested,
    projectSlug: profile.projectSlug,
  };
}
