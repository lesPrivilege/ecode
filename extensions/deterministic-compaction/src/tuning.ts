/**
 * DF2 — runtime tuning of the seam-A projection via the `/compaction` command.
 *
 * This module owns the four DF2 subcommands that extend DF1's `/compaction`
 * command (`set keep-recent=N`, `set compact-after=N`, `on`, `off`). It does NOT
 * register a command of its own — extension.ts adds these as branches inside
 * DF1's single `compaction` handler (pi rejects a duplicate command name, and a
 * second registration would silently shadow DF1's `telemetry on|off`). This file
 * is the parse + apply + record core those branches delegate to.
 *
 * ---------------------------------------------------------------------------
 * WHY A MUTABLE HOLDER (the "takes effect next turn" requirement)
 * ---------------------------------------------------------------------------
 * The seam-A `context` hook gates on `config.compactAfterInputTokens` and passes
 * `config.compactionOptions.keepRecentAssistantMessages` into compaction-core on
 * EVERY firing. DF1 already reads `observabilityState.config` live on each report
 * command, so if we mutate the FIELDS of that same `config` object, both the hook
 * and DF1's reports see the new value on the very next turn — no re-install, no
 * frozen capture. {@link TuningState} is a thin, typed view over exactly those
 * fields (plus the `on`/`off` master switch), mutated in place. This mirrors
 * DF1's `telemetryEnabled` closure variable, one level of indirection up.
 *
 * ---------------------------------------------------------------------------
 * PERSISTENCE ("写回 project settings", GOALS.md) — investigated, see report
 * ---------------------------------------------------------------------------
 * The `ExtensionAPI` and `ExtensionContext` expose NO settings read/write method
 * (verified against pi/packages/coding-agent/src/core/extensions/types.ts: the
 * context has sessionManager/modelRegistry/cwd/getContextUsage but nothing
 * settings-shaped; SettingsManager.withLock lives in pi core, is not handed to
 * extensions, and pi/ is out of bounds). The extension's own knobs are ALSO not
 * part of pi's `Settings` schema — they are env-var driven (`ECODE_*`) and read
 * once at factory time, so even a written settings value would not feed back in.
 *
 * Therefore the SOLID, TESTED core is the in-process runtime-mutable state above.
 * Persistence is provided as an explicitly best-effort, OPT-IN sidecar
 * ({@link persistTuning}) that writes a namespaced block to `<cwd>/.pi/settings.json`
 * so the operator's intent is at least durably recorded on disk; it is guarded,
 * never throws into the command path, and is NOT read back by this extension.
 * It is off unless a writer is supplied, so it cannot corrupt a real settings
 * file in tests or by default. See the DF2 report for the full reasoning.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { estimateAgentTokens, type ProjectionConfig } from "./projection.js";
import { appendAmbientRow, type AppendAmbientRowOptions, type AmbientTuningRow } from "./ambient-telemetry.js";

/** Default protection window, kept in sync with extension.ts's constant. */
export const DEFAULT_KEEP_RECENT_ASSISTANT_MSGS = 3;

/**
 * A mutable, typed view over the live projection knobs the seam-A hook reads.
 *
 * Backed by the SAME `ProjectionConfig` object `observabilityState.config` holds,
 * so mutating through this view is what makes a `/compaction set` take effect on
 * the next `context` firing (and keeps DF1's reports consistent). `enabled` is the
 * `on`/`off` master switch, held here because it has no home on `ProjectionConfig`.
 */
export class TuningState {
	/** Seam-A master switch. When false, the hook passes messages through unchanged. */
	private enabled = true;

	constructor(private readonly config: ProjectionConfig) {}

	/** True unless `/compaction off` disabled seam-A for this session. */
	isEnabled(): boolean {
		return this.enabled;
	}

	/** Current gate threshold (tokens). Mirrors `config.compactAfterInputTokens`. */
	getCompactAfter(): number {
		return this.config.compactAfterInputTokens;
	}

	/** Current protection window (assistant messages). Falls back to the default. */
	getKeepRecent(): number {
		return this.config.compactionOptions?.keepRecentAssistantMessages ?? DEFAULT_KEEP_RECENT_ASSISTANT_MSGS;
	}

	/** Set the master switch; returns true if the value actually changed. */
	setEnabled(next: boolean): boolean {
		if (this.enabled === next) return false;
		this.enabled = next;
		return true;
	}

	/** Set the gate threshold in place on the shared config; true if it changed. */
	setCompactAfter(next: number): boolean {
		if (this.config.compactAfterInputTokens === next) return false;
		this.config.compactAfterInputTokens = next;
		return true;
	}

	/**
	 * Set the protection window in place on the shared config; true if it changed.
	 * Materialises `compactionOptions` if DF1 never provided one.
	 */
	setKeepRecent(next: number): boolean {
		if (this.getKeepRecent() === next) return false;
		if (!this.config.compactionOptions) this.config.compactionOptions = {};
		this.config.compactionOptions.keepRecentAssistantMessages = next;
		return true;
	}
}

/** The `set` targets and their parsed value. */
type SetTarget = "keep-recent" | "compact-after";

/**
 * Parse one DF2 subcommand. Returns a discriminated result or `null` when the
 * argument is not a DF2 subcommand at all (so extension.ts can fall through to
 * DF1's `telemetry on|off` / usage). Deliberately strict so that bare `on`/`off`
 * (seam-A) never collides with DF1's `telemetry on`/`telemetry off` (telemetry):
 * DF2 owns EXACTLY `on`, `off`, `set keep-recent=N`, `set compact-after=N`, and
 * nothing with a leading `telemetry`.
 */
export type ParsedTuning =
	| { kind: "toggle"; enabled: boolean }
	| { kind: "set"; target: SetTarget; value: number }
	| { kind: "set-error"; message: string };

