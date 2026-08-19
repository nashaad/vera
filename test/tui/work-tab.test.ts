import { expect, test } from "bun:test";

import {
    buildWorkIndex,
    type WorkAgentFacts,
    type WorkIndexSnapshot,
} from "../../src/host/work-index.ts";
import {
    firstWorkRowId,
    moveWorkTabSelection,
    reselectWorkRow,
    tuiWorkTabFooter,
    tuiWorkTabHeader,
    tuiWorkTabLines,
    tuiWorkTabText,
    workTabAction,
} from "../../clients/tui/work-tab.ts";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const now = () => NOW.getTime();

function agent(overrides: Partial<WorkAgentFacts>): WorkAgentFacts {
    return {
        id: "agent",
        session_path: "/sessions/agent.jsonl",
        title: "agent",
        workspace: "/w",
        kind: "interactive",
        status: "idle",
        live: true,
        updated_at: "2026-08-14T11:58:00.000Z",
        ...overrides,
    };
}

function inbox(): WorkIndexSnapshot {
    return buildWorkIndex([
        agent({
            id: "auth-race",
            title: "auth-race",
            status: "waiting",
            updated_at: "2026-08-14T11:58:00.000Z",
            pending_request: {
                type: "tool_approval",
                toolCall: {
                    id: "call",
                    name: "bash",
                    input: { command: "bun migrate --production" },
                },
                reason: "",
                warning: "",
            },
        }),
        agent({
            id: "browser-tests",
            title: "browser-tests",
            status: "waiting",
            updated_at: "2026-08-14T11:54:00.000Z",
            pending_request: {
                type: "user_question",
                question: "Which environment fails?",
                choices: [],
            },
        }),
        agent({
            id: "relay-gui",
            title: "relay-gui",
            status: "working",
            active_tool: "edit",
            updated_at: "2026-08-14T11:51:00.000Z",
        }),
        agent({
            id: "sub-one",
            kind: "background",
            status: "working",
            parent_id: "relay-gui",
        }),
        agent({
            id: "sub-two",
            kind: "background",
            status: "working",
            parent_id: "relay-gui",
        }),
        agent({
            id: "memory-retrieval",
            title: "memory-retrieval",
            status: "working",
            active_tool: "bash",
            updated_at: "2026-08-14T11:50:00.000Z",
        }),
        agent({
            id: "provider-fallback",
            title: "provider-fallback",
            kind: "background",
            status: "completed",
            unread_result: true,
            updated_at: "2026-08-14T11:46:00.000Z",
        }),
    ], [], { now });
}

test("the header states the live counts", () => {
    expect(tuiWorkTabHeader(inbox())).toBe("Work · 2 need you · 2 working");
    expect(tuiWorkTabHeader(buildWorkIndex([], [], { now }))).toBe("Work");
});

test("the sections are drawn in order with their rows under them", () => {
    const lines = tuiWorkTabLines(inbox(), { width: 78, now: NOW });
    const sections = lines
        .filter((line) => line.kind === "section")
        .map((line) => line.text);

    expect(sections).toEqual(["Needs you", "Working", "Done recently"]);
    expect(lines.filter((line) => line.kind === "row").map((line) => line.row_id))
        .toEqual([
            "auth-race",
            "browser-tests",
            "relay-gui",
            "memory-retrieval",
            "provider-fallback",
        ]);
});

test("a wide row states its reason, summary, subagents and age", () => {
    const text = tuiWorkTabText(inbox(), {
        width: 78,
        selectedId: "auth-race",
        now: NOW,
    });
    const lines = text.split("\n");

    const approval = lines.find((line) => line.includes("auth-race")) ?? "";
    expect(approval.startsWith("> ")).toBe(true);
    expect(approval).toContain("Approval");
    expect(approval).toContain("bun migrate --production");
    expect(approval).toContain("2m ago");

    const parent = lines.find((line) => line.includes("relay-gui")) ?? "";
    expect(parent).toContain("Running edit");
    expect(parent).toContain("2 subagents");

    const solo = lines.find((line) => line.includes("memory-retrieval")) ?? "";
    expect(solo).not.toContain("subagent");
});

test("a summary that only repeats its section heading is dropped", () => {
    const index = buildWorkIndex([
        agent({ id: "quiet", title: "quiet", status: "working" }),
    ], [], { now });
    const line = tuiWorkTabText(index, { width: 78, now: NOW })
        .split("\n")
        .find((candidate) => candidate.includes("quiet")) ?? "";

    // The section header already says Working; the row saying it again is
    // noise, and the tool name still shows when there is one.
    expect(line).not.toContain("Working");
    expect(line).toContain("quiet");
});

