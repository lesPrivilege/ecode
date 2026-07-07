#!/usr/bin/env node
/**
 * Deterministic compiler for docs/index.html — the bilingual paper preview page.
 *
 * This script is the ONLY generation path for docs/index.html. Do not hand-edit
 * that file again; edit the markdown sources and re-run this script instead.
 *
 * Inputs:
 *   docs/paper-context-economy-2026-07-07.md      (EN source)
 *   docs/paper-context-economy-2026-07-07_zh.md   (ZH source)
 *
 * Output:
 *   docs/index.html — a static, self-contained (no CDN/external resources) page
 *   with three view modes (English / Chinese / side-by-side), toggled by the
 *   same control bar and JS the page has always used.
 *
 * The page's CSS, control-bar markup, and mode-switching JS below are extracted
 * verbatim from the pre-existing hand/agent-assembled docs/index.html (commit
 * range 8eedc19..d6e2cf5) and are not redesigned here — this script only
 * replaces *how the content is produced*, not what the page looks like.
 *
 * Determinism contract: given the same two markdown files, two runs of this
 * script must produce byte-identical output. Concretely, that means: no
 * timestamps, no random/generated ids, no reliance on unstable iteration
 * order — every byte of the output is a pure function of the markdown bytes.
 *
 * Usage:
 *   node build.mjs
 *     Reads the canonical docs/ sources and overwrites docs/index.html.
 *
 *   node build.mjs <en.md> <zh.md> <out.html>
 *     Overrides all three paths. Exists so the alignment check (see
 *     checkHeadingAlignment below) can be exercised against throwaway copies
 *     without ever touching the real paper sources or the real output file.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { marked } from 'marked';

const here = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(here, '..', '..'); // docs/tools/preview -> docs/tools -> docs

const DEFAULT_EN_PATH = join(docsDir, 'paper-context-economy-2026-07-07.md');
const DEFAULT_ZH_PATH = join(docsDir, 'paper-context-economy-2026-07-07_zh.md');
const DEFAULT_OUT_PATH = join(docsDir, 'index.html');

// Explicit, pinned parser options so behavior cannot silently drift with a
// future marked upgrade (the package.json dependency is also pinned exact).
marked.use({ gfm: true, breaks: false, pedantic: false });

function fail(message) {
  console.error(`[build] ${message}`);
  process.exit(1);
}

function readSource(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    fail(`cannot read ${label} source at ${path}: ${err.message}`);
  }
}

/**
 * Extract ATX headings (# .. ######) from a markdown document, skipping
 * anything inside fenced code blocks so a commented-out "#" in a code
 * sample is never mistaken for a heading.
 *
 * Fence tracking is intentionally simple (toggle on any line whose trimmed
 * text starts with three-or-more backticks or tildes): both paper sources
 * exclusively use plain ``` fences opened and closed on their own line, so
 * full CommonMark fence-matching (mixed markers/lengths) is not needed here.
 *
 * Returns an array of { level, title, lineNumber, lineIndex } in document order.
 */
function extractHeadings(source) {
  const lines = source.split('\n');
  const headings = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const match = /^(#{1,6})\s+(\S.*?)\s*$/.exec(line);
    if (match) {
      headings.push({
        level: match[1].length,
        title: match[2].trim(),
        lineNumber: i + 1,
        lineIndex: i,
      });
    }
  }

  return headings;
}

/**
 * Verify EN and ZH headings align 1:1 by level (title text is expected to
 * differ — it's a translation). On the first divergence, exits non-zero with
 * a message naming the exact line/heading on each side, per spec: "must exit
 * non-zero and point at the misalignment, never silently pad a missing
 * section."
 */
function checkHeadingAlignment(enHeadings, zhHeadings) {
  const n = Math.max(enHeadings.length, zhHeadings.length);

  const side = (heading, label, total, i) =>
    heading
      ? `${label} heading ${i + 1}/${total} at line ${heading.lineNumber}: ${'#'.repeat(heading.level)} ${heading.title}`
      : `${label} has only ${total} heading(s) total — no heading ${i + 1}`;

  for (let i = 0; i < n; i++) {
    const en = enHeadings[i];
    const zh = zhHeadings[i];
    if (!en || !zh || en.level !== zh.level) {
      fail(
        [
          `EN/ZH heading structure misaligned at position ${i + 1}.`,
          `  ${side(en, 'EN', enHeadings.length, i)}`,
          `  ${side(zh, 'ZH', zhHeadings.length, i)}`,
          'Fix the source markdown so heading levels correspond 1:1, in order, then re-run. ' +
            'This script never pads a missing section silently.',
        ].join('\n'),
      );
    }
  }
}

/**
 * Slice a markdown source into chunks at its H2 boundaries:
 *   chunk[0]   = everything before the first H2 (title + abstract-style blockquote)
 *   chunk[1..] = each H2 heading through (not including) the next H2, or EOF
 *
 * This is the granularity the side-by-side ("split") view pairs on: one row
 * per H2 section (with any nested H3s riding along inside that row), matching
 * the pre-existing page's structure.
 */
