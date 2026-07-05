/**
 * S3 — cache-hit ratio trace (DF-TUI).
 *
 * Session-scoped ring buffer of per-turn CH ratios, rendered as an ASCII
 * sparkline strip. Wired in extension.ts from message_end — the assistant
 * message's usage carries both input and cacheRead (pi Usage type).
 */

const SPARK = "▁▂▃▄▅▆▇█";

export interface CHSample {
	turn: number;
	/** 0–1 ratio; null when provider didn't report cacheRead. */
	ratio: number | null;
}

export class CHTrace {
	private readonly maxSamples: number;
	private readonly samples: CHSample[] = [];
	private lastRecordedTurn = -1;

	constructor(maxSamples = 10) {
		this.maxSamples = maxSamples;
	}

	record(turn: number, inputTokens: number, cacheRead: number | undefined): void {
		if (turn === this.lastRecordedTurn) return;
		this.lastRecordedTurn = turn;
		const ratio =
			cacheRead !== undefined && cacheRead > 0 && inputTokens > 0
				? Math.min(cacheRead / inputTokens, 1)
				: null;
		this.samples.push({ turn, ratio });
		if (this.samples.length > this.maxSamples) {
			this.samples.shift();
		}
	}

	getSamples(): readonly CHSample[] {
		return this.samples;
	}
}

export function sparkChar(ratio: number): string {
	const idx = Math.min(Math.round(ratio * (SPARK.length - 1)), SPARK.length - 1);
	return SPARK[idx];
}

let chWidgetRegistered = false;

export function registerCHWidget(
	ui: { setWidget: (id: string, factory: () => { render: () => string[]; height: number }) => void },
	trace: CHTrace,
): void {
	if (chWidgetRegistered) return;
	ui.setWidget("compaction-ch", () => ({
		render: () => renderCHStrip(trace.getSamples()),
		get height() { return 1; },
	}));
	chWidgetRegistered = true;
}

export function renderCHStrip(samples: readonly CHSample[]): string[] {
	if (samples.length === 0) return ["⟨CH⟩ —"];
	let bar = "";
	let lastRatio: number | null = null;
	for (const s of samples) {
		if (s.ratio === null) {
			bar += "·";
		} else {
			bar += sparkChar(s.ratio);
			lastRatio = s.ratio;
		}
	}
	const pct = lastRatio !== null ? ` ${Math.round(lastRatio * 100)}%` : "";
	return [`⟨CH⟩ ${bar}${pct}`];
}
