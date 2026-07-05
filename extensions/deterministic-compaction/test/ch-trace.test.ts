import { describe, expect, it } from "vitest";
import { CHTrace, renderCHStrip, sparkChar } from "../src/ch-trace.js";

describe("sparkChar", () => {
	it("maps 0 to lowest bar", () => {
		expect(sparkChar(0)).toBe("▁");
	});
	it("maps 1 to highest bar", () => {
		expect(sparkChar(1)).toBe("█");
	});
	it("maps 0.5 to a middle bar", () => {
		const c = sparkChar(0.5);
		expect("▁▂▃▄▅▆▇█").toContain(c);
		expect(c).not.toBe("▁");
		expect(c).not.toBe("█");
	});
});

describe("renderCHStrip", () => {
	it("shows placeholder when no samples", () => {
		expect(renderCHStrip([])).toEqual(["⟨CH⟩ —"]);
	});

	it("renders a single sample with percentage", () => {
		const lines = renderCHStrip([{ turn: 1, ratio: 0.95 }]);
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("⟨CH⟩");
		expect(lines[0]).toContain("95%");
	});

	it("shows · for null-ratio turns", () => {
		const lines = renderCHStrip([
			{ turn: 1, ratio: null },
			{ turn: 2, ratio: 0.8 },
		]);
		expect(lines[0]).toMatch(/^⟨CH⟩ ·./);
		expect(lines[0]).toContain("80%");
	});

	it("transition dip is visible in the sparkline", () => {
		const samples = [
			{ turn: 1, ratio: 0.95 },
			{ turn: 2, ratio: 0.96 },
			{ turn: 3, ratio: 0.30 },
			{ turn: 4, ratio: 0.90 },
			{ turn: 5, ratio: 0.95 },
		];
		const line = renderCHStrip(samples)[0];
		const bars = line.replace(/^⟨CH⟩ /, "").replace(/ \d+%$/, "");
		const chars = [...bars];
		expect(chars.length).toBe(5);
		const dip = chars[2];
		expect(sparkChar(0.30)).toBe(dip);
		expect(chars[0] > dip).toBe(true);
	});

	it("percentage reflects the LAST non-null ratio", () => {
		const samples = [
			{ turn: 1, ratio: 0.80 },
			{ turn: 2, ratio: null },
		];
		const line = renderCHStrip(samples)[0];
		expect(line).toContain("80%");
	});
});

describe("CHTrace", () => {
	it("records a turn with input and cacheRead", () => {
		const trace = new CHTrace(5);
		trace.record(1, 10000, 9500);
		const samples = trace.getSamples();
		expect(samples.length).toBe(1);
		expect(samples[0].turn).toBe(1);
		expect(samples[0].ratio).toBeCloseTo(0.95);
	});

	it("stores null ratio when cacheRead is undefined", () => {
		const trace = new CHTrace(5);
		trace.record(1, 10000, undefined);
		expect(trace.getSamples()[0].ratio).toBeNull();
	});

	it("stores null ratio when cacheRead is 0", () => {
		const trace = new CHTrace(5);
		trace.record(1, 10000, 0);
		expect(trace.getSamples()[0].ratio).toBeNull();
	});

	it("deduplicates same turn (first wins)", () => {
		const trace = new CHTrace(5);
		trace.record(1, 10000, 9500);
		trace.record(1, 10000, 5000);
		expect(trace.getSamples().length).toBe(1);
		expect(trace.getSamples()[0].ratio).toBeCloseTo(0.95);
	});

	it("evicts oldest when exceeding maxSamples", () => {
		const trace = new CHTrace(3);
		for (let i = 1; i <= 5; i++) {
			trace.record(i, 10000, 8000);
		}
		const samples = trace.getSamples();
		expect(samples.length).toBe(3);
		expect(samples[0].turn).toBe(3);
		expect(samples[2].turn).toBe(5);
	});

	it("clamps ratio to 1 when cacheRead exceeds input", () => {
		const trace = new CHTrace(5);
		trace.record(1, 5000, 6000);
		expect(trace.getSamples()[0].ratio).toBe(1);
	});
});
