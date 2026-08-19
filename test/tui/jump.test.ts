import { expect, test } from "bun:test";

import {
    buildJumpRows,
    handleJumpMenuKey,
    jumpMenuLines,
    openJumpMenu,
} from "../../clients/tui/jump.ts";
import type { WorkRow } from "../../src/host/work-index.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";

function needsYouRow(overrides: Partial<WorkRow> = {}): WorkRow {
    return {
        id: "row-1",
        workspace: "/work",
        updated_at: "2026-08-19T00:00:00.000Z",
        session_id: "sess-b",
        session_path: "/sessions/b.jsonl",
        title: "delete notes",
        section: "needs_you",
        reason: "approval",
        summary: "bash rm notes.txt",
        ...overrides,
    };
}

function agent(
    overrides: Partial<RegisteredAgentSummary> & { id: string },
): RegisteredAgentSummary {
    return {
        workspace: "/work",
        session_path: `/sessions/${overrides.id}.jsonl`,
        kind: "main",
        status: "idle",
        live: false,
        ...overrides,
    } as RegisteredAgentSummary;
}

test("jump rows lead with back, then needs-you, then the session's tree", () => {
    const rows = buildJumpRows({
        currentId: "sess-a",
        back: {
            sessionId: "sess-o",
            sessionPath: "/sessions/o.jsonl",
            title: "fix the composer test",
        },
        needsYou: [needsYouRow()],
        agents: [
            agent({ id: "sess-a", parent_id: "sess-p" }),
            agent({ id: "sess-p", title: "refactor sweep" }),
            agent({ id: "sess-c", parent_id: "sess-a", live: true }),
        ],
    });

    expect(rows.map((row) => row.kind))
        .toEqual(["back", "needs_you", "parent", "child"]);
    expect(rows[0]?.sessionId).toBe("sess-o");
    expect(rows[1]?.label).toBe("bash rm notes.txt (approval)");
    expect(rows[2]?.label).toBe("refactor sweep");
    expect(rows[3]?.detail).toBe("working");
});

test("the current session never lists itself, and no session repeats", () => {
    const rows = buildJumpRows({
        currentId: "sess-a",
        back: {
            sessionId: "sess-b",
            sessionPath: "/sessions/b.jsonl",
            title: "came from here",
        },
        // The back target also needs the user: it keeps the needs-you label,
        // because why you would go matters more than how you got here.
        needsYou: [
            needsYouRow(),
            needsYouRow({ id: "row-2", session_id: "sess-a" }),
        ],
        agents: [agent({ id: "sess-a" })],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("needs_you");
    expect(rows[0]?.sessionId).toBe("sess-b");
});

test("an empty menu never opens", () => {
    expect(openJumpMenu([])).toBeUndefined();
});

test("arrows wrap, enter jumps to the selection, escape cancels", () => {
    const state = openJumpMenu(buildJumpRows({
        currentId: "sess-a",
        back: undefined,
        needsYou: [
            needsYouRow(),
            needsYouRow({ id: "row-2", session_id: "sess-c" }),
        ],
        agents: [],
    }));
    if (state === undefined) throw new Error("expected a menu");

    expect(state.selected).toBe(0);
    const down = handleJumpMenuKey(state, "down");
    if (down.kind !== "state") throw new Error("expected movement");
    expect(down.state.selected).toBe(1);
    const wrapped = handleJumpMenuKey(down.state, "down");
    if (wrapped.kind !== "state") throw new Error("expected movement");
    expect(wrapped.state.selected).toBe(0);
    const up = handleJumpMenuKey(state, "up");
    if (up.kind !== "state") throw new Error("expected movement");
    expect(up.state.selected).toBe(1);

    const jump = handleJumpMenuKey(down.state, "return");
    if (jump.kind !== "jump") throw new Error("expected a jump");
    expect(jump.row.sessionId).toBe("sess-c");
    expect(handleJumpMenuKey(state, "escape")).toEqual({ kind: "cancel" });
});

test("menu lines interleave group headers and mark the selection", () => {
    const state = openJumpMenu(buildJumpRows({
        currentId: "sess-a",
        back: {
            sessionId: "sess-o",
            sessionPath: "/sessions/o.jsonl",
            title: "origin",
        },
        needsYou: [needsYouRow()],
        agents: [agent({ id: "sess-c", parent_id: "sess-a" })],
    }));
    if (state === undefined) throw new Error("expected a menu");

    const lines = jumpMenuLines(state, 60);
    expect(lines.map((line) => line.role))
        .toEqual(["header", "row", "header", "row", "header", "row"]);
    expect(lines[0]?.text).toBe("Back");
    expect(lines[1]?.selected).toBe(true);
    expect(lines[1]?.text).toContain("> ← origin");
    expect(lines[2]?.text).toBe("Needs you");
    expect(lines[3]?.rowIndex).toBe(1);
    expect(lines[4]?.text).toBe("This session");
});
