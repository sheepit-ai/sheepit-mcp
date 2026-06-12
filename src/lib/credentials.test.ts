import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MissingCredentialsError, resolveCredentials } from "./credentials.js";

/**
 * `resolveCredentials` reads from `~/.sheepit/credentials.json` by
 * default. We override $HOME for the duration of each test so the
 * suite doesn't touch the developer's real credentials file.
 */

let originalHome: string | undefined;
let tmpHome: string;

async function writeCredsFile(content: string) {
  await mkdir(join(tmpHome, ".sheepit"), { recursive: true });
  await writeFile(join(tmpHome, ".sheepit", "credentials.json"), content);
}

beforeEach(async () => {
  originalHome = process.env["HOME"];
  tmpHome = await mkdtemp(join(tmpdir(), "sheepit-mcp-test-"));
  process.env["HOME"] = tmpHome;
  delete process.env["SHEEPIT_API_KEY"];
  delete process.env["SHEEPIT_API_URL"];
  delete process.env["SHEEPIT_PROFILE"];
});

afterEach(async () => {
  if (originalHome) process.env["HOME"] = originalHome;
  else delete process.env["HOME"];
  await rm(tmpHome, { recursive: true, force: true });
});

describe("resolveCredentials", () => {
  it("uses SHEEPIT_API_KEY env var when present (no file required)", async () => {
    process.env["SHEEPIT_API_KEY"] = "lp_sec_xxx_abc";
    const out = await resolveCredentials();
    expect(out.apiKey).toBe("lp_sec_xxx_abc");
    expect(out.apiUrl).toBe("https://api.goatech.ai");
    expect(out.profileName).toBe("env");
  });

  it("respects SHEEPIT_API_URL when env-key path is taken", async () => {
    process.env["SHEEPIT_API_KEY"] = "lp_sec_xxx_abc";
    process.env["SHEEPIT_API_URL"] = "https://api.staging.goatech.ai";
    const out = await resolveCredentials();
    expect(out.apiUrl).toBe("https://api.staging.goatech.ai");
  });

  it("throws MissingCredentialsError with install guidance when file is missing", async () => {
    await expect(resolveCredentials()).rejects.toBeInstanceOf(MissingCredentialsError);
    await expect(resolveCredentials()).rejects.toThrow(/sheepit login/);
  });

  it("throws when credentials file is malformed JSON", async () => {
    await writeCredsFile("not-json");
    await expect(resolveCredentials()).rejects.toBeInstanceOf(MissingCredentialsError);
  });

  it("returns the `current` profile by default", async () => {
    await writeCredsFile(
      JSON.stringify({
        current: "prod",
        profiles: {
          prod: { apiKey: "lp_sec_a", apiUrl: "https://api.goatech.ai", projectSlug: "p1" },
          dev: { apiKey: "lp_sec_b", apiUrl: "https://api.goatech.ai" },
        },
      }),
    );
    const out = await resolveCredentials();
    expect(out.apiKey).toBe("lp_sec_a");
    expect(out.profileName).toBe("prod");
    expect(out.projectSlug).toBe("p1");
  });

  it("respects SHEEPIT_PROFILE override", async () => {
    await writeCredsFile(
      JSON.stringify({
        current: "prod",
        profiles: {
          prod: { apiKey: "lp_sec_a", apiUrl: "https://api.goatech.ai" },
          dev: { apiKey: "lp_sec_b", apiUrl: "https://api.goatech.ai" },
        },
      }),
    );
    process.env["SHEEPIT_PROFILE"] = "dev";
    const out = await resolveCredentials();
    expect(out.apiKey).toBe("lp_sec_b");
    expect(out.profileName).toBe("dev");
  });

  it("throws with helpful message when the requested profile doesn't exist", async () => {
    await writeCredsFile(
      JSON.stringify({
        current: "prod",
        profiles: { prod: { apiKey: "lp_sec_a", apiUrl: "https://api.goatech.ai" } },
      }),
    );
    process.env["SHEEPIT_PROFILE"] = "ghost";
    await expect(resolveCredentials()).rejects.toThrow(/Profile "ghost" not found/);
  });

  it("ignores legacy GOATECH_* env vars after the rename (hard cutover)", async () => {
    // Pre-rename clients that still set GOATECH_API_KEY get the same
    // MissingCredentialsError they would have seen with nothing set —
    // there is intentionally no fallback. Re-set as SHEEPIT_*.
    process.env["GOATECH_API_KEY"] = "lp_sec_legacy";
    process.env["GOATECH_PROFILE"] = "legacy";
    await expect(resolveCredentials()).rejects.toBeInstanceOf(MissingCredentialsError);
    delete process.env["GOATECH_API_KEY"];
    delete process.env["GOATECH_PROFILE"];
  });

  it("never falls back to ~/.goatech/credentials.json (hard cutover — security N-1)", async () => {
    // A user who upgraded the package but didn't move their creds file
    // gets MissingCredentialsError; we must NOT silently keep using
    // the old path or a future "be helpful" patch could silently
    // reintroduce the cross-tenant-id-leak the rename was designed to
    // close.
    await mkdir(join(tmpHome, ".goatech"), { recursive: true });
    await writeFile(
      join(tmpHome, ".goatech", "credentials.json"),
      JSON.stringify({
        current: "prod",
        profiles: { prod: { apiKey: "lp_sec_legacy", apiUrl: "https://api.goatech.ai" } },
      }),
    );
    await expect(resolveCredentials()).rejects.toBeInstanceOf(MissingCredentialsError);
    await expect(resolveCredentials()).rejects.toThrow(/sheepit login/);
  });
});
