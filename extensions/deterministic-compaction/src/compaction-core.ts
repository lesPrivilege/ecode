/**
 * Single re-export barrel for @ecode/compaction-core.
 *
 * Why a barrel instead of importing the package by name everywhere:
 *   pi loads an external extension's `.ts` through jiti and resolves the
 *   `@earendil-works/*` packages via its own alias map — but NOT third-party
 *   packages like `@ecode/compaction-core`. And `@ecode/compaction-core`'s
 *   published `exports` currently point at `./dist/index.js`, which its build
 *   does not actually emit at that path (its tsconfig `rootDir: "."` +
 *   `include: ["src","test"]` emits `./dist/src/index.js` instead) — so
 *   resolving it by name fails after a build too. See the report / bug note.
 *
 * To keep the extension loadable in real pi with no build step and no package
 * resolution games, we import the compaction-core SOURCE by relative path here
 * (jiti and vitest both transpile TS on the fly). This is the single place that
 * knows the repo layout; every other module imports from `./compaction-core.js`.
 */

export * from "../../../packages/compaction-core/src/index.js";
