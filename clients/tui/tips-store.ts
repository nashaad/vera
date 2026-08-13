/**
 * Where tip history lives: `~/.vera/tips.json`.
 *
 * Two fields, both counters. `launches` increments once per TUI start and is
 * the clock every cooldown is measured against, so a cooldown of five means
 * five starts rather than five minutes: a long-lived session does not
 * re-earn a tip by staying open, and a user who opens Vera twice a day does
 * not see the same line twice a day.
 *
 * A missing or unreadable file reads as an empty history. Tips are a
 * convenience, so nothing here may fail a start, and every write is
 * best-effort for the same reason.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { TuiTipHistory } from "./tips.ts";
import { veraProfileDirectory } from "../../src/profile-paths.ts";

export interface TuiTipState {
    readonly launches: number;
    readonly history: TuiTipHistory;
}

const EMPTY: TuiTipState = { launches: 0, history: {} };

export function defaultTuiTipsPath(): string {
    return join(veraProfileDirectory(), "tips.json");
}

export function loadTuiTipState(
    path: string = defaultTuiTipsPath(),
): TuiTipState {
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        return EMPTY;
    }
    if (typeof parsed !== "object" || parsed === null) return EMPTY;
    const value = parsed as Record<string, unknown>;
    const launches = typeof value.launches === "number"
            && Number.isFinite(value.launches)
        ? Math.max(0, Math.floor(value.launches))
        : 0;
    const raw = typeof value.history === "object" && value.history !== null
        ? value.history as Record<string, unknown>
        : {};
    const history: Record<string, number> = {};
    for (const [id, shown] of Object.entries(raw)) {
        if (typeof shown === "number" && Number.isFinite(shown)) {
            history[id] = shown;
        }
    }
    return { launches, history };
}

/** The state for this run, with the launch counter already advanced. */
export function beginTuiTipLaunch(
    path: string = defaultTuiTipsPath(),
): TuiTipState {
    const previous = loadTuiTipState(path);
    const next: TuiTipState = {
        launches: previous.launches + 1,
        history: previous.history,
    };
    saveTuiTipState(next, path);
    return next;
}

export function saveTuiTipState(
    state: TuiTipState,
    path: string = defaultTuiTipsPath(),
): void {
    try {
        mkdirSync(dirname(path), { recursive: true });
        // Written beside the target and moved into place: a start that dies
        // mid-write leaves the previous history rather than a truncated file
        // that would read as no history at all.
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(state, null, 4)}\n`, "utf8");
        renameSync(temporary, path);
    } catch {
        // History is an optimization. Losing it costs a repeated tip.
    }
}
