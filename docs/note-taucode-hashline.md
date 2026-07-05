# Hashline + stale-read detection in taucode

Source tree: `../taucode/packages/` (never modified, read-only analysis).

---

## 1. How taucode computes and attaches the hash to a read/tool result

### 1.1 Hash function

The canonical hash is **SHA-256 truncated to 8 hex characters** (32 bits of
digest prefix):

- **`packages/tools/src/hashline/hash.ts:17-20`** — `computeFileHash(content)`:
  `createHash("sha256").update(content).digest("hex").slice(0, 8)`
- **`packages/core/src/read-dedup.ts:13-15`** — identical `computeFileHash`.

The hash is computed over the **entire file content** as read from disk
(UTF-8).  Two separate implementations exist (one in `core/` for the dedup
path, one in `tools/` for the tool implementations), but they produce
identical output.

### 1.2 Hashline output format

Read and search results are prefixed with a **hashline** — a first line of
the form:

```
¶path#<8-hex-hash>
```

The pilcrow `¶` (U+00B6) is the sigil that distinguishes a hashline from a
regular line-numbered output line.

Subsequent lines are `LINE_NUMBER:CONTENT` pairs.

#### `read` tool

- **`packages/tools/src/hashline/hash.ts:41-53`** — `buildHashlineOutput(path, content)`:
  produces `"¶path#hash\n1:line1\n2:line2\n..."`
- **`packages/tools/src/read.ts:107-113`** — `readFile()` calls
  `buildHashlineOutput(relPath, content)` for a full read.
- **`packages/tools/src/read.ts:120-125`** — for `:range` and `:offset`
  selectors, calls `buildHashlineRangeOutput(relPath, content, start, end)`.
  This computes the hash from the **full** content (not just the range), so
  the hashline always reflects the whole-file state.

#### `search` tool

- **`packages/tools/src/search.ts:177-200`** — For each file that had matches,
  tries to `readFileSync` the current content, computes
  `buildHashlineHeader(relPath, content)`, and emits `¶relPath#hash` as a
  section header.  If the file can't be read it falls back to
  `¶relPath#????????` (unknown-hash sentinel).

#### Raw mode

- **`packages/tools/src/read.ts:112-116`** — `:raw` suffix selector suppresses
  the hashline entirely.  This is the only way to get a read result without
  hash annotation.

### 1.3 Snapshot store

Every time a file is read, written, or edited, the tool records a
**snapshot** in the in-memory `SnapshotStore`:

- **`packages/tools/src/snapshots.ts:42-55`** — `createSnapshot(path, content)`:
  stores `path`, `hash` (same `computeFileHash`), `lines` map (1-based), and
  `timestamp`.
- **`packages/tools/src/result-helpers.ts:58-60`** — `recordSnapshot` called
  by `read` (via `readFile`, line 107), `write` (line 71), and `edit` (line 97).
- The store is global (`getSnapshotStore()`, line 49 of snapshots.ts) and
  lives for the duration of the session. It is used for recovery, not for
  hash verification — verification reads the file from disk every time.

---

## 2. How taucode detects a stale view (hash mismatch) and what it injects

There are **two independent stale-detection paths**: one for the
`read-dedup` interceptor and one for the `edit` tool.

### 2A. Read dedup — proactive "stale" detection (identity not mismatch)

**`packages/core/src/read-dedup.ts`**

Before a `read` tool call reaches the executor, `tryDedupRead()` (line 60)
checks whether the file on disk still matches the **last read result** in the
conversation history.

- **`tryDedupRead` (lines 60-94)**: reads the file from disk,
  `computeFileHash(content)`, then calls `findPriorRead()` (lines 31-50).
- **`findPriorRead` (lines 31-50)**: walks messages **backwards**, looking
  for the most recent `tool` message with `toolName === "read"` whose
  `sourcePath` matches `resolvedPath`.  It extracts the hash from that
  message's content (via `extractHashFromContent`, lines 17-27) — either from
  the `¶path#hash` header, or from the `#hash` suffix in a compacted read
  result `[compacted read result]` — and compares it with `currentHash`.

**When the hash matches (file unchanged):**

- Returns a synthetic `ToolResult` (line 83) with content:
  ```
  ¶<path>#<currentHash>
  [Dedup: file unchanged since prior read in this session. Hash matches.
  The previous read result is authoritative — do not re-read.]
  ```
- The result has `isError: false`, `details.dedup: true`, and points to the
  original message via `details.originalMessageId`.

**When the hash does NOT match (file changed, or no prior read):**

- Returns `null` — the read proceeds normally to the executor, which reads
  the file fresh and emits a new hashline with the new hash.

**Important caveat**: `tryDedupRead` is exported and listed in the public API
(`packages/core/src/index.ts:95`) but is **not yet wired into `runLoop`**
(`packages/core/src/loop.ts` only imports it).  This function is the seam
where a UI layer or tool executor would intercept `read` calls.  Currently
it's a library function available for integration.

### 2B. Edit verification — active hash mismatch detection

**`packages/tools/src/hashline/apply.ts`**

When the model emits an edit with a `¶path#hash` header, the `edit` tool:

