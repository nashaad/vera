import { VERA_TUI_THEME } from "../tui/theme.ts";

// The home screen's wordmark. It lives beside a renderer that needs OpenTUI, so it is repeated here.
const WORDMARK = "V  E  R  A";
const MAX_WIDTH = 64;
const MIN_WIDTH = 24;
const CHOICE_GAP = "      ";

export type StartupCardKind = "error" | "question" | "done";

export interface StartupCardRow {
    readonly label: string;
    readonly value: string;
    // The value is the thing the card is about, such as the failing field.
    readonly bold?: boolean;
}

export interface StartupCardChoice {
    readonly key: string;
    readonly label: string;
    // Shown as an upper-case key; Enter takes it.
    readonly isDefault?: boolean;
}

// A command to copy. It is never shortened, and in a compact card never wrapped.
export interface StartupCardCommand {
    readonly command: string;
}

/**
 * What a startup prompt or error says, before it is laid out. `done` is the
 * short follow-up after an answer and draws without a box.
 */
export interface StartupCard {
    readonly kind: StartupCardKind;
    readonly title: string;
    readonly rows?: readonly StartupCardRow[];
    // Lines of prose; an empty string is a blank line.
    readonly body?: readonly (string | StartupCardCommand)[];
    readonly choices?: readonly StartupCardChoice[];
    // Draw without the box and wordmark, as a `done` card does.
    readonly compact?: boolean;
}

export interface StartupCardStyle {
    readonly columns?: number;
    readonly color: "none" | "ansi" | "truecolor";
    // Paths under this folder are shown as `~/...`.
    readonly home?: string;
}

type Role = "danger" | "success" | "accent" | "notice" | "muted" | "bold";

/** Layout settings for a terminal, with colour off for NO_COLOR and dumb terminals. */
export function startupCardStyle(
    env: Readonly<Record<string, string | undefined>>,
    columns: number | undefined,
    home: string | undefined,
): StartupCardStyle {
    const colorOff = (env.NO_COLOR !== undefined && env.NO_COLOR !== "")
        || env.TERM === "dumb";
    const truecolor = /truecolor|24bit/i.test(env.COLORTERM ?? "");
    return {
        columns,
        home,
        color: colorOff ? "none" : truecolor ? "truecolor" : "ansi",
    };
}

export function renderStartupCard(
    card: StartupCard,
    style: StartupCardStyle,
): string {
    const width = Math.max(MIN_WIDTH, Math.min(style.columns ?? MAX_WIDTH, MAX_WIDTH));
    const compact = card.kind === "done" || card.compact === true;
    // Without a box the text may use the whole width.
    const inner = compact ? width : width - 4;
    const paint = painter(style.color);
    const short = (text: string) => shortenHome(text, style.home);
    const glyph = card.kind === "done"
        ? paint("success", "✓")
        : card.kind === "error" ? paint("danger", "✗") : paint("notice", "?");
    const content: string[] = [
        `${glyph} ${paint("bold", short(card.title))}`,
    ];

    const rows = card.rows ?? [];
    if (rows.length > 0) {
        const labelWidth = Math.max(...rows.map((row) => Bun.stringWidth(row.label))) + 2;
        const valueWidth = Math.max(1, inner - 2 - labelWidth);
        content.push("");
        for (const row of rows) {
            const lines = wrapText(short(row.value), valueWidth);
            lines.forEach((line, index) => {
                const label = index === 0
                    ? paint("muted", row.label) + " ".repeat(labelWidth - Bun.stringWidth(row.label))
                    : " ".repeat(labelWidth);
                content.push(`  ${label}${row.bold === true ? paint("bold", line) : line}`);
            });
        }
    }

    const body = card.body ?? [];
    if (body.length > 0) {
        content.push("");
        for (const text of body) {
            if (text === "") {
                content.push("");
                continue;
            }
            if (typeof text !== "string") {
                const lines = compact ? [text.command] : wrapText(text.command, inner - 4);
                for (const line of lines) content.push(`    ${paint("bold", line)}`);
                continue;
            }
            // A line that starts with spaces keeps them, so a list under a heading stays indented.
            const indent = /^ */.exec(text)![0].length;
            for (const line of wrapText(short(text), Math.max(1, inner - 2 - indent))) {
                content.push(`  ${" ".repeat(indent)}${line}`);
            }
        }
    }

    const choices = card.choices ?? [];
    if (choices.length > 0) {
        content.push("");
        const parts = choices.map((choice) => choiceText(choice, paint));
        const sideBySide = parts.map((part) => part.plain).join(CHOICE_GAP);
        if (2 + Bun.stringWidth(sideBySide) <= inner) {
            content.push(`  ${parts.map((part) => part.styled).join(CHOICE_GAP)}`);
        } else {
            for (const part of parts) content.push(`  ${part.styled}`);
        }
    }

    if (compact) {
        return `${content.join("\n")}\n`;
    }

    const rule = "─".repeat(width - 2);
    const lines = [
        centered(paint("accent", paint("bold", WORDMARK)), WORDMARK, width),
        paint("muted", `╭${rule}╮`),
        ...content.map((line) => boxed(line, inner, paint)),
        paint("muted", `╰${rule}╯`),
    ];
    return `${lines.join("\n")}\n`;
}

