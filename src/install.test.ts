import { describe, it, expect, beforeEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  symlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Install-helper tests. We can't test the public CLI directly (it reads
 * homedir() so we'd need to globally hijack $HOME), so we exercise the
 * pure-function pieces — JSON merge, idempotency, backup behavior — by
 * importing and calling runInstall against a temp config path under a
 * hijacked $HOME.
 *
 * Coverage:
 *   1. Empty config → install adds {mcpServers: {sheepit: ...}}
 *   2. Pre-existing other server → install merges, doesn't overwrite
 *   3. Pre-existing identical sheepit entry → no-op (idempotent)
 *   4. Pre-existing differing sheepit entry → skipped without --force
 *   5. --force → overwrites + creates a .bak.<ts> file
 *   6. Legacy `mcpServers.goatech` → `@goatech/mcp` migrates to
 *      `mcpServers.sheepit` → `@sheepit-ai/mcp` on --yes (no --force)
 *   7. Foreign `mcpServers.goatech` (non-@goatech/mcp args) is NOT
 *      migrated — user kept that key for something else
 */

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "sheepit-mcp-install-test-"));
  process.env["HOME"] = tmpHome;
  process.env["APPDATA"] = tmpHome;
});

async function runInstallFresh(args: string[]): Promise<void> {
  const mod = await import("./install.js");
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    mod.runInstall(args);
  } finally {
    process.stdout.write = origWrite;
  }
}

function claudeDesktopPath(): string {
  return join(tmpHome, "Library", "Application Support", "Claude", "claude_desktop_config.json");
}

const NEW_ENTRY = {
  command: "npx",
  args: ["-y", "@sheepit-ai/mcp", "serve"],
};

const LEGACY_ENTRY = {
  command: "npx",
  args: ["-y", "@goatech/mcp", "serve"],
};

