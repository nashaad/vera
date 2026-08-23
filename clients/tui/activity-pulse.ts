import { bold, fg, StyledText, type TextChunk } from "@opentui/core";

export interface TuiActivityPulseColors {
    readonly active: string;
    readonly trail: string;
    readonly inactive: string;
    readonly text: string;
}

export type TuiActivityAnimation =
    | "conveyor"
    | "symmetric_wave"
    | "shimmer"
    | "braille"
    | "off";

const DEFAULT_PULSE_WIDTH = 7;
const DEFAULT_SYMMETRIC_WAVE_WIDTH = 5;
const FOCUS_CARET_FRAME_HOLD = 3;
const BRAILLE_FRAMES = [
    "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
] as const;

/** A terminal-native focus caret whose brackets keep the title still. */
export function renderTuiFocusCaret(frame: number): string {
    const visible = positiveModulo(
        Math.floor(frame / FOCUS_CARET_FRAME_HOLD),
        2,
    ) === 0;
    return visible ? "[ > ]" : "[   ]";
}

export function renderTuiActivityAnimation(
    animation: TuiActivityAnimation,
    frame: number,
    message: string,
    colors: TuiActivityPulseColors,
    width?: number,
): StyledText {
    if (animation === "conveyor") {
        return renderTuiActivityPulse(
            frame,
            message,
            colors,
            width ?? DEFAULT_PULSE_WIDTH,
        );
    }
    if (animation === "symmetric_wave") {
        return renderSymmetricWave(
            frame,
            message,
            colors,
            oddWidth(width ?? DEFAULT_SYMMETRIC_WAVE_WIDTH),
        );
    }
    if (animation === "shimmer") {
        return renderShimmer(frame, message, colors);
    }
    if (animation === "braille") {
        const glyph = BRAILLE_FRAMES[positiveModulo(
            frame,
            BRAILLE_FRAMES.length,
        )] ?? "⠋";
        return new StyledText([
            fg(colors.active)(glyph),
            fg(colors.text)(` ${message}`),
        ]);
    }
    return new StyledText([fg(colors.text)(message)]);
}

function renderShimmer(
    frame: number,
    message: string,
    colors: TuiActivityPulseColors,
): StyledText {
    const padding = 10;
    const match = message.match(/^(\S+)([\s\S]*)$/u);
    const animated = match?.[1] ?? "";
    const remainder = match?.[2] ?? message;
    const characters = Array.from(animated);
    const period = characters.length + padding * 2;
    const head = positiveModulo(frame, period) - padding;
    const dotPhase = positiveModulo(frame, 30);
    const dotColor = dotPhase < 5 || dotPhase >= 25
        ? colors.active
        : dotPhase < 10 || dotPhase >= 20
        ? colors.trail
        : colors.inactive;
    const chunks: TextChunk[] = [
        fg(dotColor)("••"),
        fg(colors.inactive)(" "),
    ];

    for (let index = 0; index < characters.length; index += 1) {
        const distance = Math.abs(index - head);
        const bandHalfWidth = 8;
        const intensity = distance <= bandHalfWidth
            ? 0.5 * (1 + Math.cos(Math.PI * distance / bandHalfWidth))
            : 0;
        const color = blendHex(colors.text, colors.trail, intensity * 0.75);
        chunks.push(bold(fg(color)(characters[index] ?? "")));
    }
    if (remainder.length > 0) {
        chunks.push(fg(colors.text)(remainder));
    }
    return new StyledText(chunks);
}

function blendHex(base: string, dark: string, amount: number): string {
    const baseRgb = parseHex(base);
    const darkRgb = parseHex(dark);
    if (baseRgb === undefined || darkRgb === undefined) return base;
    const channel = (start: number, end: number) =>
        Math.round(start + (end - start) * amount)
            .toString(16)
            .padStart(2, "0");
    return `#${channel(baseRgb[0], darkRgb[0])}${
        channel(baseRgb[1], darkRgb[1])
    }${channel(baseRgb[2], darkRgb[2])}`;
}

function parseHex(color: string): readonly [number, number, number] | undefined {
    const match = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (match === null) return undefined;
    return [
        Number.parseInt(match[1] ?? "", 16),
        Number.parseInt(match[2] ?? "", 16),
        Number.parseInt(match[3] ?? "", 16),
    ];
}

export function renderTuiActivityPulse(
    frame: number,
    message: string,
    colors: TuiActivityPulseColors,
    width = DEFAULT_PULSE_WIDTH,
): StyledText {
    const head = positiveModulo(frame, width);
    const chunks: TextChunk[] = [];

    for (let index = 0; index < width; index += 1) {
        const distance = circularDistance(index, head, width);
        if (distance === 0) {
            chunks.push(fg(colors.active)("█"));
        } else if (distance === 1) {
            chunks.push(fg(colors.trail)("▓"));
        } else if (distance === 2) {
            chunks.push(fg(colors.trail)("▒"));
        } else {
            chunks.push(fg(colors.inactive)("░"));
        }
    }

    chunks.push(fg(colors.text)(` ${message}`));
    return new StyledText(chunks);
}

function circularDistance(left: number, right: number, width: number): number {
    const direct = Math.abs(left - right);
    return Math.min(direct, width - direct);
}

function renderSymmetricWave(
    frame: number,
    message: string,
    colors: TuiActivityPulseColors,
    width: number,
): StyledText {
    if (width === 2) {
        const active = positiveModulo(frame, 2) === 0;
        return new StyledText([
            fg(active ? colors.active : colors.inactive)(active ? "▪▪" : "··"),
            fg(colors.text)(` ${message}`),
        ]);
    }
    const center = Math.floor(width / 2);
    const cycle = center * 2;
    const step = positiveModulo(frame, cycle);
    const distance = step <= center ? center - step : step - center;
    const left = center - distance;
    const right = center + distance;
    const chunks = Array.from({ length: width }, (_, index) =>
        fg(index === left || index === right ? colors.active : colors.inactive)(
            index === left || index === right ? "▪" : "·",
        )
    );
    chunks.push(fg(colors.text)(` ${message}`));
    return new StyledText(chunks);
}

function oddWidth(width: number): number {
    if (width === 2) {
        return width;
    }
    return width % 2 === 0 ? width - 1 : width;
}

function positiveModulo(value: number, divisor: number): number {
    return ((value % divisor) + divisor) % divisor;
}
