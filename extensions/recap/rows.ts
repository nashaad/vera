import type { VeraClientPickerRow, VeraClientRevealTarget } from "../../src/sdk/extensions.ts";
import type { RecapMark, RecapMarkKind, RecapPhase } from "./model.ts";

const MARK_GLYPH: Readonly<Record<RecapMarkKind, string>> = {
    aside: "↳",
    commit: "●",
    question: "?",
    long_step: "⏱",
    failure: "✕",
};

const MARK_INDENT = "  ";
const NO_CLOCK = "--:--";
const MAX_LISTED_FILES = 6;

export interface RecapRow extends VeraClientPickerRow {
    readonly target: VeraClientRevealTarget;
}

export type ClockFormat = (epochMs: number) => string;

export function localClock(epochMs: number): string {
    const date = new Date(epochMs);
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function recapRows(phases: readonly RecapPhase[], clock: ClockFormat = localClock): RecapRow[] {
    return phases.flatMap((phase, phaseIndex) => {
        const heading = phase.startedAt === undefined ? NO_CLOCK : clock(phase.startedAt);
        return [
            { ...phaseRow(phase, `phase-${phaseIndex}`, clock), heading, group: `phase-${phaseIndex}` },
            ...phase.marks.map((mark, markIndex) => ({
                ...markRow(mark, `phase-${phaseIndex}-${markIndex}`, clock), heading, group: `phase-${phaseIndex}`,
            })),
        ];
    });
}

export function recapSubtitle(phases: readonly RecapPhase[]): string {
    const activeMs = phases.reduce((sum, phase) => sum + phase.activeMs, 0);
    const count = `${phases.length} ${phases.length === 1 ? "phase" : "phases"}`;
    return `${count} · ${formatDuration(activeMs)} working`;
}

function phaseRow(phase: RecapPhase, id: string, clock: ClockFormat): RecapRow {
    const outcome = phase.tests === "passed" ? " ✓" : phase.tests === "failed" ? " ✗" : "";
    const meta = phase.running ? "running" : `${formatDuration(phase.activeMs)}${outcome}`;
    return { id, label: phase.title, meta, details: phaseDetails(phase, clock), target: phase.target };
}

function markRow(mark: RecapMark, id: string, clock: ClockFormat): RecapRow {
    const meta = mark.kind === "commit"
        ? mark.ref
        : mark.durationMs === undefined
        ? undefined
        : mark.kind === "question"
        ? `waited ${formatDuration(mark.durationMs)}`
        : formatDuration(mark.durationMs);
    return {
        id,
        label: `${MARK_INDENT}${MARK_GLYPH[mark.kind]} ${mark.text}`,
        ...(meta === undefined ? {} : { meta }),
        details: markDetails(mark, clock),
        target: mark.target,
    };
}

function phaseDetails(phase: RecapPhase, clock: ClockFormat): string[] {
    const lines = [phase.title, ""];
    const started = phase.startedAt === undefined ? "" : `Started ${clock(phase.startedAt)} · `;
    lines.push(`${started}${phase.running ? "still running" : formatDuration(phase.activeMs)}`);
    const files = phase.editedPaths.length;
    lines.push(`${phase.toolCalls} tool ${phase.toolCalls === 1 ? "call" : "calls"} · ${files} ${files === 1 ? "file" : "files"} edited`);
    if (phase.tests !== undefined) lines.push(phase.tests === "passed" ? "Tests passed ✓" : "Tests failed ✗");
    if (files > 0) {
        lines.push("");
        lines.push(...phase.editedPaths.slice(0, MAX_LISTED_FILES));
        if (files > MAX_LISTED_FILES) lines.push(`+${files - MAX_LISTED_FILES} more`);
    }
    return lines;
}

function markDetails(mark: RecapMark, clock: ClockFormat): string[] {
    const when = mark.at === undefined ? [] : [`At ${clock(mark.at)}`];
    if (mark.kind === "commit") return [`Committed ${mark.ref ?? ""}`.trim(), mark.text, "", ...when];
    if (mark.kind === "question") {
        const waited = mark.durationMs === undefined ? [] : [`Waited ${formatDuration(mark.durationMs)} for your answer`];
        return ["Asked you", mark.text, "", ...when, ...waited];
    }
    if (mark.kind === "long_step") return ["Long step", mark.text, "", ...when];
    if (mark.kind === "aside") return ["Side question", mark.text, "", ...when];
    return [mark.text, "", ...when];
}

export function formatDuration(ms: number): string {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
