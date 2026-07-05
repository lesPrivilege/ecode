/**
 * Registry of synthetic smoke fixtures. run.ts resolves a scenario by id from
 * here. These are TEST FIXTURES (harness-proving), never real G2 workloads.
 */

import type { Scenario } from "../lib/scenario.js";
import { scenarioRefactor } from "./scenario-refactor.js";

export const SCENARIOS: Record<string, Scenario> = {
	refactor: scenarioRefactor,
};

export function getScenario(id: string): Scenario {
	const s = SCENARIOS[id];
	if (!s) {
		const known = Object.keys(SCENARIOS).join(", ");
		throw new Error(`Unknown scenario "${id}". Known fixtures: ${known}`);
	}
	return s;
}

export const DEFAULT_SCENARIO_ID = "refactor";
