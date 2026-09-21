import { blendHex } from "./blend-hex.ts";

// 0 is off: nothing on screen moves.
export type TuiAnimationLevel = 0 | 1 | 2 | 3;

export const DEFAULT_ANIMATION_LEVEL: TuiAnimationLevel = 2;

export type TuiActivityKind = "waiting" | "thinking" | "reading" | "running" | "writing";

export const ACTIVITY_BAR_FRAME_MS = 60;

const LEVEL_WIDTH: Readonly<Record<TuiAnimationLevel, number>> = { 0: 1, 1: 1, 2: 6, 3: 8 };
const LEVEL_SPEED: Readonly<Record<TuiAnimationLevel, number>> = { 0: 1, 1: 1, 2: 1, 3: 1.8 };

const READING_TOOLS = new Set(["read", "grep", "list", "web_fetch", "web_download", "catalog_search"]);
const WRITING_TOOLS = new Set(["edit", "write"]);

export function isTuiAnimationLevel(value: unknown): value is TuiAnimationLevel {
    return value === 0 || value === 1 || value === 2 || value === 3;
}

// `activity` is the pane's phrase: "thinking", "responding", "running <tool>", ...
// "thinking" before any reasoning token arrives is the model not answering yet.
export function tuiActivityKind(activity: string, reasoning: boolean): TuiActivityKind {
    if (activity === "responding") return "writing";
    if (activity.startsWith("running ")) {
        const tool = activity.slice("running ".length);
        if (READING_TOOLS.has(tool)) return "reading";
        if (WRITING_TOOLS.has(tool)) return "writing";
        return "running";
    }
    return reasoning ? "thinking" : "waiting";
}

export function tuiActivityBarColumns(level: TuiAnimationLevel): number {
    return LEVEL_WIDTH[level];
}

const SHADES = ["░", "▒", "▓", "█"] as const;
const RISE = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const FILL = ["▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const;

const STILL: Readonly<Record<TuiActivityKind, string>> = {
    waiting: "▓",
    thinking: "▒",
    reading: "▚",
    running: "▄",
    writing: "▌",
};

export interface TuiActivityBarCell {
    readonly glyph: string;
    readonly color: string;
}

type Cell = readonly [glyph: string, strength: number];

function wave(index: number, frame: number, width: number, speed: number, spread: number): number {
    const head = (frame * speed) % (width + spread * 2) - spread;
    const distance = Math.abs(index - head);
    return distance > spread ? 0 : 0.5 * (1 + Math.cos(Math.PI * distance / spread));
}

function cell(kind: TuiActivityKind, index: number, frame: number, width: number): Cell {
    if (kind === "thinking") {
        const strength = Math.max(wave(index, frame, width, 0.2, 3), 0.15);
        return [SHADES[Math.min(3, Math.floor(strength * 4))]!, strength];
    }
    if (kind === "reading") {
        const behind = (frame * 0.12) % (width + 3) - index;
        if (behind >= 0 && behind < 1) return ["▚", 1];
        if (behind >= 1 && behind < 3) return ["▖", 0.45 - (behind - 1) * 0.15];
        return ["·", 0.12];
    }
    if (kind === "running") {
        const strength = 0.5 + 0.5 * Math.sin(frame * 0.35 + index * 0.9) * Math.sin(frame * 0.11 + index * 0.4);
        return [RISE[Math.min(7, Math.floor(strength * 8))]!, 0.35 + strength * 0.65];
    }
    if (kind === "writing") {
        const behind = (frame * 0.4) % (width + 4) - index;
        if (behind >= 1) return ["█", 0.35 + 0.65 * Math.max(0, 1 - (behind - 1) / 6)];
        if (behind > 0) return [FILL[Math.floor(behind * 8)]!, 1];
        return [" ", 0];
    }
    return ["▓", 0.55 + 0.45 * Math.sin(frame * 0.08)];
}

// Level 0 is one still glyph; level 1 is that glyph breathing in colour only.
export function renderTuiActivityBar(
    kind: TuiActivityKind,
    level: TuiAnimationLevel,
    nowMs: number,
    colors: { readonly active: string; readonly dim: string },
): TuiActivityBarCell[] {
    const frame = nowMs / ACTIVITY_BAR_FRAME_MS;
    if (level === 0) return [{ glyph: STILL[kind], color: colors.active }];
    if (level === 1) {
        return [{ glyph: STILL[kind], color: blendHex(colors.dim, colors.active, 0.6 + 0.4 * Math.sin(frame * 0.08)) }];
    }
    const width = LEVEL_WIDTH[level];
    const cells: TuiActivityBarCell[] = [];
    for (let index = 0; index < width; index += 1) {
        const [glyph, strength] = cell(kind, index, frame * LEVEL_SPEED[level], width);
        cells.push({ glyph, color: blendHex(colors.dim, colors.active, strength) });
    }
    return cells;
}