export function parseTuningCommand(arg: string): ParsedTuning | null {
	const trimmed = arg.trim().toLowerCase();

	// Seam-A master switch. EXACT match only — never matches "telemetry on/off"
	// (those have a leading token) so the two on/off families cannot be confused.
	if (trimmed === "on") return { kind: "toggle", enabled: true };
	if (trimmed === "off") return { kind: "toggle", enabled: false };

	if (!trimmed.startsWith("set ") && trimmed !== "set") return null;
	const rest = trimmed.slice(3).trim(); // after "set"
	if (rest === "") {
		return { kind: "set-error", message: "Usage: /compaction set keep-recent=N | set compact-after=N" };
	}

	const eq = rest.indexOf("=");
	if (eq < 0) {
		return { kind: "set-error", message: `Missing '=' in \`set ${rest}\`. Use \`set keep-recent=N\` or \`set compact-after=N\`.` };
	}
	const key = rest.slice(0, eq).trim();
	const rawValue = rest.slice(eq + 1).trim();

	let target: SetTarget;
	if (key === "keep-recent") target = "keep-recent";
	else if (key === "compact-after") target = "compact-after";
	else return { kind: "set-error", message: `Unknown setting \`${key}\`. Valid: keep-recent, compact-after.` };

	const value = Number(rawValue);
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
		return { kind: "set-error", message: `\`${key}\` needs a non-negative integer, got \`${rawValue}\`.` };
	}
	return { kind: "set", target, value };
}

/** Argument completions this module contributes to DF1's `/compaction` list. */
export const TUNING_COMPLETIONS: readonly string[] = ["on", "off", "set keep-recent=", "set compact-after="];

/** Reconstruct the live transcript from the session (RAW on-disk history). */
function transcript(ctx: ExtensionCommandContext): AgentMessage[] {
	const entries = ctx.sessionManager.getEntries();
	const messages: AgentMessage[] = [];
	for (const entry of entries) {
		if (entry.type === "message") messages.push((entry as { message: AgentMessage }).message);
	}
	return messages;
}

/**
 * Estimate current context tokens using the SAME estimator the seam-A gate uses
 * (pi's `estimateContextTokens`, via {@link estimateAgentTokens}). Returns null
 * if the transcript can't be read, so the tuning row records honest absence
 * rather than a fabricated zero. No new estimator is introduced.
 */
export function estimateContextTokensNow(ctx: ExtensionCommandContext): number | null {
	try {
		return estimateAgentTokens(transcript(ctx));
	} catch {
		return null;
	}
}

/** Injected writer + options for the tuning-row append (defaults to the real writer). */
export interface TuningTelemetry {
	write?: (row: AmbientTuningRow, opts?: AppendAmbientRowOptions) => string;
	writeOptions?: AppendAmbientRowOptions;
	/** Bumped when the ambient schema changes; passed through onto the row. */
	schemaFamily: string;
	schemaVersion: number;
}

/**
 * Append exactly ONE tuning row for a change that actually happened. Best-effort:
 * a write failure never breaks the command (local disk only, no network path).
 * Returns the file path written, or undefined on failure/no-write.
 */
export function recordTuningEvent(
	sessionId: string,
	setting: AmbientTuningRow["setting"],
	oldValue: number | boolean,
	newValue: number | boolean,
	contextTokens: number | null,
	telemetry: TuningTelemetry,
): string | undefined {
	const row: AmbientTuningRow = {
		type: "tuning",
		schema_family: telemetry.schemaFamily,
		schema_version: telemetry.schemaVersion,
		written_at: new Date().toISOString(),
		session_id: sessionId,
		setting,
		old_value: oldValue,
		new_value: newValue,
		context_tokens: contextTokens,
	};
	try {
		const write = telemetry.write ?? appendAmbientRow;
		return write(row, telemetry.writeOptions);
	} catch {
		return undefined;
	}
}

/**
 * Best-effort persistence of the current tuning knobs to `<cwd>/.pi/settings.json`
 * under a namespaced `deterministicCompaction` block. OPT-IN: extension.ts only
 * calls this when a settings sink is configured (never by default / in tests), so
 * a real settings file is untouched unless explicitly wired.
 *
 * This is a plain read-modify-write with no cross-process lock (pi's own locked
 * `SettingsManager.withLock` is not reachable from an extension). It is namespaced
 * so it cannot clobber pi's own keys, is wrapped so a malformed existing file
 * degrades to a no-op, and is NOT read back by this extension — it exists solely
 * to durably record operator intent per the GOALS.md "写回 project settings" note.
 * Returns the settings path on success, undefined on any failure.
 */
export interface PersistOptions {
	/** Project cwd; `<cwd>/.pi/settings.json` is the target. */
	cwd: string;
	/** Override the `.pi` dir name (defaults to ".pi"). */
	configDirName?: string;
}

export function persistTuning(state: TuningState, opts: PersistOptions): string | undefined {
	try {
		const dir = join(opts.cwd, opts.configDirName ?? ".pi");
		const settingsPath = join(dir, "settings.json");
		let current: Record<string, unknown> = {};
		if (existsSync(settingsPath)) {
			try {
				const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					current = parsed as Record<string, unknown>;
				}
			} catch {
				// Malformed existing settings: do NOT overwrite someone else's file.
				return undefined;
			}
		}
		current.deterministicCompaction = {
			enabled: state.isEnabled(),
			compactAfterInputTokens: state.getCompactAfter(),
			keepRecentAssistantMessages: state.getKeepRecent(),
		};
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(settingsPath, `${JSON.stringify(current, null, 2)}\n`, "utf-8");
		return settingsPath;
	} catch {
		return undefined;
	}
}
