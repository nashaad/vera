import { BoxRenderable, StyledText, TextRenderable, fg, italic, type CliRenderer, type MouseEvent, type TextChunk } from "@opentui/core";
import { TUI_MUTED, TUI_TEXT } from "./palette.ts";
import { tuiWorkedRowText, type TuiAutoApproval, type TuiTranscriptEntry } from "./state.ts";
import type { TurnTiming } from "../../src/model/types.ts";

const CALL_MAX_LINES = 2;
const LIST_INDENT = 2;
const CONTINUATION = "  ";
const REASON_MARKER = "↳ ";
// Must match the engine's fallback when the classifier gives no rationale.
const NO_RATIONALE_REASON = "The classifier returned an allow decision.";

const finishedTime = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
});

export function workedDividerText(timing: TurnTiming, now = Date.now()): string {
    const totalSeconds = Math.floor(timing.durationMs / 1_000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const elapsed = minutes === 0
        ? `${seconds}s`
        : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    const label = `Worked for ${elapsed}`;
    if (now - timing.finishedAt <= 24 * 60 * 60 * 1_000) return label;
    const ended = finishedTime.format(timing.finishedAt).replace(" at ", ", ");
    return `${label} · ${ended}`;
}

export interface TuiWorkedDividerView {
    readonly text: string;
    readonly approvals: readonly TuiAutoApproval[];
    readonly expanded: boolean;
}

export function tuiWorkedDividerView(entry: TuiTranscriptEntry): TuiWorkedDividerView {
    return {
        text: tuiWorkedRowText(entry),
        approvals: entry.kind === "diff" ? [] : entry.autoApprovals ?? [],
        expanded: entry.kind !== "diff" && entry.expanded === true,
    };
}

export function createTuiWorkedDivider(
    renderer: CliRenderer,
    id: string,
    view: TuiWorkedDividerView,
    onToggle: (node: BoxRenderable) => void,
): BoxRenderable {
    const node = new BoxRenderable(renderer, {
        id,
        width: "100%",
        flexDirection: "column",
    });
    const row = new BoxRenderable(renderer, {
        id: `${id}-row`,
        width: "100%",
        flexDirection: "row",
        alignItems: "center",
    });
    const label = new TextRenderable(renderer, {
        id: `${id}-label`,
        content: `─ ${view.text} `,
        fg: TUI_MUTED,
        flexShrink: 1,
        wrapMode: "word",
        selectable: true,
    });
    const rule = new BoxRenderable(renderer, {
        id: `${id}-rule`,
        height: 1,
        minWidth: 1,
        flexGrow: 1,
        border: ["top"],
        borderStyle: "single",
        borderColor: TUI_MUTED,
    });
    const listBox = new BoxRenderable(renderer, {
        id: `${id}-list-box`,
        width: "100%",
        marginTop: 1,
        paddingLeft: 2,
        visible: false,
    });
    const list = new TextRenderable(renderer, {
        id: `${id}-list`,
        content: "",
        wrapMode: "none",
        selectable: true,
    });
    // Lines are wrapped by hand for the indents, so a new width needs new lines.
    listBox.onSizeChange = () => {
        const parts = dividerParts.get(node);
        if (parts !== undefined) parts.list.content = approvalList(parts, renderer);
    };
    listBox.add(list);
    row.onMouseUp = (event: MouseEvent) => {
        if (event.button !== 0 || label.hasSelection()) return;
        onToggle(node);
    };
    row.add(label);
    row.add(rule);
    node.add(row);
    node.add(listBox);
    dividerParts.set(node, { label, rule, listBox, list, renderer, approvals: view.approvals });
    updateTuiWorkedDivider(node, view);
    return node;
}

interface DividerParts {
    readonly label: TextRenderable;
    readonly rule: BoxRenderable;
    readonly listBox: BoxRenderable;
    readonly list: TextRenderable;
    readonly renderer: CliRenderer;
    approvals: readonly TuiAutoApproval[];
}

const dividerParts = new WeakMap<BoxRenderable, DividerParts>();

export function updateTuiWorkedDivider(node: BoxRenderable, view: TuiWorkedDividerView): void {
    const parts = dividerParts.get(node);
    if (parts === undefined) return;
    parts.label.content = `─ ${view.text} `;
    parts.label.fg = TUI_MUTED;
    parts.rule.borderColor = TUI_MUTED;
    parts.listBox.visible = view.expanded && view.approvals.length > 0;
    parts.approvals = view.approvals;
    parts.list.content = approvalList(parts, parts.renderer);
}

function approvalList(parts: DividerParts, renderer: CliRenderer): StyledText {
    const boxWidth = parts.listBox.width > 0 ? parts.listBox.width : renderer.width;
    const lines = tuiApprovalListLines(parts.approvals, boxWidth - LIST_INDENT);
    return new StyledText(lines.flatMap((line, index) => [
        ...(index === 0 ? [] : [fg(TUI_MUTED)("\n")]),
        ...approvalLineChunks(line),
    ]));
}

function approvalLineChunks(line: TuiApprovalListLine): TextChunk[] {
    if (line.kind === "gap") return [];
    if (line.kind === "reason") return [italic(fg(TUI_MUTED)(line.text))];
    return [fg(TUI_TEXT)(line.text)];
}

export type TuiApprovalListLine =
    | { readonly kind: "call"; readonly text: string }
    | { readonly kind: "reason"; readonly text: string }
    | { readonly kind: "gap" };

export function tuiApprovalListLines(
    approvals: readonly TuiAutoApproval[],
    width: number,
): TuiApprovalListLine[] {
    const usable = Math.max(12, width);
    const lines: TuiApprovalListLine[] = [];
    approvals.forEach((approval, index) => {
        if (index > 0) lines.push({ kind: "gap" });
        const call = clampLines(
            wrapWords(approval.call ?? approval.tool, usable, usable - CONTINUATION.length),
            CALL_MAX_LINES,
            usable - CONTINUATION.length,
        );
        call.forEach((text, at) => {
            lines.push({ kind: "call", text: at === 0 ? text : `${CONTINUATION}${text}` });
        });
        const reason = approval.reason.trim();
        if (reason.length === 0 || reason === NO_RATIONALE_REASON) return;
        const reasonWidth = usable - REASON_MARKER.length - CONTINUATION.length;
        wrapWords(reason, reasonWidth, reasonWidth).forEach((text, at) => {
            const lead = at === 0 ? REASON_MARKER : CONTINUATION;
            lines.push({ kind: "reason", text: `${CONTINUATION}${lead}${text}` });
        });
    });
    return lines;
}

// Words longer than a line, such as long paths, are cut across lines.
function wrapWords(text: string, firstWidth: number, restWidth: number): string[] {
    const lines: string[] = [];
    let line = "";
    let limit = firstWidth;
    for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
        let rest = word;
        while (rest.length > 0) {
            const separator = line.length === 0 ? "" : " ";
            if (line.length + separator.length + rest.length <= limit) {
                line += separator + rest;
                rest = "";
            } else if (line.length > 0) {
                lines.push(line);
                line = "";
                limit = restWidth;
            } else {
                lines.push(rest.slice(0, limit));
                rest = rest.slice(limit);
                limit = restWidth;
            }
        }
    }
    if (line.length > 0 || lines.length === 0) lines.push(line);
    return lines;
}

function clampLines(lines: string[], max: number, lastWidth: number): string[] {
    if (lines.length <= max) return lines;
    const kept = lines.slice(0, max - 1);
    const rest = lines.slice(max - 1).join(" ");
    kept.push(`${rest.slice(0, Math.max(0, lastWidth - 1)).trimEnd()}…`);
    return kept;
}
