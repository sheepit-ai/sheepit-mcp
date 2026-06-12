import { defineConfig } from "tsup";

/**
 * Bundle config for `@sheepit-ai/mcp` (the binary published to npm).
 *
 * The package has no workspace dependencies — every import is either a Node
 * builtin or a real npm dependency listed in package.json, which stays
 * external and resolves at install time. The API-contract schemas the tools
 * use are vendored under `src/vendor/` and bundled as ordinary source.
 *
 * Single ESM entry, with the shebang preserved so the published bin
 * (`./dist/index.js`) is directly executable after `chmod +x`.
 */
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  dts: false,
  clean: true,
  treeshake: true,
  sourcemap: true,
  minify: false,
  target: "node18",
  platform: "node",
  // tsup keeps `#!/usr/bin/env node` from src/index.ts in the output.
  banner: { js: "" },
});
