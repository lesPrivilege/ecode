import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Resolve the pi-mono workspace sources directly (mirrors
 * extensions/deterministic-compaction/vitest.config.ts — the repo's
 * established alias strategy). This extension's real-loop smoke test
 * imports pi packages by their published names; these aliases point them
 * at pi's workspace `src` entry points so no build of pi is required.
 * Transitive deps resolve from the pi/packages/coding-agent/node_modules
 * tree that owns the resolved sources.
 *
 * `@ecode/context-pruning` is intentionally NOT aliased here: this
 * extension never imports it by package name — src/context-pruning.ts is a
 * relative-path barrel into packages/context-pruning/src/index.ts (G4a/G4b
 * convention), so there's nothing for a package-name alias to intercept.
 */
const piRoot = fileURLToPath(new URL("../../pi/packages", import.meta.url));
const aiSrcIndex = `${piRoot}/ai/src/index.ts`;
const aiSrcCompat = `${piRoot}/ai/src/compat.ts`;
const aiSrcOAuth = `${piRoot}/ai/src/oauth.ts`;
const agentSrcIndex = `${piRoot}/agent/src/index.ts`;
const tuiSrcIndex = `${piRoot}/tui/src/index.ts`;
const codingAgentSrcIndex = `${piRoot}/coding-agent/src/index.ts`;

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 30000,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
  },
  resolve: {
    alias: [
      { find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
      { find: /^@earendil-works\/pi-ai\/compat$/, replacement: aiSrcCompat },
      { find: /^@earendil-works\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
      { find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
      { find: /^@earendil-works\/pi-tui$/, replacement: tuiSrcIndex },
      { find: /^@earendil-works\/pi-coding-agent$/, replacement: codingAgentSrcIndex },
      { find: /^@mariozechner\/pi-ai$/, replacement: aiSrcIndex },
      { find: /^@mariozechner\/pi-ai\/compat$/, replacement: aiSrcCompat },
      { find: /^@mariozechner\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
      { find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrcIndex },
      { find: /^@mariozechner\/pi-tui$/, replacement: tuiSrcIndex },
      { find: /^@mariozechner\/pi-coding-agent$/, replacement: codingAgentSrcIndex },
    ],
  },
});
