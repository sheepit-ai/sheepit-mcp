/**
 * Best-effort stack detection. Reads the project root's `package.json`
 * to figure out which SDK + integration snippet the dogfooder needs.
 *
 * Conservative — never falsely claims a stack we can't see signal for.
 * "unknown" is the default; only known-good shapes get a specific
 * recommendation.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type StackKind = "nextjs" | "react" | "node-server" | "swift" | "unknown";

export interface DetectedStack {
  kind: StackKind;
  evidence: string;
  /** Path to the package.json we read (or null when not found). */
  manifestPath: string | null;
}

export function detectStack(cwd: string): DetectedStack {
  // Walk up at most 3 levels — enough to find the project root from a
  // sub-directory (apps/web/) without hitting random unrelated trees.
  let dir = cwd;
  for (let i = 0; i < 4; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      return readManifest(pkg);
    }
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return { kind: "unknown", evidence: "no package.json found", manifestPath: null };
}

function readManifest(path: string): DetectedStack {
  let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as never;
  } catch {
    return { kind: "unknown", evidence: `${path} is not parseable JSON`, manifestPath: path };
  }
  const all: Record<string, string> = {
    ...(parsed.dependencies ?? {}),
    ...(parsed.devDependencies ?? {}),
  };

  // Detection priority — most specific signal first.
  if (all["next"]) {
    return { kind: "nextjs", evidence: `next ${all["next"]}`, manifestPath: path };
  }
  if (all["react"] && !all["next"]) {
    return { kind: "react", evidence: `react ${all["react"]}`, manifestPath: path };
  }
  if (all["fastify"] || all["express"] || all["koa"] || all["hono"]) {
    const evidence = ["fastify", "express", "koa", "hono"]
      .filter((dep) => all[dep])
      .map((dep) => `${dep} ${all[dep]}`)
      .join(", ");
    return { kind: "node-server", evidence, manifestPath: path };
  }
  return {
    kind: "unknown",
    evidence: "no Next.js / React / known Node-server dependency",
    manifestPath: path,
  };
}

export interface StackSnippet {
  title: string;
  install_command: string;
  integration_steps: string[];
  env_vars: Array<{ name: string; description: string }>;
}