1. **Parses** the header via `parseEditInput` (parser.ts, line 84).
2. **Reads** the file from disk.
3. **Verifies** the hash via `verifyHash` (apply.ts, lines 88-93):

```ts
export function verifyHash(filePath: string, expectedHash: string, currentContent: string): void {
  const actualHash = computeFileHash(currentContent);
  if (actualHash !== expectedHash) {
    throw new HashMismatchError(filePath, expectedHash, actualHash);
  }
}
```

- **`HashMismatchError`** is defined at `packages/core/src/errors.ts:57-67`.
  It extends `ToolError` and carries `filePath`, `expected` (from the
  hashline), and `actual` (current disk content).

**What happens on mismatch — the edit tool's error message**
(`packages/tools/src/edit.ts:87-94`):

```ts
if (err instanceof Error && err.name === "HashMismatchError") {
  return {
    modelText: `Error: File hash mismatch for ${section.path}. The file has been modified since last read. Please re-read the file and try again.`,
    details: {
      error: "hash_mismatch",
      path: section.path,
      expected: section.hash,
    },
    isError: true,
  };
}
```

- The error is **returned to the model as a tool error** (`isError: true`).
- The exact string `"The file has been modified since last read. Please re-read the file and try again."` is the instruction the model sees.
- The `details` object also carries `expected` and `actual` hashes for the
  UI/agent harness to inspect programmatically.

**Multi-file preflight** (edit.ts lines 60-77): all file sections are parsed
and verified **before any writes**.  If any file has a hash mismatch, no
writes at all are committed — the whole batch is rejected.  This prevents
partial-write corruption when the model edits multiple files at once.

---

## 3. The seam where an edit updates the hash (what invalidates a view)

### 3.1 Write tool

**`packages/tools/src/write.ts:60-65`** — `writeFileSync(absPath, content, "utf-8")`
then `recordSnapshot(absPath, content)`.

Writing a file replaces its entire content, which changes the SHA-256 hash.
Any prior `read` result's hashline for that path is now stale.

### 3.2 Edit tool

**`packages/tools/src/edit.ts:91-97`** — `writeFileSync(result.absPath, result.newContent, "utf-8")`
then `recordSnapshot(result.absPath, result.newContent)`.

Edits transform the content via `applyEditsWithVerification` (apply.ts,
lines 102-108), which:
1. `verifyHash()` — ensures the edit is based on a current view.
2. `applyEdits()` — bottom-up line transforms that produce `newContent`.
3. Returns `newContent` which is written to disk.

The hash of the new content will differ from the original, invalidating any
prior read result for that file.

### 3.3 External modifications

Any change to the file **outside** taucode (user edits in another editor,
`git checkout`, build artifacts, etc.) also changes the disk content, and
therefore the hash.  This is implicitly detected by the same mechanisms:

- `edit` tool: `verifyHash` reads the file from disk, so any external change
  causes a `HashMismatchError`.
- `read` tool: always reads from disk and emits a new hashline with the
  current hash.

### 3.4 Summary of the invalidation chain

```
Disk file content
  ↓ readFileSync / writeFileSync
SHA-256(content).slice(0,8)
  ↓ displayed as
¶path#<hash> in read/search output
  ↓ model copies into edit header
¶path#<expectedHash>
  ↓ edit tool reads disk, recomputes hash, compares
match  → proceed with edits
mismatch → HashMismatchError → model told to re-read
```

The "view" (a read result's hashline) is invalidated whenever the disk
content changes between the read and the edit.  There is no optimistic
locking or version counter — the hash is always computed fresh from disk at
the moment of verification.

### 3.5 Compaction preserves the hash

When a read result is compacted (see `compaction.ts`), the `ReadResultSummary`
stores `hash?: string` (compaction.ts:265-272), and the compacted message
content includes it as `(compacted read result)\nread <path> (... #<hash>)`.
The dedup hash-extractor (`extractHashFromContent` in read-dedup.ts:19-27)
parses this format via `COMPACTED_HASH_RE = /#([a-f0-9]+)\)/`, so dedup
still works across compaction cycles.

---

## File index (all hashline-relevant source)

| File | Role |
|---|---|
| `tools/src/hashline/hash.ts` | Hash computation, hashline format construction |
| `tools/src/hashline/parser.ts` | Parse `¶path#hash` header + edit ops from model input |
| `tools/src/hashline/apply.ts` | `verifyHash`, `applyEditsWithVerification` |
| `tools/src/read.ts` | Read tool — attaches hashline to output |
| `tools/src/search.ts` | Search tool — attaches hashline per-file sections |
| `tools/src/write.ts` | Write tool — updates snapshot, strips accidental hashline |
| `tools/src/edit.ts` | Edit tool — preflight verification, hash mismatch error |
| `tools/src/snapshots.ts` | In-memory snapshot store for session recovery |
| `tools/src/result-helpers.ts` | `recordSnapshot` glue |
| `core/src/read-dedup.ts` | Dedup interceptor — hash comparison against prior read |
| `core/src/compaction.ts` | `parseHashlineHeader`, `buildReadResultSummary` preserves hash |
| `core/src/errors.ts` | `HashMismatchError` class |
| `core/src/context.ts` | System prompt: "Use hashline anchors from read/search when editing" |
