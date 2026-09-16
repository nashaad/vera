import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { TUI_MUTED } from "./palette.ts";
import type { TurnTiming } from "../../src/model/types.ts";

const finishedTime = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
});

export function workedDividerText(timing: TurnTiming): string {
    const totalSeconds = Math.floor(timing.durationMs / 1_000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const elapsed = minutes === 0
        ? `${seconds}s`
        : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    const ended = finishedTime.format(timing.finishedAt).replace(" at ", ", ");
    return `Worked for ${elapsed} · ${ended}`;
}

export function createTuiWorkedDivider(
    renderer: CliRenderer,
    id: string,
    text: string,
): BoxRenderable {
    const row = new BoxRenderable(renderer, {
        id,
        width: "100%",
        flexDirection: "row",
        alignItems: "center",
    });
    const label = new TextRenderable(renderer, {
        id: `${id}-label`,
        content: `─ ${text} `,
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
    row.add(label);
    row.add(rule);
    dividerParts.set(row, { label, rule });
    return row;
}

interface DividerParts {
    readonly label: TextRenderable;
    readonly rule: BoxRenderable;
}

const dividerParts = new WeakMap<BoxRenderable, DividerParts>();

export function updateTuiWorkedDivider(row: BoxRenderable, text: string): void {
    const parts = dividerParts.get(row);
    if (parts === undefined) return;
    parts.label.content = `─ ${text} `;
    parts.label.fg = TUI_MUTED;
    parts.rule.borderColor = TUI_MUTED;
}