test("the title column widens with the terminal to keep identity readable", () => {
    const longTitle = "a".repeat(38);
    const index = buildWorkIndex([
        agent({
            id: "titled",
            title: longTitle,
            status: "working",
            active_tool: "bash",
        }),
    ], [], { now });
    const row = (width: number) =>
        tuiWorkTabText(index, { width, now: NOW })
            .split("\n")
            .find((candidate) => candidate.includes("aaaa")) ?? "";

    // At 78 columns the title gets a third of the row; at 120 it reaches
    // the cap and shows whole.
    expect(row(78)).toContain("a".repeat(24));
    expect(row(78)).not.toContain(longTitle);
    expect(row(120)).toContain(longTitle);
});

test("no row is wider than the terminal, at either width", () => {
    for (const width of [78, 42]) {
        for (const line of tuiWorkTabLines(inbox(), { width, now: NOW })) {
            expect(line.text.length, `${width}: ${line.text}`)
                .toBeLessThanOrEqual(width);
        }
    }
});

test("a narrow terminal drops the reason column and the blank lines", () => {
    const lines = tuiWorkTabLines(inbox(), { width: 42, now: NOW });

    expect(lines.some((line) => line.kind === "blank")).toBe(false);
    const approval = lines.find((line) => line.row_id === "auth-race")?.text ?? "";
    expect(approval).not.toContain("Approval");
    expect(approval).toContain("auth-race");
    expect(approval).toContain("2m ago");
});

test("the footer shortens with the terminal", () => {
    expect(tuiWorkTabFooter(78)).toBe("↑↓ select   enter open   esc back");
    expect(tuiWorkTabFooter(42)).toBe("↑↓ enter esc");
});

test("an empty inbox says so rather than drawing empty sections", () => {
    const lines = tuiWorkTabLines(buildWorkIndex([], [], { now }), {
        width: 78,
        now: NOW,
    });

    expect(lines).toEqual([
        { kind: "empty", text: "Nothing is waiting on you." },
    ]);
});

test("selection opens on the most urgent row and clamps at both ends", () => {
    const index = inbox();
    const first = firstWorkRowId(index);
    expect(first).toBe("auth-race");

    expect(moveWorkTabSelection(index, first, -1)).toBe("auth-race");
    expect(moveWorkTabSelection(index, first, 1)).toBe("browser-tests");
    expect(moveWorkTabSelection(index, "provider-fallback", 1))
        .toBe("provider-fallback");
    expect(moveWorkTabSelection(index, "gone", 1)).toBe("auth-race");
    expect(moveWorkTabSelection(buildWorkIndex([], [], { now }), first, 1))
        .toBeUndefined();
});

test("a row that leaves the inbox hands the cursor to its neighbour", () => {
    const before = inbox();
    const after = buildWorkIndex(
        [
            agent({
                id: "browser-tests",
                title: "browser-tests",
                status: "waiting",
                pending_request: {
                    type: "user_question",
                    question: "Which environment fails?",
                    choices: [],
                },
            }),
        ],
        [],
        { now },
    );

    expect(reselectWorkRow(before, after, "auth-race")).toBe("browser-tests");
    expect(reselectWorkRow(before, before, "relay-gui")).toBe("relay-gui");
    expect(reselectWorkRow(before, buildWorkIndex([], [], { now }), "auth-race"))
        .toBeUndefined();
});

test("enter routes each section to the surface that already owns it", () => {
    const index = inbox();

    expect(workTabAction(index, "auth-race"))
        .toEqual({ kind: "answer_request", session_id: "auth-race" });
    expect(workTabAction(index, "browser-tests"))
        .toEqual({ kind: "answer_request", session_id: "browser-tests" });
    expect(workTabAction(index, "relay-gui"))
        .toEqual({ kind: "open_session", session_id: "relay-gui" });
    expect(workTabAction(index, "provider-fallback"))
        .toEqual({ kind: "open_result", session_id: "provider-fallback" });
    expect(workTabAction(index, "gone")).toBeUndefined();
});

test("only rows carry a row id, so a click cannot land on a section heading", () => {
    const lines = tuiWorkTabLines(inbox(), { width: 78, now: NOW });

    for (const line of lines) {
        expect(line.row_id === undefined, `${line.kind}: ${line.text}`)
            .toBe(line.kind !== "row");
    }
});