/** The line printed after a key press: the key and what it chose, under the card's text column. */
export function renderStartupChoiceEcho(
    choice: StartupCardChoice,
    style: StartupCardStyle,
): string {
    const paint = painter(style.color);
    return `  ${choiceText(choice, paint).styled}\n`;
}

function choiceText(
    choice: StartupCardChoice,
    paint: (role: Role, text: string) => string,
): { readonly plain: string; readonly styled: string } {
    const key = `[${choice.isDefault === true ? choice.key.toUpperCase() : choice.key}]`;
    return {
        plain: `${key} ${choice.label}`,
        styled: `${paint("accent", paint("bold", key))} ${choice.label}`,
    };
}

function boxed(
    line: string,
    inner: number,
    paint: (role: Role, text: string) => string,
): string {
    const gap = " ".repeat(Math.max(0, inner - Bun.stringWidth(line)));
    const edge = paint("muted", "│");
    return `${edge} ${line}${gap} ${edge}`;
}

function centered(styled: string, plain: string, width: number): string {
    return `${" ".repeat(Math.max(0, Math.floor((width - Bun.stringWidth(plain)) / 2)))}${styled}`;
}

function painter(
    color: StartupCardStyle["color"],
): (role: Role, text: string) => string {
    if (color === "none") return (_role, text) => text;
    const theme = VERA_TUI_THEME;
    const basic: Record<Role, string> = {
        danger: "31",
        success: "32",
        accent: "36",
        notice: "33",
        muted: "2",
        bold: "1",
    };
    const hex: Record<Role, string | undefined> = {
        danger: theme.danger,
        success: theme.success,
        accent: theme.accent,
        notice: theme.notice,
        muted: undefined,
        bold: undefined,
    };
    return (role, text) => {
        const code = color === "truecolor" && hex[role] !== undefined
            ? truecolorCode(hex[role]!)
            : basic[role];
        return `\u001b[${code}m${text}\u001b[0m`;
    };
}

function truecolorCode(hex: string): string {
    const value = Number.parseInt(hex.replace("#", ""), 16);
    return `38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
}

// The shell's own `~` form, so a card reads the way the user would type the path.
export function shortenHome(text: string, home: string | undefined): string {
    if (home === undefined || home === "" || home === "/") return text;
    const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(`${escaped}(?=/|\\s|$|[.,;:)])`, "g"), "~");
}

/** Wraps on spaces; a word wider than the column breaks after a slash, then a dash, underscore or dot, then by character. */
export function wrapText(text: string, width: number): string[] {
    const lines: string[] = [];
    let current = "";
    for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
        if (current !== "" && Bun.stringWidth(current) + 1 + Bun.stringWidth(word) <= width) {
            current = `${current} ${word}`;
            continue;
        }
        if (Bun.stringWidth(word) <= width) {
            if (current !== "") lines.push(current);
            current = word;
            continue;
        }
        if (current !== "") lines.push(current);
        const pieces = breakWord(word, width);
        lines.push(...pieces.slice(0, -1));
        current = pieces[pieces.length - 1] ?? "";
    }
    if (current !== "" || lines.length === 0) lines.push(current);
    return lines;
}

// A slash is the preferred break, then a dash, underscore or dot, then any character.
const WORD_BREAKS = [/(?<=\/)/, /(?<=[-_.])/];

function breakWord(word: string, width: number, level = 0): string[] {
    if (Bun.stringWidth(word) <= width) return [word];
    const pattern = WORD_BREAKS[level];
    if (pattern === undefined) return hardSplit(word, width);
    const pieces: string[] = [];
    let line = "";
    for (const segment of word.split(pattern)) {
        if (Bun.stringWidth(line) + Bun.stringWidth(segment) <= width) {
            line += segment;
            continue;
        }
        if (line !== "") pieces.push(line);
        const parts = breakWord(segment, width, level + 1);
        pieces.push(...parts.slice(0, -1));
        line = parts[parts.length - 1]!;
    }
    if (line !== "") pieces.push(line);
    return pieces;
}

function hardSplit(word: string, width: number): string[] {
    const pieces: string[] = [];
    let line = "";
    for (const char of word) {
        if (Bun.stringWidth(line) + Bun.stringWidth(char) > width) {
            pieces.push(line);
            line = "";
        }
        line += char;
    }
    if (line !== "") pieces.push(line);
    return pieces;
}
