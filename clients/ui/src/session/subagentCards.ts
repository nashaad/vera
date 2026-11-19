import { startedSubagentId } from "../../../../src/tools/subagent-started.ts";
import type { SessionRow } from "../protocol/sessions.ts";
import type { ToolCall, ToolState } from "./model.ts";

const TITLE_LENGTH = 80;

const CALL_WORDS: Readonly<Record<ToolState, string>> = { running: "Working", done: "Done", failed: "Failed", withheld: "Did not run" };

export function callStatusWord(state: ToolState): string {
    return CALL_WORDS[state];
}

// The calls drawn as a card of their own; message_subagent stays in the run line.
export function isCardCall(call: ToolCall): boolean {
    return call.tool === "subagent" || call.tool === "async_subagent";
}

// What the sidebar shows for a session whose first prompt is `description`. Mirrors listedTitle in
// src/host/agent-registry/session-title.ts, plus the trim the row's name gets; a test compares them.
export function childTitleOf(description: string): string | undefined {
    const title = description.replaceAll(/\s+/g, " ").trim().slice(0, TITLE_LENGTH).trim();
    return title === "" ? undefined : title;
}

export function callDescription(call: ToolCall): string | undefined {
    const { description } = call.args;
    return typeof description === "string" ? description : undefined;
}

// The child a card opens: its listed row, else the id an async call's output names while the host has not listed it yet.
export function callChildId(call: ToolCall, child: SessionRow | undefined): string | undefined {
    if (child !== undefined) return child.id;
    if (call.tool !== "async_subagent" || call.output === undefined) return undefined;
    return startedSubagentId(call.output);
}

function byAge(left: SessionRow, right: SessionRow): number {
    return (left.updatedAt ?? 0) - (right.updatedAt ?? 0);
}

// The child each card call started. An async call names its child in its output. A blocking call has no id,
// so it takes the child titled by its description; calls and children of one title pair off oldest to newest,
// counted from the newest end because the transcript may hold only the newest calls.
export function matchSubagentCalls(
    calls: readonly ToolCall[],
    rows: readonly SessionRow[],
    parentId: string,
): ReadonlyMap<ToolCall, SessionRow> {
    const children = rows.filter((row) => row.parentId === parentId);
    const byId = new Map(children.map((child) => [child.id, child]));
    const matches = new Map<ToolCall, SessionRow>();
    const taken = new Set<string>();
    const blocking = new Map<string, ToolCall[]>();
    for (const call of calls) {
        if (call.tool === "async_subagent") {
            const id = call.output === undefined ? undefined : startedSubagentId(call.output);
            const child = id === undefined ? undefined : byId.get(id);
            if (child === undefined || taken.has(child.id)) continue;
            matches.set(call, child);
            taken.add(child.id);
        } else if (call.tool === "subagent") {
            const description = callDescription(call);
            const title = description === undefined ? undefined : childTitleOf(description);
            if (title === undefined) continue;
            blocking.set(title, [...(blocking.get(title) ?? []), call]);
        }
    }
    for (const [title, group] of blocking) {
        const named = children.filter((child) => child.name === title && !taken.has(child.id)).sort(byAge);
        const offset = named.length - group.length;
        group.forEach((call, index) => {
            const child = named[index + offset];
            if (child !== undefined) matches.set(call, child);
        });
    }
    return matches;
}

export type RunSegment =
    | { readonly kind: "calls"; readonly calls: readonly ToolCall[] }
    | { readonly kind: "card"; readonly call: ToolCall };

// A run of calls in order: each card call alone, the calls between them together.
export function runSegments(calls: readonly ToolCall[]): RunSegment[] {
    const segments: RunSegment[] = [];
    let pending: ToolCall[] = [];
    const flush = (): void => {
        if (pending.length > 0) segments.push({ kind: "calls", calls: pending });
        pending = [];
    };
    for (const call of calls) {
        if (call.state === "withheld") {
            flush();
            segments.push({ kind: "calls", calls: [call] });
        } else if (isCardCall(call)) {
            flush();
            segments.push({ kind: "card", call });
        } else pending.push(call);
    }
    flush();
    return segments;
}
