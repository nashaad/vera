import { useSyncExternalStore } from "react";

import type { DesktopEvent } from "../protocol/bridge.ts";

export type OutputKind = "info" | "warning" | "error";

export interface OutputEntry {
    readonly id: number;
    readonly time: number;
    readonly kind: OutputKind;
    readonly text: string;
}

export const OUTPUT_CAP = 200;
const MAX_TEXT_LENGTH = 2_000;

// The desktop's own connection log, kept in memory and capped.
export class OutputLog {
    private entries: readonly OutputEntry[] = [];
    private nextId = 1;
    private readonly listeners = new Set<() => void>();

    constructor(private readonly cap = OUTPUT_CAP, private readonly clock: () => number = Date.now) {}

    append(kind: OutputKind, text: string): void {
        const last = this.entries[this.entries.length - 1];
        if (last !== undefined && last.kind === kind && last.text === text) return;
        const entry: OutputEntry = {
            id: this.nextId,
            time: this.clock(),
            kind,
            text: text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}...` : text,
        };
        this.nextId += 1;
        const kept = this.entries.length >= this.cap ? this.entries.slice(this.entries.length - this.cap + 1) : this.entries;
        this.entries = [...kept, entry];
        this.changed();
    }

    clear(): void {
        if (this.entries.length === 0) return;
        this.entries = [];
        this.changed();
    }

    // The same array until the log changes.
    snapshot = (): readonly OutputEntry[] => this.entries;

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    private changed(): void {
        for (const listener of [...this.listeners]) listener();
    }
}

export function useOutputLog(log: OutputLog): readonly OutputEntry[] {
    return useSyncExternalStore(log.subscribe, log.snapshot);
}

export interface OutputLine {
    readonly kind: OutputKind;
    readonly text: string;
}

// Frames are protocol traffic, not log lines; commands are layout, not connection.
export function describeEvent(event: DesktopEvent): OutputLine | undefined {
    switch (event.type) {
        case "phase":
            return {
                kind: "info",
                text: event.phase === "starting"
                    ? "Starting the host for this home."
                    : event.phase === "waiting"
                        ? "Another Vera is starting this home. Waiting for it."
                        : "Attached.",
            };
        case "ready":
            return {
                kind: "info",
                text: `Attached to host ${event.pid}, build ${event.buildId === null ? "unknown" : event.buildId.slice(0, 7)}, home ${event.home}.`,
            };
        case "question":
            return { kind: "warning", text: `Vera asked: ${event.text}` };
        case "disconnected":
            return { kind: "warning", text: `Connection lost: ${event.reason}` };
        case "failed":
            return { kind: "error", text: `Start failed: ${event.message}` };
        case "missing_cli":
            return { kind: "error", text: event.message };
        case "frame":
        case "window_shown":
        case "command":
            return undefined;
    }
}
