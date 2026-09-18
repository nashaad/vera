import { readSessionSnapshot } from "../../src/store/session-store.ts";
import {
    projectTranscript,
    type TranscriptEntry,
} from "../../src/engine/protocol.ts";
import { unchanged, wrappedTo } from "./settings-picker-model.ts";
import { tuiBindingId } from "./keymap.ts";
import type {
    TuiSettingsPickerKey,
    TuiSettingsPickerOption,
    TuiSettingsPickerState,
    TuiSettingsPickerTransition,
} from "./settings-picker-types.ts";

export const SESSION_PREVIEW_TURN_LIMIT = 12;

export const SESSION_PREVIEW_LOADING = "Reading conversation…";

export const SESSION_PREVIEW_EMPTY = "No messages to preview.";

export interface TuiSessionPreviewTurn {
    readonly speaker: "You" | "Vera";
    readonly text: string;
}

export function isSessionSpaceKey(key: TuiSettingsPickerKey): boolean {
    return key.ctrl !== true
        && key.meta !== true
        && (key.name === "space" || key.name === " ");
}

export function sessionPickerOwnsKey(
    state: TuiSettingsPickerState,
    key: TuiSettingsPickerKey,
): boolean {
    const command = tuiBindingId("session_picker", key);
    if (command === "preview_session" || isSessionSpaceKey(key)) {
        return state.query.length === 0;
    }
    return command !== undefined;
}

export function startSessionPreview(
    parent: TuiSettingsPickerState,
    option: TuiSettingsPickerOption,
): TuiSettingsPickerTransition {
    return {
        state: {
            kind: "session_preview",
            title: option.label,
            allOptions: [],
            options: [],
            selectedIndex: 0,
            query: "",
            parent,
            previewSessionPath: option.value,
            previewLines: [SESSION_PREVIEW_LOADING],
            previewScroll: 0,
            loading: true,
            ...(parent.nothingToLeave === true ? { nothingToLeave: true } : {}),
        },
        handled: true,
        previewSession: { path: option.value },
    };
}

export function handleSessionPreviewKey(
    state: TuiSettingsPickerState,
    key: TuiSettingsPickerKey,
    viewportRows?: number,
): TuiSettingsPickerTransition | undefined {
    if (state.kind !== "session_preview") return undefined;
    if (key.ctrl || key.meta || key.super || key.hyper) {
        return unchanged(state, false);
    }
    if (key.name === "escape" || key.name === "esc") {
        return undefined;
    }
    if (key.name === "up" || key.name === "down") {
        return {
            state: scrolledSessionPreview(
                state,
                key.name === "up" ? -1 : 1,
                viewportRows ?? 8,
            ),
            handled: true,
        };
    }
    if (key.name === "return" || key.name === "enter") {
        return state.parent === undefined
            ? unchanged(state, true)
            : undefined;
    }
    return unchanged(state, true);
}

export function scrolledSessionPreview(
    state: TuiSettingsPickerState,
    delta: number,
    viewportRows: number,
): TuiSettingsPickerState {
    const lines = state.previewLines ?? [];
    const max = Math.max(0, lines.length - Math.max(1, viewportRows));
    const previewScroll = Math.max(
        0,
        Math.min(max, (state.previewScroll ?? 0) + delta),
    );
    return previewScroll === (state.previewScroll ?? 0)
        ? state
        : { ...state, previewScroll };
}

export async function readSessionPreview(
    path: string,
): Promise<readonly string[]> {
    const snapshot = await readSessionSnapshot(path);
    return sessionPreviewLines(projectTranscript(
        snapshot.messages,
        undefined,
        snapshot.messageIds,
        snapshot.harnessMessages,
    ));
}

export function sessionPreviewTurns(
    entries: readonly TranscriptEntry[],
): readonly TuiSessionPreviewTurn[] {
    const turns: TuiSessionPreviewTurn[] = [];
    for (const entry of entries) {
        if (entry.kind !== "user" && entry.kind !== "assistant") continue;
        turns.push({
            speaker: entry.kind === "user" ? "You" : "Vera",
            text: entry.text,
        });
    }
    return turns.slice(-SESSION_PREVIEW_TURN_LIMIT);
}

export function sessionPreviewLines(
    entries: readonly TranscriptEntry[],
): readonly string[] {
    const turns = sessionPreviewTurns(entries);
    if (turns.length === 0) return [SESSION_PREVIEW_EMPTY];
    const lines: string[] = [];
    for (const [index, turn] of turns.entries()) {
        if (index > 0) lines.push("");
        lines.push(turn.speaker);
        const body = turn.text.length === 0 ? ["(empty)"] : turn.text.split("\n");
        lines.push(...body);
    }
    return lines;
}

export function sessionPreviewWindow(
    lines: readonly string[],
    scroll: number,
    rows: number,
    width: number,
): readonly SessionPreviewDisplayLine[] {
    const wrapped = lines.flatMap((line, index) => {
        const tone = previewLineTone(line, lines[index - 1]);
        if (line === "") return [{ tone: "blank" as const, text: "" }];
        const parts = wrappedTo(line, Math.max(1, width));
        return (parts.length === 0 ? [line] : parts).map((text) => ({
            tone,
            text,
        }));
    });
    const start = Math.max(0, Math.min(scroll, Math.max(0, wrapped.length - rows)));
    return wrapped.slice(start, start + Math.max(1, rows));
}

export interface SessionPreviewDisplayLine {
    readonly tone: "speaker" | "body" | "blank";
    readonly text: string;
}

function previewLineTone(
    line: string,
    previous: string | undefined,
): SessionPreviewDisplayLine["tone"] {
    if (line === "") return "blank";
    if (
        (line === "You" || line === "Vera")
        && (previous === undefined || previous === "")
    ) {
        return "speaker";
    }
    return "body";
}