const SNIPPETS: Record<Exclude<StackKind, "unknown">, StackSnippet> = {
  nextjs: {
    title: "Next.js detected",
    install_command: "npm install @sheepit-ai/react @sheepit-ai/sdk-js @sheepit-ai/server",
    integration_steps: [
      "1. Create app/providers.tsx with the GoaTechProvider:",
      '   "use client";',
      '   import { GoaTechProvider } from "@sheepit-ai/react";',
      "   export function Providers({ children }: { children: React.ReactNode }) {",
      "     return (",
      "       <GoaTechProvider",
      "         publishableKey={process.env.NEXT_PUBLIC_SHEEPIT_KEY!}",
      "         appVersion={process.env.NEXT_PUBLIC_APP_VERSION}",
      "       >",
      "         {children}",
      "       </GoaTechProvider>",
      "     );",
      "   }",
      "",
      "2. Wrap <body> in app/layout.tsx with <Providers>.",
      "",
      "3. Bake the build sha into NEXT_PUBLIC_APP_VERSION in next.config.ts:",
      "   env: { NEXT_PUBLIC_APP_VERSION: process.env.VERCEL_GIT_COMMIT_SHA }",
      "",
      "4. For server-side track / flag reads, init @sheepit-ai/server in a",
      "   shared lib (e.g. src/lib/sheepit.ts) using the secret key.",
    ],
    env_vars: [
      {
        name: "NEXT_PUBLIC_SHEEPIT_KEY",
        description: "publishable key (lp_pub_*) — safe to ship in client bundle",
      },
      {
        name: "SHEEPIT_SECRET_KEY",
        description: "secret key (lp_sec_*) — server only, never NEXT_PUBLIC_",
      },
      {
        name: "NEXT_PUBLIC_APP_VERSION",
        description: "build sha (next.config.ts injects from VERCEL_GIT_COMMIT_SHA)",
      },
    ],
  },
  react: {
    title: "React (non-Next.js) detected",
    install_command: "npm install @sheepit-ai/react @sheepit-ai/sdk-js",
    integration_steps: [
      "1. Wrap your app root with <GoaTechProvider>:",
      '   import { GoaTechProvider } from "@sheepit-ai/react";',
      "   <GoaTechProvider",
      "     publishableKey={import.meta.env.VITE_SHEEPIT_KEY}",
      "     appVersion={import.meta.env.VITE_APP_VERSION}",
      "   >",
      "     <App />",
      "   </GoaTechProvider>",
      "",
      "2. For Vite, set VITE_SHEEPIT_KEY + VITE_APP_VERSION in .env.local",
      "   (use VITE_APP_VERSION to inject the build sha at build time).",
    ],
    env_vars: [
      {
        name: "VITE_SHEEPIT_KEY",
        description: "publishable key — Vite-prefixed so it ships to the browser",
      },
      {
        name: "VITE_APP_VERSION",
        description: "build identifier (use git rev-parse HEAD or pkg version)",
      },
    ],
  },
  "node-server": {
    title: "Node server (Fastify / Express / Koa / Hono) detected",
    install_command: "npm install @sheepit-ai/server",
    integration_steps: [
      "1. At the top of your server bootstrap, BEFORE registering routes:",
      '   import { GoaTechServer } from "@sheepit-ai/server";',
      "   export const sheepit = await GoaTechServer.init({",
      "     secretKey: process.env.SHEEPIT_SECRET_KEY!,",
      '     appVersion: process.env["npm_package_version"] ?? "dev",',
      "   });",
      "",
      "2. Track auth / payment / enrollment events AFTER the DB write:",
      "   await sheepit.track({",
      "     userId: user.id,",
      '     event: "signup_completed",',
      '     properties: { method: "email" },',
      "   });",
      "",
      "3. Server-side flag reads:",
      '   const showNew = await sheepit.flag("show_new_pricing", { userId, defaultValue: false });',
    ],
    env_vars: [
      {
        name: "SHEEPIT_SECRET_KEY",
        description: "secret key (lp_sec_*) — full project access; server only",
      },
    ],
  },
  swift: {
    title: "Swift / iOS detected",
    install_command: "Add `GoaTechSDK` via Swift Package Manager",
    integration_steps: [
      "1. SPM: File → Add Packages → enter the Sheepit Swift package URL",
      "2. In your AppContext singleton, on app launch:",
      "   let sheepit = await GoaTechSDK.shared.start(",
      '     publishableKey: "lp_pub_...",',
      "     appVersion: Bundle.main.shortVersionString",
      "   )",
    ],
    env_vars: [],
  },
};

export function snippetFor(kind: StackKind): StackSnippet | null {
  if (kind === "unknown") return null;
  return SNIPPETS[kind];
}

export function renderStackBlock(detected: DetectedStack): string {
  if (detected.kind === "unknown") {
    return [
      "Stack detection: unknown (" + detected.evidence + ").",
      "",
      "If you're integrating into a Next.js / React / Node server, run:",
      "  npx @sheepit-ai/mcp install --yes  # from inside your project root",
      "and we'll surface stack-specific setup steps.",
      "",
    ].join("\n");
  }
  const snippet = snippetFor(detected.kind)!;
  const out: string[] = [];
  out.push(`Stack detection: ${snippet.title} (${detected.evidence}).`);
  out.push(``);
  out.push(`Install:`);
  out.push(`  ${snippet.install_command}`);
  out.push(``);
  out.push(`Integration:`);
  for (const step of snippet.integration_steps) out.push(`  ${step}`);
  if (snippet.env_vars.length > 0) {
    out.push(``);
    out.push(`Environment variables:`);
    for (const v of snippet.env_vars) {
      out.push(`  ${v.name}  — ${v.description}`);
    }
  }
  out.push(``);
  return out.join("\n");
}
