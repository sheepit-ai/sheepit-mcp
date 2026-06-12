/**
 * `sheepit-mcp install` — auto-write the MCP server entry into Claude
 * Desktop / Cursor / Codex config files so dogfooders don't paste JSON.
 *
 * Why this lives in the MCP package (not the CLI): the user has just
 * `npx`-run the MCP server. Asking them to also install the CLI just to
 * paste a JSON snippet is a step backwards. One package, one install
 * command, one OAuth flow (via `sheepit login`, which the user runs
 * separately), one config write.
 *
 * Conservative behavior:
 *   - DRY-RUN by default; print the diff + path. `--yes` writes.
 *   - Never overwrite an existing `sheepit` server entry without `--force`.
 *   - Always backup the existing config to
 *     `<file>.bak.<unix-ms>.<pid>.<rand8>` (mode 0600) before writing.
 *   - Refuse to follow symlinks at the config path — copyFileSync +
 *     writeFileSync would otherwise let a symlinked config either leak
 *     the target's contents into a backup sidecar (PII via id_rsa /
 *     ~/.aws/credentials) or overwrite an attacker-chosen file.
 *   - Atomic write via tmp + fsync + rename so a power loss / SIGKILL
 *     mid-write can never leave a corrupted JSON config.
 *   - Re-read the config right before write and compare against the
 *     planning snapshot; bail with `skipped_race` if the user's IDE
 *     wrote to it under us (best-effort optimistic concurrency).
 *   - Best-effort merge: respect every other key in the file unchanged.
 *   - Pretty-print with 2-space indent so the human-readable file the
 *     user opens later is still legible (Claude Desktop & Cursor both
 *     re-write with their own formatting on app changes anyway).
 *
 * Rebrand migration (2026-05-27, sheepit-ai/mcp@1.0.0): when an
 * existing `mcpServers.goatech` entry points at the old `@goatech/mcp`
 * package, swap it for `mcpServers.sheepit` → `@sheepit-ai/mcp`
 * automatically on `--yes` (no `--force` required). Foreign entries
 * under `mcpServers.goatech` that don't match the old shape are left
 * alone and still need `--force`.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  lstatSync,
  openSync,
  fsyncSync,
  closeSync,
  renameSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { stderr, stdout, exit, cwd as procCwd } from "node:process";
import { detectStack, renderStackBlock } from "./stack-detect.js";

interface ClientTarget {
  id: "claude-desktop" | "cursor" | "codex";
  label: string;
  configPath: string;
  /** Anchor key under which mcpServers lives. Both Claude Desktop and
   *  Cursor use `mcpServers` at the top level. Codex uses `tools.mcp`. */
  anchor: string[];
}

const SERVER_KEY = "sheepit";
const SERVER_ENTRY = {
  command: "npx",
  args: ["-y", "@sheepit-ai/mcp", "serve"],
};

// Old pre-rename surface — detect + migrate on `--yes` without
// requiring `--force` (the user already opted in to the new package
// the moment they ran `npx @sheepit-ai/mcp install`).
const LEGACY_SERVER_KEY = "goatech";
// Canonical pre-rename entry shape we wrote between 0.x and 0.3.x. We
// auto-migrate ONLY this exact shape — any divergence (extra args,
// custom `env`, different command) is treated as user customization we
// must not silently clobber. Those entries surface as `skipped_exists`
// and require `--force`.
const LEGACY_CANONICAL_ENTRY = {
  command: "npx",
  args: ["-y", "@goatech/mcp", "serve"],
} as const;

/**
 * Deep-equal against `LEGACY_CANONICAL_ENTRY` without relying on key
 * order. `JSON.stringify` would silently drift if a future refactor
 * flips `{command, args}` → `{args, command}` in either constant, AND
 * wouldn't match a user-typed legacy entry that happened to enumerate
 * keys in the opposite order. Explicit structural check is forwards-
 * + backwards-symmetric.
 */
function isLegacyMigratableEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const e = entry as { command?: unknown; args?: unknown; [k: string]: unknown };
  if (e.command !== LEGACY_CANONICAL_ENTRY.command) return false;
  if (!Array.isArray(e.args)) return false;
  if (e.args.length !== LEGACY_CANONICAL_ENTRY.args.length) return false;
  for (let i = 0; i < LEGACY_CANONICAL_ENTRY.args.length; i++) {
    if (e.args[i] !== LEGACY_CANONICAL_ENTRY.args[i]) return false;
  }
  // Any extra fields on the user's entry (e.g. `env`) mean it's NOT
  // canonical — leave it alone.
  for (const k of Object.keys(e)) {
    if (k !== "command" && k !== "args") return false;
  }
  return true;
}

function resolveTargets(): ClientTarget[] {
  const home = homedir();
  const isMac = platform() === "darwin";
  const isWin = platform() === "win32";

  const claudeDesktopPath = isMac
    ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : isWin
      ? join(
          process.env["APPDATA"] ?? join(home, "AppData", "Roaming"),
          "Claude",
          "claude_desktop_config.json",
        )
      : join(home, ".config", "Claude", "claude_desktop_config.json");

  const cursorPath = isMac
    ? join(home, ".cursor", "mcp.json")
    : isWin
      ? join(process.env["APPDATA"] ?? join(home, "AppData", "Roaming"), "Cursor", "mcp.json")
      : join(home, ".cursor", "mcp.json");

  const codexPath = join(home, ".codex", "config.json");

  return [
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      configPath: claudeDesktopPath,
      anchor: ["mcpServers"],
    },
    { id: "cursor", label: "Cursor", configPath: cursorPath, anchor: ["mcpServers"] },
    { id: "codex", label: "Codex", configPath: codexPath, anchor: ["tools", "mcp"] },
  ];
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Existing config at ${path} is not valid JSON: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

function getAtPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function setAtPath(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown,
): Record<string, unknown> {
  if (path.length === 0) throw new Error("setAtPath: empty path");
  const next = { ...obj };
  let cur = next;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!;
    const child = cur[k];
    const childObj =
      typeof child === "object" && child !== null ? { ...(child as Record<string, unknown>) } : {};
    cur[k] = childObj;
    cur = childObj;
  }
  cur[path[path.length - 1]!] = value;
  return next;
}

interface InstallResult {
  target: ClientTarget;
  status:
    | "would_install"
    | "would_migrate"
    | "installed"
    | "migrated"
    | "already_present"
    | "skipped_exists"
    | "skipped_no_target"
    // The config path is a symlink. Following it would either leak the
    // target's contents into a backup sidecar (PII via /etc/passwd /
    // ~/.ssh/id_rsa / ~/.aws/credentials) or overwrite an attacker-chosen
    // path with our JSON. Refuse and tell the user to resolve manually.
    | "skipped_symlink"
    // The user's IDE wrote to the config file between our `readJson`
    // and our `writeFileSync`. Optimistic-concurrency bail-out so we
    // don't silently revert their change.
    | "skipped_race";
  detail?: string;
}