describe("sheepit-mcp install", () => {
  it("dry-run by default — no files written", async () => {
    await runInstallFresh([]);
    expect(existsSync(claudeDesktopPath())).toBe(false);
  });

  it("--yes installs into a missing config (creates parent dirs + writes file)", async () => {
    await runInstallFresh(["--yes", "--client=claude-desktop"]);
    const path = claudeDesktopPath();
    expect(existsSync(path)).toBe(true);
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    expect(cfg.mcpServers.sheepit).toEqual(NEW_ENTRY);
    expect(cfg.mcpServers.goatech).toBeUndefined();
  });

  it("--yes preserves other top-level keys + other mcpServers entries", async () => {
    const path = claudeDesktopPath();
    const dir = path.substring(0, path.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        someUnrelatedSetting: "preserve me",
        mcpServers: {
          existingServer: { command: "/bin/ls", args: [] },
        },
      }),
    );
    await runInstallFresh(["--yes", "--client=claude-desktop"]);
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    expect(cfg.someUnrelatedSetting).toBe("preserve me");
    expect(cfg.mcpServers.existingServer).toEqual({ command: "/bin/ls", args: [] });
    expect(cfg.mcpServers.sheepit).toBeDefined();
  });

  it("identical existing entry is a no-op (no backup, idempotent)", async () => {
    const path = claudeDesktopPath();
    const dir = path.substring(0, path.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          sheepit: NEW_ENTRY,
        },
      }),
    );

    await runInstallFresh(["--yes", "--client=claude-desktop"]);

    // No .bak.* sidecar was written.
    const dirEntries = readdirSync(dir);
    const backups = dirEntries.filter((n) => n.includes(".bak."));
    expect(backups).toHaveLength(0);
  });

  it("refuses to overwrite a differing sheepit entry without --force", async () => {
    const path = claudeDesktopPath();
    const dir = path.substring(0, path.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          sheepit: { command: "node", args: ["./local-build.js"] },
        },
      }),
    );

    await runInstallFresh(["--yes", "--client=claude-desktop"]);

    const cfg = JSON.parse(readFileSync(path, "utf8"));
    expect(cfg.mcpServers.sheepit).toEqual({
      command: "node",
      args: ["./local-build.js"],
    });
  });

  it("--force overwrites + creates a timestamped backup of the prior config", async () => {
    const path = claudeDesktopPath();
    const dir = path.substring(0, path.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    const original = JSON.stringify({
      mcpServers: { sheepit: { command: "node", args: ["./local-build.js"] } },
    });
    writeFileSync(path, original);

    await runInstallFresh(["--yes", "--force", "--client=claude-desktop"]);

    const cfg = JSON.parse(readFileSync(path, "utf8"));
    expect(cfg.mcpServers.sheepit).toEqual(NEW_ENTRY);

    const backups = readdirSync(dir).filter((n) => n.includes(".bak."));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    const backupContent = readFileSync(join(dir, backups[0]!), "utf8");
    expect(backupContent).toBe(original);
  });

  it("migrates a legacy @goatech/mcp entry to @sheepit-ai/mcp on --yes (no --force)", async () => {
    const path = claudeDesktopPath();
    const dir = path.substring(0, path.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    const original = JSON.stringify({
      someUnrelatedSetting: "preserve me",
      mcpServers: {
        goatech: LEGACY_ENTRY,
        otherServer: { command: "/bin/echo", args: ["hi"] },
      },
    });
    writeFileSync(path, original);

    await runInstallFresh(["--yes", "--client=claude-desktop"]);

    const cfg = JSON.parse(readFileSync(path, "utf8"));
    // New key written...
    expect(cfg.mcpServers.sheepit).toEqual(NEW_ENTRY);
    // ...legacy key removed...
    expect(cfg.mcpServers.goatech).toBeUndefined();
    // ...siblings preserved...
    expect(cfg.someUnrelatedSetting).toBe("preserve me");
    expect(cfg.mcpServers.otherServer).toEqual({ command: "/bin/echo", args: ["hi"] });
    // ...and the original file got backed up first.
    const backups = readdirSync(dir).filter((n) => n.includes(".bak."));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    const backupContent = readFileSync(join(dir, backups[0]!), "utf8");
    expect(backupContent).toBe(original);
  });

  it("leaves a user-customized @goatech/mcp entry alone (canonical-only migration — F-3)", async () => {
    // User had `mcpServers.goatech = { command: "npx", args: ["-y", "@goatech/mcp", "serve", "--verbose"] }`
    // The extra `--verbose` is a user customization we must NOT silently drop. Bail out of
    // auto-migration; surface as a regular `skipped_exists` so they re-run with --force if
    // they actively want the new entry.
    const path = claudeDesktopPath();
    const dir = path.substring(0, path.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    const customized = {
      command: "npx",
      args: ["-y", "@goatech/mcp", "serve", "--verbose"],
      env: { GOATECH_API_KEY: "lp_sec_custom" },
    };
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          goatech: customized,
        },
      }),
    );

    await runInstallFresh(["--yes", "--client=claude-desktop"]);

    const cfg = JSON.parse(readFileSync(path, "utf8"));
    // Customized legacy entry preserved verbatim — including the custom env block.
    expect(cfg.mcpServers.goatech).toEqual(customized);
    // New entry still written under the new key (the user gets BOTH and can decide what to do).
    expect(cfg.mcpServers.sheepit).toEqual(NEW_ENTRY);
  });

  it("cleans up a stale legacy entry when the new key is already in place (F-4)", async () => {
    // User hand-pasted the new entry but never deleted the canonical legacy one.
    // Re-running install should converge to a single canonical entry under the new key.
    const path = claudeDesktopPath();
    const dir = path.substring(0, path.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          sheepit: NEW_ENTRY,
          goatech: LEGACY_ENTRY,
        },
      }),
    );

    await runInstallFresh(["--yes", "--client=claude-desktop"]);

    const cfg = JSON.parse(readFileSync(path, "utf8"));
    expect(cfg.mcpServers.sheepit).toEqual(NEW_ENTRY);
    expect(cfg.mcpServers.goatech).toBeUndefined();
    // Stale-cleanup IS a file write, so a backup must have been taken (F-4 + F-2).
    const backups = readdirSync(dir).filter((n) => n.includes(".bak."));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it("backup name includes pid + random suffix to survive same-ms collisions (F-2)", async () => {
    const path = claudeDesktopPath();
    const dir = path.substring(0, path.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { sheepit: { command: "node", args: ["./old.js"] } } }),
    );

    await runInstallFresh(["--yes", "--force", "--client=claude-desktop"]);

    const backups = readdirSync(dir).filter((n) => n.includes(".bak."));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    // `.bak.<ms>.<pid>.<rand8-hex>` — 3 dot-segments after `.bak.`,
    // last segment is randomBytes(4).toString("hex") = 8 lowercase hex.
    expect(backups[0]).toMatch(/\.bak\.\d+\.\d+\.[0-9a-f]{8}$/);
  });

  it("leaves a foreign mcpServers.goatech entry alone (only migrates @goatech/mcp args)", async () => {
    const path = claudeDesktopPath();
    const dir = path.substring(0, path.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          // User happened to use "goatech" as the key for their own
          // local build before the rename — that's not ours to delete.
          goatech: { command: "node", args: ["./my-local-build.js"] },
        },
      }),
    );

    await runInstallFresh(["--yes", "--client=claude-desktop"]);

    const cfg = JSON.parse(readFileSync(path, "utf8"));
    expect(cfg.mcpServers.goatech).toEqual({
      command: "node",
      args: ["./my-local-build.js"],
    });
    // New entry still written under the new key.
    expect(cfg.mcpServers.sheepit).toEqual(NEW_ENTRY);
  });

  it("preserves both keys silently when a customized goatech entry sits alongside an identical sheepit entry", async () => {
    const path = claudeDesktopPath();
    const dir = path.substring(0, path.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    const customized = { command: "node", args: ["./my-local-build.js"] };
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: {
          sheepit: NEW_ENTRY,
          goatech: customized,
        },
      }),
    );

    await runInstallFresh(["--yes", "--client=claude-desktop"]);

    const cfg = JSON.parse(readFileSync(path, "utf8"));
    // Both kept. New is no-op-already-present; goatech is a foreign
    // entry the user owns, NOT a canonical legacy.
    expect(cfg.mcpServers.sheepit).toEqual(NEW_ENTRY);
    expect(cfg.mcpServers.goatech).toEqual(customized);
    // No backup because no write happened.
    const backups = readdirSync(dir).filter((n) => n.includes(".bak."));
    expect(backups).toHaveLength(0);
  });

  it("refuses to follow a symlink at the config path (security M-1)", async () => {
    const path = claudeDesktopPath();
    const dir = path.substring(0, path.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    // Target file lives elsewhere; symlink at the config path points
    // to it. Without the lstatSync refuse, copyFileSync would copy the
    // target's contents into a world-readable backup sidecar.
    const target = join(dir, "real-file.json");
    writeFileSync(target, JSON.stringify({ secret: "do-not-leak" }));
    symlinkSync(target, path);

    await runInstallFresh(["--yes", "--client=claude-desktop"]);

    // Symlink + target both unchanged.
    expect(readFileSync(target, "utf8")).toBe(JSON.stringify({ secret: "do-not-leak" }));
    // No backup of the target was created.
    const backups = readdirSync(dir).filter((n) => n.includes(".bak."));
    expect(backups).toHaveLength(0);
  });

  it("writes atomically via tmp + rename and chmod 0600 on the backup (security M-2)", async () => {
    const path = claudeDesktopPath();
    const dir = path.substring(0, path.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: {} }));

    await runInstallFresh(["--yes", "--client=claude-desktop"]);

    // After install: config has the new entry; no .tmp.* sidecar
    // lingering (atomic-rename consumed it).
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    expect(cfg.mcpServers.sheepit).toEqual(NEW_ENTRY);
    const tmpSidecars = readdirSync(dir).filter((n) => n.includes(".tmp."));
    expect(tmpSidecars).toHaveLength(0);
    // Backup permissions: mode 0o600 (owner rw, nobody else). On
    // platforms where chmod is a no-op (Windows), the test still
    // confirms the file exists — that's the load-bearing assertion.
    const backups = readdirSync(dir).filter((n) => n.includes(".bak."));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    if (process.platform !== "win32") {
      const mode = statSync(join(dir, backups[0]!)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  // Cleanup tmpHome between runs.
  it("teardown", () => {
    rmSync(tmpHome, { recursive: true, force: true });
  });
});
