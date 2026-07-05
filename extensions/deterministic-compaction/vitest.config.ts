import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Resolve the pi-mono workspace sources and the @ecode/compaction-core source
 * directly (mirrors pi's own coding-agent/vitest.config.ts alias strategy).
 *
 * The extension and its tests import the pi packages by their published names;
 * these aliases point them at pi's workspace `src` entry points so no build of
 * pi is required. Transitive deps (typebox, vitest, etc.) resolve from the
 * pi/packages/coding-agent/node_modules tree that owns the resolved sources.
 */
const piRoot = fileURLToPath(new URL("../../pi/packages", import.meta.url));
const aiSrcIndex = `${piRoot}/ai/src/index.ts`;
const aiSrcCompat = `${piRoot}/ai/src/compat.ts`;
const aiSrcOAuth = `${piRoot}/ai/src/oauth.ts`;
const agentSrcIndex = `${piRoot}/agent/src/index.ts`;
const tuiSrcIndex = `${piRoot}/tui/src/index.ts`;
const codingAgentSrcIndex = `${piRoot}/coding-agent/src/index.ts`;
const compactionCoreSrc = fileURLToPath(new URL("../../packages/compaction-core/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		// Redirect ambient telemetry writes to a throwaway, gitignored dir so the
		// real dogfood data under experiments/results/ambient/ is never touched by
		// the test suite (the smoke test drives a real session with telemetry ON by
		// default). Individual tests may still override via writeOptions.dir.
		env: {
			ECODE_AMBIENT_DIR: fileURLToPath(new URL("./.ambient-test-tmp", import.meta.url)),
		},
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@ecode\/compaction-core$/, replacement: compactionCoreSrc },
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