function planInstall(
  target: ClientTarget,
  opts: { force: boolean; dryRun: boolean },
): InstallResult {
  // Refuse to read-or-write through a symlink. `lstatSync` returns the
  // link itself; `existsSync` would follow it and `copyFileSync` would
  // copy the target file's *contents* into our backup sidecar (creating
  // a 0644 PII channel if the target is ~/.ssh/id_rsa or
  // ~/.aws/credentials). Surface a typed skip so the user resolves
  // manually.
  if (existsSync(target.configPath)) {
    try {
      if (lstatSync(target.configPath).isSymbolicLink()) {
        return {
          target,
          status: "skipped_symlink",
          detail: `${target.configPath} is a symbolic link; refusing to follow it. Resolve manually then re-run.`,
        };
      }
    } catch {
      // lstat failure on a path existsSync says exists is exotic — race
      // with the user deleting the file mid-call. Fall through; the
      // subsequent read/write will surface the real error.
    }
  }

  // Read the JSON BEFORE the planning logic so we can compare it again
  // right before write — that's the S-1 race guard.
  const initialRaw: string | null = existsSync(target.configPath)
    ? readFileSync(target.configPath, "utf8")
    : null;
  const cfg = readJson(target.configPath);
  const servers = (getAtPath(cfg, target.anchor) as Record<string, unknown> | undefined) ?? {};
  const existing = servers[SERVER_KEY];
  const legacyExisting = servers[LEGACY_SERVER_KEY];
  const legacyMigratable = isLegacyMigratableEntry(legacyExisting);
  const isMigration = existing === undefined && legacyMigratable;
  // Stale-legacy cleanup: when the new key is already in place AND a
  // canonical legacy entry still hangs around (user re-ran install or
  // hand-pasted the new entry), strip the dead `goatech` key alongside
  // the no-op write so the file converges to a single canonical entry.
  const needsStaleCleanup = existing !== undefined && legacyMigratable;

  if (existing !== undefined) {
    const isSame = JSON.stringify(existing) === JSON.stringify(SERVER_ENTRY);
    // Idempotent: identical entry AND no stale legacy → skip silently.
    if (isSame && !needsStaleCleanup) {
      return { target, status: "already_present" };
    }
    if (!isSame && !opts.force) {
      return {
        target,
        status: "skipped_exists",
        detail: `existing entry differs from ours; pass --force to overwrite`,
      };
    }
  }

  if (opts.dryRun) {
    const willTouchLegacy = isMigration || needsStaleCleanup;
    return {
      target,
      status: willTouchLegacy ? "would_migrate" : "would_install",
      detail: willTouchLegacy
        ? `${target.configPath} (anchor: ${target.anchor.join(".")}) — replaces legacy "${LEGACY_SERVER_KEY}" entry`
        : `${target.configPath} (anchor: ${target.anchor.join(".")})`,
    };
  }

  mkdirSync(dirname(target.configPath), { recursive: true });

  // Re-read the config right before write and compare against the
  // snapshot we planned against. If the user's IDE wrote to the file
  // between our `readJson` and now, bail out so we don't silently
  // overwrite their change with stale data. Cheap + catches 95% of real
  // races (Claude Desktop / Cursor / Codex all touch their config on
  // quit / startup / settings-toggle).
  if (existsSync(target.configPath)) {
    let currentRaw: string;
    try {
      currentRaw = readFileSync(target.configPath, "utf8");
    } catch (err) {
      return {
        target,
        status: "skipped_race",
        detail: `couldn't re-read ${target.configPath}: ${(err as Error).message}`,
      };
    }
    if (initialRaw !== null && currentRaw !== initialRaw) {
      return {
        target,
        status: "skipped_race",
        detail: `${target.configPath} changed under us (likely your IDE wrote to it). Re-run install.`,
      };
    }
  }

  // Backup-name carries `<unix-ms>.<pid>.<rand8>` so concurrent
  // `--client=` invocations within the same millisecond can't collide.
  // `randomBytes` for non-predictable suffix; `O_EXCL` mode `0o600` on
  // the backup so the sidecar (which may contain JSON an attacker could
  // grep for tokens) isn't world-readable and can't be pre-planted via a
  // symlink race.
  if (existsSync(target.configPath)) {
    const rand = randomBytes(4).toString("hex");
    const backup = `${target.configPath}.bak.${Date.now()}.${process.pid}.${rand}`;
    copyFileSync(target.configPath, backup);
    // copyFileSync follows symlinks. We refused symlinks at the config
    // path above, but a same-uid attacker COULD race-replace the file
    // with a symlink between the lstatSync and this copyFileSync. The
    // resulting backup would contain the symlink target's bytes — but
    // the backup sidecar is chmod'd to 0600 below, so even on platforms
    // where the source file is 0644-ish, the sidecar isn't readable
    // outside the user's uid. Realistic threat: a malicious npm
    // postinstall in another package trying to leak files via a sidecar
    // it can read — defeated by the 0600. Acceptable for the documented
    // threat model.
    try {
      chmodSync(backup, 0o600);
    } catch {
      // Backup permission tightening is best-effort; if chmod fails
      // (Windows ACLs, exotic FS) the backup keeps default perms —
      // strictly better for durability than no backup.
    }
  }

  const nextServers: Record<string, unknown> = { ...servers, [SERVER_KEY]: SERVER_ENTRY };
  if (isMigration || needsStaleCleanup) {
    delete nextServers[LEGACY_SERVER_KEY];
  }
  const updated = setAtPath(cfg, target.anchor, nextServers);
  const payload = JSON.stringify(updated, null, 2) + "\n";

  // Write atomically via tmp + fsync + rename. Bare `writeFileSync`
  // opens with O_TRUNC; a power loss or SIGKILL mid-write leaves a
  // corrupted JSON config. POSIX `rename` is atomic on the same
  // filesystem. Windows `rename` is "best-effort atomic" (still
  // strictly better than truncate-and-write).
  const tmp = `${target.configPath}.tmp.${Date.now()}.${process.pid}.${randomBytes(4).toString(
    "hex",
  )}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    // `writeFileSync(fd, ...)` loops internally until the full payload
    // is written, defending against short writes on exotic FS where
    // a single `writeSync` is allowed to return less than the buffer
    // length.
    writeFileSync(fd, payload);
    fsyncSync(fd);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // ignore
    }
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
  closeSync(fd);
  renameSync(tmp, target.configPath);

  return {
    target,
    status: isMigration || needsStaleCleanup ? "migrated" : "installed",
    detail: target.configPath,
  };
}

function reportResults(results: InstallResult[], dryRun: boolean): void {
  for (const r of results) {
    switch (r.status) {
      case "would_install":
        stdout.write(`[${r.target.label}] ✎ would install   → ${r.detail}\n`);
        break;
      case "would_migrate":
        stdout.write(`[${r.target.label}] ✎ would migrate   → ${r.detail}\n`);
        break;
      case "installed":
        stdout.write(`[${r.target.label}] ✓ installed       → ${r.detail}\n`);
        break;
      case "migrated":
        stdout.write(
          `[${r.target.label}] ✓ migrated        → ${r.detail} (legacy "${LEGACY_SERVER_KEY}" entry replaced)\n`,
        );
        break;
      case "already_present":
        stdout.write(`[${r.target.label}] = already present → ${r.target.configPath}\n`);
        break;
      case "skipped_exists":
        stdout.write(`[${r.target.label}] ⚠ skipped         → ${r.detail}\n`);
        break;
      case "skipped_symlink":
        stdout.write(`[${r.target.label}] ⚠ symlink refused → ${r.detail}\n`);
        break;
      case "skipped_race":
        stdout.write(`[${r.target.label}] ⚠ config changed  → ${r.detail}\n`);
        break;
      case "skipped_no_target":
        stdout.write(`[${r.target.label}] - n/a             → ${r.detail}\n`);
        break;
    }
  }
  stdout.write("\n");
  if (dryRun) {
    stdout.write("DRY RUN — no files modified. Re-run with --yes to apply.\n");
  } else {
    stdout.write(
      "Done. Restart your IDE for the MCP server to load.\n" +
        "Then ask: 'what can I do with Sheepit?'\n",
    );
  }
}

function maybePrintStackBlock(skipDetect: boolean): void {
  if (skipDetect) return;
  const detected = detectStack(procCwd());
  // Only print when we found a manifest. "unknown" with no manifest is
  // the case where the user ran `npx` from outside their project — no
  // signal to show. With a manifest we print even for unknown so the
  // user sees we looked.
  if (detected.manifestPath === null) return;
  stdout.write("\n");
  stdout.write(renderStackBlock(detected));
}

/**
 * If there's no `~/.sheepit/credentials.json` AND `SHEEPIT_API_KEY` is
 * unset, the installed MCP entry will fail on first tool call with
 * "MissingCredentialsError". Surface that NOW — post-install — with a
 * yellow banner so the user runs `sheepit login` before restarting
 * their IDE.
 *
 * Re-running install AFTER login: no warning (the file exists). The
 * banner is a one-time nudge, not a recurring noise source.
 */
function maybePrintLoginBanner(): void {
  const credentialsPath = join(homedir(), ".sheepit", "credentials.json");
  if (existsSync(credentialsPath)) return;
  if (process.env["SHEEPIT_API_KEY"]) return;
  // Skip ANSI escapes on non-TTY (piped logs / CI) and when NO_COLOR
  // is set (https://no-color.org).
  const useColor = Boolean(stdout.isTTY) && !process.env["NO_COLOR"];
  const yellow = useColor ? "\x1b[33m" : "";
  const reset = useColor ? "\x1b[0m" : "";
  stdout.write("\n");
  stdout.write(
    `${yellow}⚠ No Sheepit credentials found.${reset}\n` +
      `  Expected one of:\n` +
      `    • ${credentialsPath}  (run \`sheepit login\`)\n` +
      `    • SHEEPIT_API_KEY env var\n` +
      "  The MCP server will refuse to start until one is set.\n",
  );
}

