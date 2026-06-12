import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStack, snippetFor, renderStackBlock } from "./stack-detect.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sheepit-stack-detect-"));
});

function writePkg(
  dir: string,
  deps: Record<string, string>,
  devDeps: Record<string, string> = {},
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "test", dependencies: deps, devDependencies: devDeps }),
  );
}

describe("detectStack", () => {
  it("detects Next.js — `next` in deps wins over react", () => {
    writePkg(tmp, { next: "15.0.0", react: "19.0.0" });
    const r = detectStack(tmp);
    expect(r.kind).toBe("nextjs");
    expect(r.evidence).toContain("next");
  });

  it("detects React (no next) — Vite / CRA / etc.", () => {
    writePkg(tmp, { react: "19.0.0", "react-dom": "19.0.0" }, { vite: "5.0.0" });
    const r = detectStack(tmp);
    expect(r.kind).toBe("react");
  });

  it("detects fastify-style Node servers", () => {
    writePkg(tmp, { fastify: "5.0.0" });
    expect(detectStack(tmp).kind).toBe("node-server");

    rmSync(tmp, { recursive: true, force: true });
    tmp = mkdtempSync(join(tmpdir(), "sheepit-stack-detect-2-"));
    writePkg(tmp, { express: "4.18.0" });
    expect(detectStack(tmp).kind).toBe("node-server");
  });

  it("returns 'unknown' when package.json has no recognized dep", () => {
    writePkg(tmp, { lodash: "4.17.21" });
    const r = detectStack(tmp);
    expect(r.kind).toBe("unknown");
    expect(r.manifestPath).not.toBeNull();
  });

  it("returns 'unknown' with null manifest when no package.json exists", () => {
    const r = detectStack(tmp);
    expect(r.kind).toBe("unknown");
    expect(r.manifestPath).toBeNull();
  });

  it("walks up to find package.json from a sub-directory", () => {
    writePkg(tmp, { next: "15.0.0" });
    const sub = join(tmp, "src", "app");
    mkdirSync(sub, { recursive: true });
    expect(detectStack(sub).kind).toBe("nextjs");
  });

  it("survives malformed package.json without throwing", () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "package.json"), "{ this is not json }");
    const r = detectStack(tmp);
    expect(r.kind).toBe("unknown");
  });
});

describe("snippetFor + renderStackBlock", () => {
  it("returns null for unknown stacks", () => {
    expect(snippetFor("unknown")).toBeNull();
  });

  it("every known stack ships a non-empty snippet with at least one env var (or none for swift)", () => {
    for (const kind of ["nextjs", "react", "node-server", "swift"] as const) {
      const s = snippetFor(kind);
      expect(s).not.toBeNull();
      expect(s!.title.length).toBeGreaterThan(5);
      expect(s!.install_command.length).toBeGreaterThan(5);
      expect(s!.integration_steps.length).toBeGreaterThan(0);
    }
  });

  it("renderStackBlock for unknown still gives the user something actionable", () => {
    const out = renderStackBlock({ kind: "unknown", evidence: "no deps", manifestPath: "/x" });
    expect(out).toContain("unknown");
    expect(out).toContain("install");
  });

  it("renderStackBlock for nextjs names the install command + env vars", () => {
    const out = renderStackBlock({
      kind: "nextjs",
      evidence: "next 15",
      manifestPath: "/x/package.json",
    });
    expect(out).toContain("@sheepit-ai/react");
    expect(out).toContain("NEXT_PUBLIC_SHEEPIT_KEY");
    // Class identifier intentionally unchanged in this wave — SDK
    // class rename is tracked separately.
    expect(out).toContain("GoaTechProvider");
  });
});
