import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Same alias strategy as extensions/deterministic-compaction: point the pi-mono
 * package names at their workspace `src` entry points so no build of pi is needed.
 * The gate unit tests are pure and need none of these, but the harness modules
 * they import (via lib/) pull the pi types in, so the aliases keep the whole tree
 * type-checkable and runnable under vitest.
 */
const piRoot = fileURLToPath(new URL("../pi/packages", import.meta.url));
const aiSrcIndex = `${piRoot}/ai/src/index.ts`;
const aiSrcCompat = `${piRoot}/ai/src/compat.ts`;
const aiSrcOAuth = `${piRoot}/ai/src/oauth.ts`;
const agentSrcIndex = `${piRoot}/agent/src/index.ts`;
const tuiSrcIndex = `${piRoot}/tui/src/index.ts`;
const codingAgentSrcIndex = `${piRoot}/coding-agent/src/index.ts`;
const compactionCoreSrc = fileURLToPath(new URL("../packages/compaction-core/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
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