function sliceByH2(source, headings) {
  const lines = source.split('\n');
  const h2LineIndices = headings.filter((h) => h.level === 2).map((h) => h.lineIndex);

  if (h2LineIndices.length === 0) {
    return [source];
  }

  const chunks = [lines.slice(0, h2LineIndices[0]).join('\n')];
  for (let k = 0; k < h2LineIndices.length; k++) {
    const start = h2LineIndices[k];
    const end = k + 1 < h2LineIndices.length ? h2LineIndices[k + 1] : lines.length;
    chunks.push(lines.slice(start, end).join('\n'));
  }
  return chunks;
}

function renderSplitRows(enSource, zhSource, enHeadings, zhHeadings) {
  const enChunks = sliceByH2(enSource, enHeadings);
  const zhChunks = sliceByH2(zhSource, zhHeadings);

  // Guaranteed equal length by checkHeadingAlignment (same H2 count, same
  // relative positions); asserted defensively rather than trusted blindly.
  if (enChunks.length !== zhChunks.length) {
    fail(
      `internal error: EN produced ${enChunks.length} split chunks, ZH produced ${zhChunks.length}. ` +
        'This should be unreachable once heading alignment passed.',
    );
  }

  return enChunks
    .map((enChunk, i) => {
      const enHtml = marked.parse(enChunk).trim();
      const zhHtml = marked.parse(zhChunks[i]).trim();
      return `<section class="split-row"><div class="split-col">${enHtml}</div><div class="split-col">${zhHtml}</div></section>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Page skeleton — extracted verbatim from the pre-existing docs/index.html.
// Do not restyle; if the visual design ever changes, change it there and copy
// it back here, not the other way around.
// ---------------------------------------------------------------------------

const HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Deterministic Context Projection in an Agent Loop</title>
  <style>
    :root { --paper-width: 780px; --split-width: 1180px; --text: #111; --muted: #555; --rule: #bbb; --link: #0645ad; --shade: #f7f7f7; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #fff; color: var(--text); font-family: "Times New Roman", Times, serif; font-size: 12pt; line-height: 1.42; }
    .page { width: min(var(--paper-width), calc(100vw - 32px)); margin: 28px auto 56px; }
    .controls { display: flex; justify-content: center; gap: 6px; margin-bottom: 22px; font-family: Arial, Helvetica, sans-serif; font-size: 12px; }
    .controls button { border: 1px solid #999; background: #fff; color: #111; padding: 4px 9px; cursor: pointer; }
    .controls button[aria-pressed="true"] { background: #111; color: #fff; border-color: #111; }
    .paper[hidden] { display: none; }
    .paper h1 { margin: 0 0 10px; text-align: center; font-size: 22pt; line-height: 1.12; font-weight: 700; }
    .paper blockquote:first-of-type { margin: 0 auto 18px; max-width: 620px; text-align: center; color: var(--muted); border: 0; padding: 0; font-size: 11pt; font-style: normal; }
    .paper blockquote:first-of-type p { margin: 0.2em 0; }
    .paper h2 { margin: 1.45em 0 0.55em; padding-top: 0.35em; border-top: 1px solid var(--rule); font-size: 14pt; line-height: 1.2; font-weight: 700; }
    .paper h3 { margin: 1.15em 0 0.4em; font-size: 12.5pt; font-weight: 700; }
    .paper p { margin: 0 0 0.8em; }
    .paper a { color: var(--link); text-decoration: none; }
    .paper a:hover { text-decoration: underline; }
    .paper ul, .paper ol { margin: 0.35em 0 0.9em 1.3em; padding: 0; }
    .paper li { margin: 0.2em 0; }
    .paper blockquote { margin: 0.9em 0; padding-left: 1em; border-left: 2px solid var(--rule); color: #333; font-style: italic; }
    .paper code { font-family: Menlo, Consolas, "Courier New", monospace; font-size: 10pt; background: var(--shade); padding: 0 0.18em; }
    .paper pre { margin: 0.9em 0; padding: 0.75em; overflow-x: auto; border: 1px solid #ccc; background: var(--shade); font-size: 10pt; line-height: 1.35; }
    .paper pre code { background: transparent; padding: 0; }
    .paper table { width: 100%; border-collapse: collapse; margin: 0.9em 0 1.1em; font-size: 10.5pt; }
    .paper th, .paper td { border-top: 1px solid #999; border-bottom: 1px solid #ddd; padding: 0.35em 0.45em; text-align: left; vertical-align: top; }
    .paper th { font-weight: 700; background: #fafafa; }
    .paper hr { border: 0; border-top: 1px solid var(--rule); margin: 1.4em 0; }
    .paper .abstract-title { display: block; text-align: center; font-weight: 700; margin: 1em 0 0.45em; }
    body.mode-split .page { width: min(var(--split-width), calc(100vw - 32px)); }
    .split-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 28px; padding: 0.75em 0; border-bottom: 1px solid #e2e2e2; }
    .split-row:last-child { border-bottom: 0; }
    .split-col { min-width: 0; }
    .split-col h1 { font-size: 18pt; }
    .split-col h2 { font-size: 13pt; }
    @media (max-width: 860px) { body { font-size: 11.5pt; } .page { width: min(100% - 24px, var(--paper-width)); margin-top: 18px; } .controls { position: sticky; top: 0; background: #fff; padding: 8px 0; z-index: 2; } .split-row { grid-template-columns: 1fr; gap: 12px; } .split-col + .split-col { border-top: 1px dashed #ccc; padding-top: 0.9em; } }
    @media print { body { font-size: 11pt; } .page { width: auto; margin: 0; } .controls { display: none; } .paper h2 { break-after: avoid; } .paper table, .paper pre { break-inside: avoid; } .split-row { display: block; border-bottom: 0; } .split-col + .split-col { margin-top: 1em; } }
  </style>
</head>
<body>`;

const CONTROLS = `  <main class="page">
    <div class="controls" aria-label="Language view">
      <button type="button" data-mode="en" aria-pressed="true">English</button>
      <button type="button" data-mode="zh" aria-pressed="false">中文</button>
      <button type="button" data-mode="split" aria-pressed="false">Side by side</button>
    </div>`;

const TAIL = `  </main>
  <script>
    function setMode(mode) {
      document.body.classList.toggle('mode-split', mode === 'split');
      document.getElementById('paper-en').hidden = mode !== 'en';
      document.getElementById('paper-zh').hidden = mode !== 'zh';
      document.getElementById('paper-split').hidden = mode !== 'split';
      document.documentElement.lang = mode === 'zh' ? 'zh-CN' : 'en';
      document.querySelectorAll('.controls button').forEach(function(button) {
        button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
      });
    }
    document.querySelector('.controls').addEventListener('click', function(event) {
      var button = event.target.closest('button[data-mode]');
      if (button) setMode(button.dataset.mode);
    });
  </script>
</body>
</html>
`;

function assertNoScriptTerminator(source, label) {
  // The raw markdown is embedded verbatim inside a <script type="text/markdown">
  // data island (kept from the original page for provenance / view-source
  // transparency). A literal "</script" substring in the source would
  // truncate that tag early, so guard against it explicitly rather than
  // trust that no future revision ever introduces one.
  if (/<\/script/i.test(source)) {
    fail(`${label} source contains a literal "</script" sequence, which would break the embedded markdown data island. Aborting.`);
  }
}

function buildPage(enSource, zhSource, enHeadings, zhHeadings) {
  assertNoScriptTerminator(enSource, 'EN');
  assertNoScriptTerminator(zhSource, 'ZH');

  const enFullHtml = marked.parse(enSource).trim();
  const zhFullHtml = marked.parse(zhSource).trim();
  const splitHtml = renderSplitRows(enSource, zhSource, enHeadings, zhHeadings);

  return [
    HEAD,
    `  <script type="text/markdown" id="markdown-en">${enSource}</script>`,
    `  <script type="text/markdown" id="markdown-zh">${zhSource}</script>`,
    CONTROLS,
    `    <article class="paper" id="paper-en">${enFullHtml}</article>`,
    `    <article class="paper" id="paper-zh" lang="zh-CN" hidden>${zhFullHtml}</article>`,
    `    <article class="paper" id="paper-split" hidden>${splitHtml}</article>`,
    TAIL,
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  let enPath, zhPath, outPath;

  if (args.length === 0) {
    enPath = DEFAULT_EN_PATH;
    zhPath = DEFAULT_ZH_PATH;
    outPath = DEFAULT_OUT_PATH;
  } else if (args.length === 3) {
    [enPath, zhPath, outPath] = args.map((p) => resolve(p));
  } else {
    console.error('[build] usage: node build.mjs  (canonical docs/ paths)');
    console.error('     or: node build.mjs <en.md> <zh.md> <out.html>  (overrides, for tests)');
    process.exit(1);
    return;
  }

  const enSource = readSource(enPath, 'EN');
  const zhSource = readSource(zhPath, 'ZH');

  const enHeadings = extractHeadings(enSource);
  const zhHeadings = extractHeadings(zhSource);

  checkHeadingAlignment(enHeadings, zhHeadings);

  const html = buildPage(enSource, zhSource, enHeadings, zhHeadings);

  writeFileSync(outPath, html, 'utf8');
  console.log(
    `[build] wrote ${outPath} (${Buffer.byteLength(html, 'utf8')} bytes) from ` +
      `EN (${enHeadings.length} headings) + ZH (${zhHeadings.length} headings), ` +
      `${enHeadings.filter((h) => h.level === 2).length} H2 sections.`,
  );
}

main();
