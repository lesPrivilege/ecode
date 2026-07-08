/**
 * Barrel: re-exports @ecode/context-pruning by relative source path (no
 * package-name resolution — known to fail under jiti loading). All other
 * modules in this extension import from this barrel, never the package
 * directly.
 */
export * from "../../../packages/context-pruning/src/index.js";
