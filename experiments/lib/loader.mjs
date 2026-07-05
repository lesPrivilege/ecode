/**
 * Node ESM resolve hook — the runtime bootstrap for `run.ts`.
 *
 * WHY this exists (and why not tsx / plain node):
 *   The pi-mono packages are consumed from source (`pi/` is read-only and never
 *   built, so `dist/` does not exist and the packages' published `exports` maps
 *   point at absent files). G1b's extension solves this for *tests* with a vitest
 *   alias array (extensions/deterministic-compaction/vitest.config.ts). The three
 *   experiment entry points are plain scripts, not vitest suites, so they need the
 *   same alias behaviour at Node's module-resolution layer instead.
 *
 *   tsx cannot do it: it re-resolves bare specifiers through Node's strict
 *   `exports` enforcement and dies on subpaths pi's own source imports
 *   (`@earendil-works/pi-ai/oauth`, `jiti/static`, ...). Plain Node handles
 *   `jiti/static` fine (it IS in jiti's exports); the only thing missing is the
 *   `@earendil-works/*` (and legacy `@mariozechner/*`) package aliases, which this
 *   hook supplies — a 1:1 mirror of the vitest alias map, so the experiment
 *   runtime resolves to the exact same pi source files the G1b tests do.
 *
 * Node v25 strips TypeScript types natively, so no transform hook is needed; only
 * `resolve` is overridden. Registered by ./register.mjs via node:module.register.
 *
 * G2 note: nothing provider-specific lives here. Swapping the mock provider for a
 * real DeepSeek/Mimo provider is a run-config change (see run.ts `--provider`),
 * not a change to this resolver.
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// experiments/lib/loader.mjs -> repo root is two levels up from lib/.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const PI = `${repoRoot}pi/packages`;
const CORE = `${repoRoot}packages/compaction-core/src/index.ts`;

/** specifier -> absolute source file. Mirrors vitest.config.ts alias array. */
const ALIASES = new Map([
	["@ecode/compaction-core", CORE],
	["@earendil-works/pi-ai", `${PI}/ai/src/index.ts`],
	["@earendil-works/pi-ai/compat", `${PI}/ai/src/compat.ts`],
	["@earendil-works/pi-ai/oauth", `${PI}/ai/src/oauth.ts`],
	["@earendil-works/pi-agent-core", `${PI}/agent/src/index.ts`],
	["@earendil-works/pi-tui", `${PI}/tui/src/index.ts`],
	["@earendil-works/pi-coding-agent", `${PI}/coding-agent/src/index.ts`],
	["@mariozechner/pi-ai", `${PI}/ai/src/index.ts`],
	["@mariozechner/pi-ai/compat", `${PI}/ai/src/compat.ts`],
	["@mariozechner/pi-ai/oauth", `${PI}/ai/src/oauth.ts`],
	["@mariozechner/pi-agent-core", `${PI}/agent/src/index.ts`],
	["@mariozechner/pi-tui", `${PI}/tui/src/index.ts`],
	["@mariozechner/pi-coding-agent", `${PI}/coding-agent/src/index.ts`],
]);

export async function resolve(specifier, context, nextResolve) {
	const target = ALIASES.get(specifier);
	if (target !== undefined) {
		return { url: pathToFileURL(target).href, shortCircuit: true };
	}

	// TS-idiomatic ESM: the experiment sources import siblings with a `.js`
	// extension that actually names a `.ts` file (same convention G1b uses;
	// vitest/tsx rewrite this automatically, native Node does not). When a
	// relative `.js` specifier has a sibling `.ts`, resolve to the `.ts`.
	if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js") && context.parentURL) {
		const tsUrl = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
		if (existsSync(fileURLToPath(tsUrl))) {
			return { url: tsUrl.href, shortCircuit: true };
		}
	}

	return nextResolve(specifier, context);
}
