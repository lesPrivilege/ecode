/**
 * Barrel: re-exports the G1b `Message <-> AgentMessage` adapter from
 * extensions/deterministic-compaction by relative source path (R9 —
 * controlled reuse, not a copy). All other modules in this extension import
 * from this barrel, never deterministic-compaction directly.
 *
 * Path note: the G4b dispatch packet's engineering-wiring section wrote this
 * path as `../deterministic-compaction/src/adapter.js` (one level up). That's
 * one level short — from `extensions/frontier-pruning/src/`, reaching
 * `extensions/deterministic-compaction/src/adapter.ts` requires going up two
 * levels (out of `frontier-pruning/src/` to `extensions/`, then into
 * `deterministic-compaction/src/`), not one. Corrected here; flagged in the
 * completion report rather than editing the packet doc.
 */
export * from "../../deterministic-compaction/src/adapter.js";
