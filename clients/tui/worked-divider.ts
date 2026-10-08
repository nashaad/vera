import { BoxRenderable, StyledText, TextRenderable, fg, type CliRenderer, type MouseEvent } from "@opentui/core";
import { TUI_MUTED, TUI_TEXT } from "./palette.ts";
import { tuiWorkedRowText, type TuiAutoApproval, type TuiTranscriptEntry } from "./state.ts";
import type { TurnTiming } from "../../src/model/types.ts";

// Longer calls overflow the column instead of pushing every reason off screen.
const CALL_COLUMN_MAX = 40;

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
        wrapMode: "word",
        selectable: true,
    });
    listBox.add(list);
    row.onMouseUp = (event: MouseEvent) => {
        if (event.button !== 0 || label.hasSelection()) return;
        onToggle(node);
    };
    row.add(label);
    row.add(rule);
    node.add(row);
    node.add(listBox);
    dividerParts.set(node, { label, rule, listBox, list });
    updateTuiWorkedDivider(node, view);
    return node;
}

interface DividerParts {
    readonly label: TextRenderable;
    readonly rule: BoxRenderable;
    readonly listBox: BoxRenderable;
    readonly list: TextRenderable;
}

const dividerParts = new WeakMap<BoxRenderable, DividerParts>();

export function updateTuiWorkedDivider(node: BoxRenderable, view: TuiWorkedDividerView): void {
    const parts = dividerParts.get(node);
    if (parts === undefined) return;
    parts.label.content = `─ ${view.text} `;
    parts.label.fg = TUI_MUTED;
    parts.rule.borderColor = TUI_MUTED;
    parts.listBox.visible = view.expanded && view.approvals.length > 0;
    parts.list.content = approvalList(view.approvals);
}

function approvalList(approvals: readonly TuiAutoApproval[]): StyledText {
    const calls = approvals.map((approval) => approval.call ?? approval.tool);
    const width = Math.min(CALL_COLUMN_MAX, Math.max(0, ...calls.map((call) => call.length)));
    return new StyledText(approvals.flatMap((approval, index) => [
        ...(index === 0 ? [] : [fg(TUI_MUTED)("\n")]),
        fg(TUI_TEXT)((calls[index] ?? "").padEnd(width)),
        fg(TUI_MUTED)(`   ${approval.reason}`),
    ]));
}
