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

// A "thinking" phase with no reasoning tokens reads as waiting until it has lasted this long.
export const QUIET_THINKING_AFTER_MS = 2_000;

// `activity` is the pane's phrase: "thinking", "responding", "running <tool>", ...
// `quietMs` is how long ago the latest request went out.
export function tuiActivityKind(activity: string, reasoning: boolean, quietMs: number): TuiActivityKind {
    if (activity === "responding") return "writing";
    if (activity.startsWith("running ")) {
        const tool = activity.slice("running ".length);
        if (READING_TOOLS.has(tool)) return "reading";
        if (WRITING_TOOLS.has(tool)) return "writing";
        return "running";
    }
    if (reasoning) return "thinking";
    return activity === "thinking" && quietMs > QUIET_THINKING_AFTER_MS ? "thinking" : "waiting";
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

export interface ReadingPass {
    readonly start: number;
    readonly length: number;
    // Cells per frame.
    readonly speed: number;
    // Frames of rest after the pass.
    readonly gap: number;
}

// Same index, same numbers: frames must be a pure function of nowMs.
function unitHash(index: number, salt: number): number {
    let value = Math.imul(index ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35);
    value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
    value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
    value ^= value >>> 16;
    return (value >>> 0) / 0x1_0000_0000;
}

function pickInt(min: number, max: number, unit: number): number {
    return min + Math.min(max - min, Math.floor(unit * (max - min + 1)));
}

export function readingPass(index: number, width: number): ReadingPass {
    const start = pickInt(0, width - 2, unitHash(index, 0));
    const length = pickInt(2, width - start, unitHash(index, 1));
    const speed = 0.09 + 0.07 * unitHash(index, 2);
    const gap = pickInt(3, 8, unitHash(index, 3));
    return { start, length, speed, gap };
}

// Passes vary in duration, so finding the current one means walking from a known
// origin. Epochs bound that walk; a pass that would cross an epoch end is shortened.
const READING_EPOCH_FRAMES = 1_200;
const READING_PASSES_PER_EPOCH = 1_000;

interface ReadingMoment {
    readonly passIndex: number;
    readonly pass: ReadingPass;
    readonly travelled: number;
}

function readingMoment(frame: number, width: number): ReadingMoment | undefined {
    const epoch = Math.floor(frame / READING_EPOCH_FRAMES);
    const inEpoch = frame - epoch * READING_EPOCH_FRAMES;
    let passStart = 0;
    for (let slot = 0; slot < READING_PASSES_PER_EPOCH; slot += 1) {
        const passIndex = epoch * READING_PASSES_PER_EPOCH + slot;
        const planned = readingPass(passIndex, width);
        const room = Math.floor((READING_EPOCH_FRAMES - passStart - planned.gap) * planned.speed);
        const length = Math.min(planned.length, room);
        if (length < 1) return undefined;
        const pass: ReadingPass = { ...planned, length };
        const duration = length / pass.speed;
        if (inEpoch < passStart + duration) {
            return { passIndex, pass, travelled: (inEpoch - passStart) * pass.speed };
        }
        passStart += duration + pass.gap;
        if (inEpoch < passStart) return undefined;
    }
    return undefined;
}

const READING_HEAD_GLYPHS = ["▚", "▞", "▙", "▛", "▜", "▟"] as const;
const READING_TRAIL_GLYPHS = ["▖", "▗", "▘", "▝", "▌", "▐"] as const;
const READING_GLYPH_FRAMES = 2;

// Salts 0 to 3 pick the pass itself; glyph salts start above them.
function readingGlyph(glyphs: readonly string[], passIndex: number, index: number, frame: number): string {
    const bucket = Math.floor(frame / READING_GLYPH_FRAMES);
    const salt = 4 + bucket * 16 + index;
    return glyphs[pickInt(0, glyphs.length - 1, unitHash(passIndex, salt))]!;
}

function cell(kind: TuiActivityKind, index: number, frame: number, width: number): Cell {
    if (kind === "thinking") {
        const strength = Math.max(wave(index, frame, width, 0.2, 3), 0.15);
        return [SHADES[Math.min(3, Math.floor(strength * 4))]!, strength];
    }
    if (kind === "reading") {
        const moment = readingMoment(frame, width);
        if (moment === undefined) return ["·", 0.12];
        const head = moment.pass.start + moment.travelled;
        const behind = head - index;
        if (index < moment.pass.start) return ["·", 0.12];
        if (behind >= 0 && behind < 1) {
            return [readingGlyph(READING_HEAD_GLYPHS, moment.passIndex, index, frame), 1];
        }
        if (behind >= 1 && behind < 3) {
            return [readingGlyph(READING_TRAIL_GLYPHS, moment.passIndex, index, frame), 0.45 - (behind - 1) * 0.15];
        }
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
