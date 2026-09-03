/** The first-run screen: three named gates on one surface, and the body of whichever gate is open. */

import {
    BoxRenderable,
    parseColor,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import type {
    OnboardingStep,
    OnboardingStepId,
} from "../../src/providers/onboarding.ts";
import { DIALOG_CARD_Z_INDEX } from "./dialog-chrome.ts";
import { TUI_ACCENT, TUI_BACKGROUND, TUI_DANGER, TUI_MUTED, TUI_TEXT } from "./state.ts";

export const ONBOARDING_TITLE = "Set up Vera";

export const ONBOARDING_CARD_COLUMNS = 72;

const CONTENT_INDENT = 2;

const INNER_WIDTH = ONBOARDING_CARD_COLUMNS - 2;

const STEP_CELL_WIDTH = 22;

const CHEVRON = "›";

/** The search line wears a different mark from the caret, so it does not read as a row. */
const SEARCH_MARK = "/";

const MARKER_CURRENT = "▸";

const MARKER_DONE = "✓";

const MARKER_SKIPPED = "–";

/** What a finished step shows underneath its name. A skipped gate says it did not apply rather than claiming a choice. */
export interface OnboardingAnswer {
    readonly text: string;
    readonly skipped?: boolean;
}

export interface OnboardingChoiceRow {
    readonly id: string;
    readonly label: string;
    readonly detail?: string;
    /** A second line under the row, for the rows that need a sentence. */
    readonly note?: string;
    /** A row shown for the reason it cannot be picked. */
    readonly unavailable?: string;
}

export interface OnboardingChoiceGroup {
    readonly label?: string;
    readonly rows: readonly OnboardingChoiceRow[];
}

export interface OnboardingChoiceBody {
    readonly kind: "choice";
    readonly groups: readonly OnboardingChoiceGroup[];
    /** The word after `enter` in the footer. */
    readonly enterHint?: string;
    /** Set once a list is long enough that scanning it by eye stops working. */
    readonly query?: string;
}

export interface OnboardingSecretBody {
    readonly kind: "secret";
    readonly value: string;
    readonly placeholder: string;
    readonly notes: readonly string[];
}

export type OnboardingCheckState = "done" | "active" | "pending";

export interface OnboardingCheck {
    readonly label: string;
    readonly state: OnboardingCheckState;
}

export interface OnboardingProgressBody {
    readonly kind: "progress";
    readonly label: string;
    readonly elapsedSeconds?: number;
    readonly checks: readonly OnboardingCheck[];
    readonly escHint?: string;
}

export interface OnboardingDoneBody {
    readonly kind: "done";
    readonly lines: readonly string[];
}

export type OnboardingBody =
    | OnboardingChoiceBody
    | OnboardingSecretBody
    | OnboardingProgressBody
    | OnboardingDoneBody;

export interface OnboardingScreenState {
    readonly steps: readonly OnboardingStep[];
    readonly answers: Readonly<
        Partial<Record<OnboardingStepId, OnboardingAnswer>>
    >;
    readonly heading: string;
    readonly body: OnboardingBody;
    /** The provider's own words when it turned something down. */
    readonly alert?: string;
    readonly selected?: string;
    readonly spinnerFrame?: number;
}

export type OnboardingScreenAction =
    | { readonly kind: "choose"; readonly id: string }
    | { readonly kind: "submit"; readonly value: string }
    | { readonly kind: "back" }
    /** The last screen has nothing to choose; enter there means start working. */
    | { readonly kind: "continue" }
    | { readonly kind: "leave" };

export type OnboardingLineTone =
    | "frame"
    | "spine"
    | "answer"
    | "heading"
    | "group"
    | "row"
    | "note"
    | "alert"
    | "field"
    | "footer";

export interface OnboardingLine {
    readonly text: string;
    readonly tone: OnboardingLineTone;
    readonly selected?: boolean;
    /** The row this line can be clicked to choose. */
    readonly rowId?: string;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴"];

/** Rows a caret can land on. An unavailable row is shown and skipped. */
export function selectableRows(
    body: OnboardingBody,
): readonly OnboardingChoiceRow[] {
    if (body.kind !== "choice") return [];
    return visibleGroups(body).flatMap((group) =>
        group.rows.filter((row) => row.unavailable === undefined)
    );
}

function matches(row: OnboardingChoiceRow, query: string): boolean {
    const needle = query.toLowerCase();
    return row.label.toLowerCase().includes(needle)
        || row.id.toLowerCase().includes(needle);
}

function visibleGroups(
    body: OnboardingChoiceBody,
): readonly OnboardingChoiceGroup[] {
    const query = body.query ?? "";
    if (query === "") return body.groups;
    return body.groups
        .map((group) => ({
            ...group,
            rows: group.rows.filter((row) => matches(row, query)),
        }))
        .filter((group) => group.rows.length > 0);
}

function selectedRowId(state: OnboardingScreenState): string | undefined {
    const rows = selectableRows(state.body);
    if (rows.some((row) => row.id === state.selected)) return state.selected;
    return rows[0]?.id;
}

const MARKER_FIELD = 4;

function stepCell(
    step: OnboardingStep,
    index: number,
    answer: OnboardingAnswer | undefined,
): { readonly head: string; readonly under: string } {
    const number = String(index + 1);
    if (step.state === "done") {
        const marker = answer?.skipped === true ? MARKER_SKIPPED : MARKER_DONE;
        const head = `${pad(marker, MARKER_FIELD)}${step.label}`;
        return {
            head,
            under: `${" ".repeat(MARKER_FIELD)}${answer?.text ?? ""}`,
        };
    }
    if (step.state === "current") {
        const head = `${pad(`${number} ${MARKER_CURRENT}`, MARKER_FIELD)}${step.label}`;
        return { head, under: "─".repeat(head.length) };
    }
    const head = `${pad(number, MARKER_FIELD)}${step.label}`;
    return { head, under: "·".repeat(head.length) };
}

function pad(text: string, width: number): string {
    return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/** Pads or truncates, so no content can push the frame open. */
function fit(text: string, width: number): string {
    if (text.length <= width) return pad(text, width);
    return `${text.slice(0, Math.max(0, width - 1))}…`;
}

function indent(text: string): string {
    return `${" ".repeat(CONTENT_INDENT)}${text}`;
}

/** The spine: every gate named, every finished gate still showing its answer. */
export function spineLines(
    state: OnboardingScreenState,
): readonly OnboardingLine[] {
    const cells = state.steps.map((step, index) =>
        stepCell(step, index, state.answers[step.id])
    );
    const head = cells.map((cell) => pad(cell.head, STEP_CELL_WIDTH)).join("");
    const under = cells.map((cell) => pad(cell.under, STEP_CELL_WIDTH)).join("");
    return [
        { text: indent(head.trimEnd()), tone: "spine" },
        { text: indent(under.trimEnd()), tone: "answer" },
    ];
}

function spinnerGlyph(frame: number | undefined): string {
    return SPINNER[(frame ?? 0) % SPINNER.length] ?? SPINNER[0] ?? "";
}

function checkGlyph(state: OnboardingCheckState): string {
    if (state === "done") return MARKER_DONE;
    return state === "active" ? "·" : " ";
}

function bodyLines(
    state: OnboardingScreenState,
): readonly OnboardingLine[] {
    const body = state.body;
    if (body.kind === "choice") return choiceLines(state, body);
    if (body.kind === "secret") return secretLines(body);
    if (body.kind === "progress") return progressLines(state, body);
    return body.lines.flatMap((text) =>
        wrapped(text, INNER_WIDTH - CONTENT_INDENT * 2).map((line) => ({
            text: indent(line),
            tone: "note" as const,
        }))
    );
}

/** Word wrap, so a body can be given a sentence rather than pre-broken lines. */
function wrapped(text: string, width: number): readonly string[] {
    if (text === "") return [""];
    const lines: string[] = [];
    let line = "";
    for (const word of text.split(" ")) {
        if (line.length === 0) {
            line = word;
        } else if (line.length + 1 + word.length <= width) {
            line = `${line} ${word}`;
        } else {
            lines.push(line);
            line = word;
        }
    }
    if (line.length !== 0) lines.push(line);
    return lines;
}

const ROW_HEAD_INDENT = 4;

/** The detail column follows the longest label, so a short list is not stretched and a long one still fits. */
function detailColumn(groups: readonly OnboardingChoiceGroup[]): number {
    const widest = Math.max(
        0,
        ...groups.flatMap((group) => group.rows.map((row) => row.label.length)),
    );
    const room = INNER_WIDTH - CONTENT_INDENT;
    return Math.min(ROW_HEAD_INDENT + widest + 2, Math.max(0, room - 20));
}

/** How many rows a list shows at once, so the card stays shorter than a small terminal and a long list scrolls inside it. */
const CHOICE_WINDOW = 10;

interface ChoiceWindow {
    readonly groups: readonly OnboardingChoiceGroup[];
    readonly above: number;
    readonly below: number;
}

/** The slice of a long list that surrounds the selected row, with a count of what sits outside it. */
function choiceWindow(
    groups: readonly OnboardingChoiceGroup[],
    selected: string | undefined,
): ChoiceWindow {
    const flat = groups.flatMap((group) => group.rows);
    if (flat.length <= CHOICE_WINDOW) {
        return { groups, above: 0, below: 0 };
    }
    const at = Math.max(0, flat.findIndex((row) => row.id === selected));
    const start = Math.min(
        flat.length - CHOICE_WINDOW,
        Math.max(0, at - Math.floor(CHOICE_WINDOW / 2)),
    );
    const end = start + CHOICE_WINDOW;
    const windowed: OnboardingChoiceGroup[] = [];
    let seen = 0;
    for (const group of groups) {
        const rows = group.rows.filter((_row, index) =>
            seen + index >= start && seen + index < end
        );
        seen += group.rows.length;
        if (rows.length > 0) windowed.push({ ...group, rows });
    }
    return { groups: windowed, above: start, below: flat.length - end };
}

function searchLines(
    body: OnboardingChoiceBody,
): readonly OnboardingLine[] {
    if (body.query === undefined) return [];
    const typed = body.query === "" ? "type to search" : body.query;
    return [
        { text: indent(`  ${SEARCH_MARK} ${typed}`), tone: "field" },
        { text: "", tone: "frame" },
    ];
}

function choiceLines(
    state: OnboardingScreenState,
    body: OnboardingChoiceBody,
): readonly OnboardingLine[] {
    const selected = selectedRowId(state);
    const groupsShown = visibleGroups(body);
    const column = detailColumn(groupsShown);
    const shown = choiceWindow(groupsShown, selected);
    const lines: OnboardingLine[] = [...searchLines(body)];
    if (shown.above > 0) {
        lines.push({
            text: indent(`    ${shown.above} more above`),
            tone: "note",
        });
    }
    for (const group of shown.groups) {
        if (group.label !== undefined) {
            lines.push({ text: indent(group.label), tone: "group" });
        }
        for (const row of group.rows) {
            const chosen = row.id === selected;
            const caret = row.unavailable !== undefined
                ? " "
                : chosen
                ? CHEVRON
                : " ";
            const head = `  ${caret} ${row.label}`;
            const detail = row.detail ?? row.unavailable ?? "";
            const gap = Math.max(1, column - head.length);
            lines.push({
                text: detail === ""
                    ? indent(head)
                    : indent(`${head}${" ".repeat(gap)}${detail}`),
                tone: "row",
                selected: chosen,
                rowId: row.unavailable === undefined ? row.id : undefined,
            });
            if (row.note !== undefined) {
                lines.push({
                    text: indent(`      ${row.note}`),
                    tone: "note",
                });
                // A row that spills onto a second line needs air under it, or the next row reads as part of it.
                lines.push({ text: "", tone: "frame" });
            }
        }
        if (lines.at(-1)?.text !== "") {
            lines.push({ text: "", tone: "frame" });
        }
    }
    if (lines.at(-1)?.text === "") lines.pop();
    if (shown.below > 0) {
        lines.push({
            text: indent(`    ${shown.below} more below`),
            tone: "note",
        });
    }
    return lines;
}

const FIELD_WIDTH = INNER_WIDTH - CONTENT_INDENT * 2 - 2;

function secretLines(
    body: OnboardingSecretBody,
): readonly OnboardingLine[] {
    const shown = body.value === ""
        ? body.placeholder
        : `${body.placeholder}${"•".repeat(body.value.length)}`;
    return [
        {
            text: indent(`╭${"─".repeat(FIELD_WIDTH)}╮`),
            tone: "field",
        },
        {
            text: indent(`│ ${pad(shown, FIELD_WIDTH - 2)} │`),
            tone: "field",
        },
        {
            text: indent(`╰${"─".repeat(FIELD_WIDTH)}╯`),
            tone: "field",
        },
        ...(body.notes.length === 0 ? [] : [
            { text: "", tone: "frame" as const },
            ...body.notes.map((note) => ({
                text: indent(note),
                tone: "note" as const,
            })),
        ]),
    ];
}

function progressLines(
    state: OnboardingScreenState,
    body: OnboardingProgressBody,
): readonly OnboardingLine[] {
    const elapsed = body.elapsedSeconds === undefined
        ? ""
        : `   ${body.elapsedSeconds}s`;
    const head = `${body.label}`;
    const gap = Math.max(1, 52 - head.length);
    return [
        {
            text: indent(
                `${head}${" ".repeat(gap)}${spinnerGlyph(state.spinnerFrame)}${elapsed}`,
            ),
            tone: "heading",
        },
        { text: "", tone: "frame" },
        ...body.checks.map((check) => ({
            text: indent(`  ${checkGlyph(check.state)} ${check.label}`),
            tone: "note" as const,
        })),
    ];
}

/** The last line: what the keys do here, named in words. */
export function footerText(state: OnboardingScreenState): string {
    const escape = onFirstStep(state) ? "esc leave setup" : "esc back";
    const body = state.body;
    if (body.kind === "choice") {
        const enter = `enter ${body.enterHint ?? "next"}`;
        return `↑↓ choose    ${enter}    ${escape}`;
    }
    if (body.kind === "secret") return `enter next    ${escape}`;
    if (body.kind === "progress") return body.escHint ?? escape;
    return "enter start working";
}

function onFirstStep(state: OnboardingScreenState): boolean {
    return state.steps[0]?.state === "current";
}

/** The whole screen, frame included, so a test reads what a person reads. */
export function onboardingCardLines(
    state: OnboardingScreenState,
): readonly OnboardingLine[] {
    const inner: OnboardingLine[] = [
        { text: "", tone: "frame" },
        ...spineLines(state),
        { text: "", tone: "frame" },
    ];
    if (state.alert !== undefined) {
        inner.push({ text: indent(`! ${state.alert}`), tone: "alert" });
        inner.push({ text: "", tone: "frame" });
    }
    if (state.heading !== "") {
        inner.push({ text: indent(state.heading), tone: "heading" });
        inner.push({ text: "", tone: "frame" });
    }
    inner.push(...bodyLines(state));
    inner.push({ text: "", tone: "frame" });
    inner.push({ text: indent(footerText(state)), tone: "footer" });
    // The frame is padded at the top, so it is padded at the bottom too.
    inner.push({ text: "", tone: "frame" });
    const title = ` ${ONBOARDING_TITLE} `;
    const top = `┌${title}${
        "─".repeat(Math.max(0, INNER_WIDTH - title.length))
    }┐`;
    return [
        { text: top, tone: "frame" },
        ...inner.map((line) => ({
            ...line,
            text: `│${fit(line.text, INNER_WIDTH)}│`,
        })),
        {
            text: `└${"─".repeat(INNER_WIDTH)}┘`,
            tone: "frame" as const,
        },
    ];
}

export interface OnboardingKey {
    readonly name: string;
    readonly sequence?: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

export interface OnboardingKeyResult {
    readonly state?: OnboardingScreenState;
    readonly action?: OnboardingScreenAction;
    readonly handled: boolean;
}

function moveSelection(
    state: OnboardingScreenState,
    delta: number,
): OnboardingKeyResult {
    const rows = selectableRows(state.body);
    if (rows.length === 0) return { handled: true };
    const current = rows.findIndex((row) => row.id === selectedRowId(state));
    const next = rows[(current + delta + rows.length) % rows.length];
    return next === undefined
        ? { handled: true }
        : { state: { ...state, selected: next.id }, handled: true };
}

function typedCharacter(key: OnboardingKey): string | undefined {
    if (
        key.ctrl === true || key.meta === true || key.super === true
        || key.hyper === true
    ) {
        return undefined;
    }
    if (key.name === "space") return " ";
    return key.name.length === 1 ? (key.sequence ?? key.name) : undefined;
}

export function handleOnboardingKey(
    state: OnboardingScreenState,
    key: OnboardingKey,
): OnboardingKeyResult {
    if (key.meta === true || key.super === true || key.hyper === true) {
        return { handled: false };
    }
    if (key.name === "escape") {
        return {
            action: onFirstStep(state) ? { kind: "leave" } : { kind: "back" },
            handled: true,
        };
    }
    const body = state.body;
    if (key.name === "return" || key.name === "enter") {
        if (body.kind === "done") {
            return { action: { kind: "continue" }, handled: true };
        }
        if (body.kind === "secret") {
            return {
                action: { kind: "submit", value: body.value },
                handled: true,
            };
        }
        const chosen = selectedRowId(state);
        return chosen === undefined
            ? { handled: true }
            : { action: { kind: "choose", id: chosen }, handled: true };
    }
    if (body.kind === "secret") {
        if (key.name === "backspace") {
            return {
                state: {
                    ...state,
                    body: { ...body, value: body.value.slice(0, -1) },
                },
                handled: true,
            };
        }
        const typed = typedCharacter(key);
        return typed === undefined ? { handled: false } : {
            state: {
                ...state,
                body: { ...body, value: `${body.value}${typed}` },
            },
            handled: true,
        };
    }
    if (key.name === "up") return moveSelection(state, -1);
    if (key.name === "down") return moveSelection(state, 1);
    if (body.kind === "choice" && body.query !== undefined) {
        if (key.name === "backspace") {
            return {
                state: {
                    ...state,
                    body: { ...body, query: body.query.slice(0, -1) },
                },
                handled: true,
            };
        }
        const typed = typedCharacter(key);
        if (typed !== undefined) {
            return {
                state: {
                    ...state,
                    body: { ...body, query: `${body.query}${typed}` },
                    selected: undefined,
                },
                handled: true,
            };
        }
    }
    return { handled: false };
}

export interface OnboardingAppearance {
    readonly textColor: string;
    readonly mutedColor: string;
    readonly accentColor: string;
    readonly dangerColor: string;
    /** The wizard owns the whole terminal, so it paints its own ground rather than letting the composer show through. */
    readonly backgroundColor: string;
}

export interface TuiOnboardingView {
    readonly surface: BoxRenderable;
    readonly box: BoxRenderable;
    update(state: OnboardingScreenState): void;
    applyAppearance(appearance: OnboardingAppearance): void;
}

function lineColor(
    line: OnboardingLine,
    colors: OnboardingAppearance,
): string {
    if (line.tone === "alert") return colors.dangerColor;
    if (line.selected === true) return colors.accentColor;
    if (line.tone === "heading" || line.tone === "spine") {
        return colors.textColor;
    }
    return colors.mutedColor;
}

export function createTuiOnboardingView(
    renderer: RenderContext,
    onRun: (action: OnboardingScreenAction) => void,
): TuiOnboardingView {
    let colors: OnboardingAppearance = {
        textColor: TUI_TEXT,
        mutedColor: TUI_MUTED,
        accentColor: TUI_ACCENT,
        dangerColor: TUI_DANGER,
        backgroundColor: TUI_BACKGROUND,
    };
    const box = new BoxRenderable(renderer, {
        id: "onboarding-card",
        border: false,
        width: ONBOARDING_CARD_COLUMNS,
        height: "auto",
        flexDirection: "column",
        focusable: true,
    });
    const surface = new BoxRenderable(renderer, {
        id: "onboarding-surface",
        border: false,
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        zIndex: DIALOG_CARD_Z_INDEX,
        backgroundColor: TUI_BACKGROUND,
        alignItems: "center",
        justifyContent: "center",
        visible: false,
    });
    surface.add(box);
    let lines: TextRenderable[] = [];
    let rendered: OnboardingScreenState | undefined;
    const paint = (state: OnboardingScreenState): void => {
        for (const line of lines) line.destroyRecursively();
        lines = [];
        for (const [index, line] of onboardingCardLines(state).entries()) {
            const rowId = line.rowId;
            const text = new TextRenderable(renderer, {
                id: `onboarding-line-${index}`,
                content: line.text,
                fg: lineColor(line, colors),
                width: "100%",
                height: 1,
                onMouseDown: rowId === undefined
                    ? undefined
                    : () => onRun({ kind: "choose", id: rowId }),
            });
            lines.push(text);
            box.add(text);
        }
    };
    return {
        surface,
        box,
        update(state): void {
            rendered = state;
            paint(state);
        },
        applyAppearance(appearance): void {
            colors = appearance;
            surface.backgroundColor = parseColor(appearance.backgroundColor);
            if (rendered !== undefined) paint(rendered);
        },
    };
}
