/**
 * compare — read N run JSONL files (up to the 4 arms, plus sweep points),
 * compute deltas against the baseline arm, apply the codified invalid/suspicious
 * gates, and print a comparable report (human-readable table by default, or JSON
 * with --json). Generalises dogfood-p0's 2-file compare to N files.
 *
 * Pure: no pi imports.
 *   node compare.ts --in results/refactor-A.jsonl --in results/refactor-B.jsonl \
 *        --in results/refactor-C.jsonl --in results/refactor-D.jsonl \
 *        [--baseline A] [--json]
 *
 * The gates come from lib/gates.ts and are unit-tested independently
 * (test/gates.test.ts). compare only orchestrates + formats; it draws no
 * conclusions about whether any arm is "better".
 */

import { checkInvalid, checkSuspicious, type GateResult, type RunSummary } from "./lib/gates.js";
import { summarizeRun } from "./lib/read-run.js";

interface Args {
	inputs: string[];
	baseline: string;
	json: boolean;
}

function parseArgs(argv: string[]): Args {
	const inputs: string[] = [];
	let baseline = "A";
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--in" && argv[i + 1]) {
			inputs.push(argv[i + 1]);
			i++;
		} else if (a === "--baseline" && argv[i + 1]) {
			baseline = argv[i + 1];
			i++;
		} else if (a === "--json") {
			json = true;
		}
	}
	return { inputs, baseline, json };
}

interface RunReport {
	run: RunSummary;
	invalid: GateResult;
	suspicious: GateResult;
	delta: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		toolCalls: number;
		reReads: number;
		compactedPathReReads: number;
		compactedPathReReadRate: number | null;
	} | null;
}

function delta(run: RunSummary, base: RunSummary): RunReport["delta"] {
	const rateDelta =
		run.compactedPathReReadRate !== null && base.compactedPathReReadRate !== null
			? run.compactedPathReReadRate - base.compactedPathReReadRate
			: null;
	return {
		inputTokens: run.totalInputTokens - base.totalInputTokens,
		outputTokens: run.totalOutputTokens - base.totalOutputTokens,
		totalTokens: run.totalInputTokens + run.totalOutputTokens - (base.totalInputTokens + base.totalOutputTokens),
		toolCalls: run.totalToolCalls - base.totalToolCalls,
		reReads: run.totalReReads - base.totalReReads,
		compactedPathReReads: run.totalCompactedPathReReads - base.totalCompactedPathReReads,
		compactedPathReReadRate: rateDelta,
	};
}

function fmtInt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}
function fmtSigned(n: number): string {
	return (n >= 0 ? "+" : "") + fmtInt(n);
}
function fmtRate(r: number | null): string {
	return r === null ? "null" : r.toFixed(4);
}
function fmtCache(run: RunSummary): string {
	return run.cacheSignalPresent ? fmtInt(run.totalCacheReadTokens ?? 0) : "null (no signal)";
}

function dataLabel(runs: RunSummary[]): string {
	const providers = [...new Set(runs.map((r) => r.provider).filter(Boolean))].sort();
	const kinds = [...new Set(runs.map((r) => r.dataKind).filter(Boolean))].sort();
	if (providers.length === 1 && providers[0] === "mock") {
		return "SYNTHETIC SMOKE FIXTURES — numbers below are from mock-provider runs, not real workloads.";
	}
	const providerPart = providers.length > 0 ? providers.join(", ") : "unknown provider";
	const kindPart = kinds.length > 0 ? kinds.join(", ") : "unknown data kind";
	return `REAL WORKLOAD DATA — provider=${providerPart}; data_kind=${kindPart}.`;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.inputs.length === 0) {
		// eslint-disable-next-line no-console
		console.error("compare requires at least one --in <file.jsonl>");
		process.exit(1);
	}

	const runs = args.inputs.map(summarizeRun);

	// Pick the baseline run: first whose arm matches --baseline, else the first.
	const baseline = runs.find((r) => r.arm === args.baseline) ?? runs[0];

	const reports: RunReport[] = runs.map((run) => ({
		run,
		invalid: checkInvalid(run),
		suspicious: checkSuspicious(run, baseline),
		delta: run === baseline ? null : delta(run, baseline),
	}));

	if (args.json) {
		// eslint-disable-next-line no-console
		console.log(JSON.stringify({ baseline: baseline.arm, baseline_file: baseline.file, runs: reports }, null, 2));
		return;
	}

	const out: string[] = [];
	out.push(`# ecode experiments — comparison report`);
	out.push(`Baseline: arm ${baseline.arm} (${baseline.file})`);
	out.push(`Data: ${dataLabel(runs)}`);
	out.push("");

	// Side-by-side totals table.
	out.push("| Arm | File | Turns | Input | Output | Tools | Reads | Re-reads | Comp-path re-reads | Comp-path re-read rate | Cache read | Projected | Native |");
	out.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
	for (const r of reports) {
		const s = r.run;
		out.push(
			`| ${s.arm} | ${s.file} | ${fmtInt(s.turnCount)} | ${fmtInt(s.totalInputTokens)} | ${fmtInt(s.totalOutputTokens)} | ` +
				`${fmtInt(s.totalToolCalls)} | ${fmtInt(s.totalReadCalls)} | ${fmtInt(s.totalReReads)} | ${fmtInt(s.totalCompactedPathReReads)} | ` +
				`${fmtRate(s.compactedPathReReadRate)} | ${fmtCache(s)} | ${fmtInt(s.projectedTurnCount)} | ${fmtInt(s.nativeCompactionsObserved)} |`,
		);
	}
	out.push("");

	// Deltas vs baseline.
	out.push(`## Deltas vs. arm ${baseline.arm}`);
	out.push("| Arm | Δ total tokens | Δ input | Δ output | Δ tools | Δ re-reads | Δ comp-path re-reads | Δ rate |");
	out.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
	for (const r of reports) {
		if (!r.delta) {
			out.push(`| ${r.run.arm} | (baseline) | | | | | | |`);
			continue;
		}
		const d = r.delta;
		out.push(
			`| ${r.run.arm} | ${fmtSigned(d.totalTokens)} | ${fmtSigned(d.inputTokens)} | ${fmtSigned(d.outputTokens)} | ` +
				`${fmtSigned(d.toolCalls)} | ${fmtSigned(d.reReads)} | ${fmtSigned(d.compactedPathReReads)} | ` +
				`${d.compactedPathReReadRate === null ? "null" : (d.compactedPathReReadRate >= 0 ? "+" : "") + d.compactedPathReReadRate.toFixed(4)} |`,
		);
	}
	out.push("");

	// Gate flags.
	out.push("## Gate flags");
	for (const r of reports) {
		const flags: string[] = [];
		if (r.invalid.triggered) flags.push(`INVALID [${r.invalid.reasons.join("; ")}]`);
		if (r.suspicious.triggered) flags.push(`SUSPICIOUS [${r.suspicious.reasons.join("; ")}]`);
		out.push(`- arm ${r.run.arm} (${r.run.file}): ${flags.length ? flags.join("  ") : "clean (no gate triggered)"}`);
	}
	out.push("");

	// Manual review slots (per dogfood-p0 pattern). Disambiguate by file since the
	// same arm can appear multiple times (e.g. sweep points of arm C).
	out.push("## Manual review (fill in)");
	for (const r of reports) out.push(`- completion[${r.run.arm} / ${r.run.file}]:`);
	out.push("- regressions:");
	out.push("- final_workspace_check:");

	// eslint-disable-next-line no-console
	console.log(out.join("\n"));
}

main();
