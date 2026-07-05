/**
 * Unit tests for the compaction gate widget.
 *
 * Tests that {@link renderGateWidget} produces the expected strip strings for
 * each gate state. The render function is a pure function of the module-level
 * {@link gateStatus} holder — no TUI, no mock provider, no session needed.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { gateStatus, renderGateWidget } from "../src/gate-widget.js";

beforeEach(() => {
	// Reset to default no-data state before every test.
	gateStatus.rawTokens = null;
	gateStatus.threshold = 32000;
	gateStatus.triggerState = "no_data";
	gateStatus.lastSavedTokens = null;
	gateStatus.lastSavedPct = null;
});

describe("gate widget render", () => {
	it("no-data state (rawTokens === null)", () => {
		gateStatus.rawTokens = null;
		gateStatus.triggerState = "no_data";
		const lines = renderGateWidget(80);
		expect(lines).toEqual(["⟨compaction⟩ gate — / — compactable · —"]);
	});

	it("no-data state even when triggerState is stale-active but rawTokens null", () => {
		// Guard: the no-data branch checks BOTH rawTokens === null and
		// triggerState === "no_data", so a stale active state with null
		// tokens still shows the no-data placeholder.
		gateStatus.rawTokens = null;
		gateStatus.triggerState = "active";
		const lines = renderGateWidget(80);
		expect(lines).toEqual(["⟨compaction⟩ gate — / — compactable · —"]);
	});

	it("waiting state (raw below threshold)", () => {
		gateStatus.rawTokens = 500;
		gateStatus.threshold = 999;
		gateStatus.triggerState = "waiting";
		const lines = renderGateWidget(80);
		expect(lines).toEqual(["⟨compaction⟩ gate 500 / 999 compactable · waiting"]);
	});

	it("active state without prior savings", () => {
		gateStatus.rawTokens = 999;
		gateStatus.threshold = 500;
		gateStatus.triggerState = "active";
		// lastSavedTokens remains null
		const lines = renderGateWidget(80);
		expect(lines).toEqual(["⟨compaction⟩ gate 999 / 500 compactable · active"]);
	});

	it("active state with last-replacement savings", () => {
		gateStatus.rawTokens = 999;
		gateStatus.threshold = 500;
		gateStatus.triggerState = "active";
		gateStatus.lastSavedTokens = 123;
		gateStatus.lastSavedPct = 12;
		const lines = renderGateWidget(80);
		expect(lines).toEqual([
			"⟨compaction⟩ gate 999 / 500 compactable · active · last −123 (12%)",
		]);
	});

	it("off state (seam-A disabled via /compaction off)", () => {
		gateStatus.rawTokens = 999;
		gateStatus.threshold = 500;
		gateStatus.triggerState = "off";
		const lines = renderGateWidget(80);
		expect(lines).toEqual(["⟨compaction⟩ gate 999 / 500 compactable · off"]);
	});

	it("uses toLocaleString for thousand-separator formatting", () => {
		// Numbers >= 1000 produce locale-specific separators. We verify the
		// rendered string contains the formatted values (locale-agnostic test
		// by constructing the expected string with the same formatter).
		const fmt = (n: number): string => n.toLocaleString();
		gateStatus.rawTokens = 35000;
		gateStatus.threshold = 32000;
		gateStatus.triggerState = "active";
		gateStatus.lastSavedTokens = 4200;
		gateStatus.lastSavedPct = 12;
		const lines = renderGateWidget(80);
		const expected = `⟨compaction⟩ gate ${fmt(35000)} / ${fmt(32000)} compactable · active · last −${fmt(4200)} (12%)`;
		expect(lines).toEqual([expected]);
	});
});
