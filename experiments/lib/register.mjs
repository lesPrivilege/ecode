/**
 * Registers ./loader.mjs as a Node ESM resolve hook, then leaves control to the
 * script named on the command line. Use as:
 *
 *   node --import ./lib/register.mjs run.ts <args>
 *
 * `module.register` (node:module) installs the hook on the loader thread; a bare
 * `--import ./loader.mjs` is NOT enough on Node v25 — the exported `resolve` must
 * be registered explicitly. See loader.mjs for why the hook is needed at all.
 */

import { register } from "node:module";

register("./loader.mjs", import.meta.url);