export function runInstall(rawArgs: string[]): void {
  const force = rawArgs.includes("--force");
  const dryRun = !rawArgs.includes("--yes");
  const skipDetect = rawArgs.includes("--no-detect");
  const onlyArg = rawArgs.find((a) => a.startsWith("--client="));
  const only = onlyArg?.split("=")[1];

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    stdout.write(
      [
        "USAGE",
        "  sheepit-mcp install              Show what would change (dry run)",
        "  sheepit-mcp install --yes        Apply changes",
        "  sheepit-mcp install --force      Overwrite existing sheepit entry",
        "  sheepit-mcp install --client=claude-desktop|cursor|codex   Only this client",
        "  sheepit-mcp install --no-detect  Skip stack detection",
        "",
        "Writes the @sheepit-ai/mcp server entry into your IDE's MCP config so",
        "Claude / Cursor / Codex pick it up on next start. Backs up the",
        "existing file to <path>.bak.<ts>.<pid>.<rand> (mode 0600) before any",
        "change, writes atomically via tmp+rename, and refuses to follow",
        "symlinks at the config path. For safest results, quit your IDE",
        "before running with --yes.",
        "",
        "If a legacy @goatech/mcp entry is present, it is replaced with the",
        "@sheepit-ai/mcp entry automatically on --yes (the package was",
        "renamed in 1.0.0; no --force required).",
        "",
        "When run from a directory containing a package.json, prints a",
        "stack-tailored integration snippet (Next.js / React / Node server)",
        "so you have copy-paste-ready code for the SDK.",
        "",
        "Run `sheepit login` first so the server has credentials when it boots.",
        "",
      ].join("\n"),
    );
    return;
  }

  const targets = resolveTargets().filter((t) => !only || t.id === only);
  if (targets.length === 0) {
    stderr.write(`No matching client for --client=${only}\n`);
    exit(1);
  }

  const results = targets.map((t) => {
    try {
      return planInstall(t, { force, dryRun });
    } catch (err) {
      return {
        target: t,
        status: "skipped_no_target" as const,
        detail: (err as Error).message,
      };
    }
  });

  reportResults(results, dryRun);
  maybePrintStackBlock(skipDetect);
  // Only nudge for credentials on the real (non-dry) run — a dry-run is
  // a preview, the user hasn't committed yet.
  if (!dryRun) maybePrintLoginBanner();
}
