/**
 * Ambient shim for a transitive dependency of `@earendil-works/pi-tui`.
 *
 * This extension typechecks against pi's TypeScript SOURCE directly (no build
 * step — see tsconfig `paths`), so importing `pi-tui` pulls in
 * `pi/packages/coding-agent/src/utils/syntax-highlight.ts`, which imports
 * `highlight.js/lib/index.js`. That package ships no bundled types, so tsc
 * reports an implicit-any error deep inside pi's own source — noise that has
 * nothing to do with this extension.
 *
 * Declaring the module here (untyped) silences that transitive error WITHOUT
 * modifying anything under `pi/`. It affects only this extension's typecheck.
 */
declare module "highlight.js/lib/index.js";
declare module "highlight.js/lib/core";
