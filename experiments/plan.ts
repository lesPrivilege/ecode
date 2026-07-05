/**
 * plan — print the manifest of runs to execute and where output lands, in the
 * spirit of taucode's dogfood-p0 `plan`. It does NOT call any provider itself; it
 * emits the paired `run` commands, the output-path manifest, the manual-fill
 * reminders, and aggressive-setting warnings.
 *
 * Pure: no pi imports, runs under plain node/tsx.
 *   node plan.ts --arms A,B,C,D --scenario refactor [--compact-after 32000] \
 *                [--keep-recent 3] [--out-dir results] [--sweep 4000,32000]
 *
 * Generalised from dogfood-p0 in two ways:
 *   - 2-way on/off  ->  4-arm A/B/C/D (see the arm table).
 *   - single --compact-after  ->  optional --sweep across the 4 required seam-A
 *     threshold values {4000,16000,32000,64000} for arm C (proves the sweep).
 */

const ARM_LABELS: Record<string, string> = {
	A: "native-off / no-hook (baseline)",
	B: "native-on / no-hook (pi default summariser)",
	C: "seam-A hook / seam-B off",
	D: "seam-A hook + seam-B checkpoint",
};

const SWEEP_ALLOWED = [4000, 16000, 32000, 64000];

interface Args {
	arms: string[];
	scenario: string;
	compactAfter: number;
	keepRecent: number;
	outDir: string;
	sweep: number[] | null;
	provider: string;
}

function parseArgs(argv: string[]): Args {
	const flags: Record<string, string | boolean> = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) flags[key] = true;
		else {
			flags[key] = next;
			i++;
		}
	}
	const list = (v: string | boolean | undefined, d: string[]) =>
		typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : d;
	const numList = (v: string | boolean | undefined) =>
		typeof v === "string" ? v.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)) : null;
	const asNum = (v: string | boolean | undefined, d: number) =>
		typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : d;
	return {
		arms: list(flags.arms, ["A", "B", "C", "D"]),
		scenario: typeof flags.scenario === "string" ? flags.scenario : "refactor",
		compactAfter: asNum(flags["compact-after"], 32000),
		keepRecent: asNum(flags["keep-recent"] ?? flags["keep-recent-assistant-messages"], 3),
		outDir: typeof flags["out-dir"] === "string" ? flags["out-dir"] : "results",
		sweep: numList(flags.sweep),
		provider: typeof flags.provider === "string" ? flags.provider : "mock",
	};
}

function quote(v: string): string {
	return /^[A-Za-z0-9_./:=,-]+$/.test(v) ? v : `'${v.replaceAll("'", "'\\''")}'`;
}

function runCmd(opts: {
	arm: string;
	scenario: string;
	compactAfter: number;
	keepRecent: number;
	provider: string;
	out: string;
}): string {
	const args = [
		"node --import ./lib/register.mjs run.ts",
		`--arm ${opts.arm}`,
		`--scenario ${quote(opts.scenario)}`,
		`--provider ${opts.provider}`,
		`--compact-after ${opts.compactAfter}`,
		`--keep-recent ${opts.keepRecent}`,
		`--out ${quote(opts.out)}`,
	];
	return args.join(" ");
}

function outPath(outDir: string, scenario: string, arm: string, suffix = ""): string {
	return `${outDir}/${scenario}-${arm}${suffix}.jsonl`;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const lines: string[] = [];
	const manifest: string[] = [];

	lines.push("# ecode experiments — run plan");
	lines.push("#");
	lines.push("# The planner does not call any provider. Run the commands below, then");
	lines.push("# fill the manual-review fields and run `compare`.");
	lines.push("#");
	lines.push(`mkdir -p ${quote(args.outDir)}`);
	lines.push("");

	// Per-arm runs.
	for (const arm of args.arms) {
		const label = ARM_LABELS[arm] ?? "unknown arm";
		if (!ARM_LABELS[arm]) {
			lines.push(`# WARNING: unknown arm "${arm}" (expected A, B, C, or D) — skipped`);
			continue;
		}
		const out = outPath(args.outDir, args.scenario, arm);
		lines.push(`## arm ${arm}: ${label}`);
		lines.push(
			runCmd({ arm, scenario: args.scenario, compactAfter: args.compactAfter, keepRecent: args.keepRecent, provider: args.provider, out }),
		);
		lines.push("");
		manifest.push(out);
	}

	// Sweep block (arm C across the required threshold values).
	if (args.sweep && args.sweep.length > 0) {
		lines.push("## sweep — arm C across compact-after values (proves the sweep mechanism)");
		for (const v of args.sweep) {
			if (!SWEEP_ALLOWED.includes(v)) {
				lines.push(`# WARNING: sweep value ${v} is outside the standard set {${SWEEP_ALLOWED.join(",")}}`);
			}
			const out = outPath(args.outDir, args.scenario, "C", `-ca${v}`);
			lines.push(
				runCmd({ arm: "C", scenario: args.scenario, compactAfter: v, keepRecent: args.keepRecent, provider: args.provider, out }),
			);
			manifest.push(out);
		}
		lines.push("");
	}

	// Compare invocation over everything produced. compare.ts imports sibling
	// `.ts` modules via `.js` specifiers, so it is run under the same register
	// hook (which rewrites `.js`->`.ts`); plain `node` would not resolve them.
	lines.push("## compare");
	lines.push(`node --import ./lib/register.mjs compare.ts ${manifest.map((m) => `--in ${quote(m)}`).join(" ")} --baseline A`);
	lines.push("");

	// Output manifest.
	lines.push("# Output manifest (files the runs will write):");
	for (const m of manifest) lines.push(`#   ${m}`);
	lines.push("");

	// Manual-fill reminders (mirrors dogfood-p0).
	lines.push("# Manual review fields to fill after the runs (per the tool's pattern):");
	lines.push("#   completion (per arm), quality (per arm), regressions, final_workspace_check");
	lines.push("");

	// Aggressive-setting warnings.
	if (args.keepRecent < 3) {
		lines.push("# WARNING: keep-recent < 3 is an aggressive stress setting, not the default.");
	}
	if (args.compactAfter > 0 && args.compactAfter < 16000) {
		lines.push("# WARNING: compact-after below 16000 is aggressive-stress territory, not the default.");
	}
	if (args.sweep) {
		for (const v of args.sweep) {
			if (v > 0 && v < 16000) {
				lines.push(`# WARNING: sweep value ${v} is aggressive-stress territory.`);
			}
		}
	}

	// eslint-disable-next-line no-console
	console.log(lines.join("\n"));
}

main();
