import { describe, expect, test } from "bun:test";
import {
    applyWorkspaceWorkIndex,
    clampWorkspaceRailColumns,
    handleWorkspaceSidebarKey,
    openWorkspaceSelection,
    refreshWorkspaceSidebarSessions,
    startWorkspaceSidebar,
    workspaceRailColumns,
    toggleWorkspacePin,
    workIndexStatus,
    workspaceJumpTarget,
    workspaceSidebarLayout,
    workspaceSidebarSessions,
    workspaceSidebarText,
    workspaceSidebarViewState,
    type WorkspaceSidebarSession,
    type WorkspaceSidebarState,
} from "../../clients/tui/workspace-sidebar.ts";
import { PINNED_GROUP } from "../../clients/tui/workspace-panel.ts";
import { tuiBindingId } from "../../clients/tui/keymap.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import type {
    WorkIndexSnapshot,
    WorkRow,
} from "../../src/host/work-index.ts";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const COLUMNS = 120;

function session(
    id: string,
    overrides: Partial<WorkspaceSidebarSession> = {},
): WorkspaceSidebarSession {
    return {
        id,
        title: `session ${id}`,
        workspace: "/w/one",
        sessionPath: `/sessions/${id}.jsonl`,
        kind: "interactive",
        status: "idle",
        live: false,
        updatedAt: "2026-08-22T11:00:00.000Z",
        ...overrides,
    };
}

function open(
    sessions: readonly WorkspaceSidebarSession[],
    pinned: readonly string[] = [],
    currentId?: string,
): WorkspaceSidebarState {
    return startWorkspaceSidebar(sessions, pinned, currentId);
}

function press(
    state: WorkspaceSidebarState,
    name: string,
    modifiers: { ctrl?: boolean; shift?: boolean } = {},
) {
    return handleWorkspaceSidebarKey(
        state,
        { name, ...modifiers },
        NOW,
        COLUMNS,
    );
}

function workRow(overrides: Partial<WorkRow> & { session_id: string }): WorkRow {
    return {
        id: `row-${overrides.session_id}`,
        session_path: `/sessions/${overrides.session_id}.jsonl`,
        title: "row",
        section: "working",
        summary: "",
        workspace: "/w/one",
        updated_at: "2026-08-22T11:30:00.000Z",
        ...overrides,
    };
}

function index(rows: readonly WorkRow[]): WorkIndexSnapshot {
    return {
        rows,
        needs_you: rows.filter((row) => row.section === "needs_you").length,
        working: rows.filter((row) => row.section === "working").length,
    };
}

describe("the registry listing", () => {
    test("carries the session path each row resumes by", () => {
        const agents: readonly RegisteredAgentSummary[] = [{
            id: "a",
            workspace: "/w/one",
            session_path: "/sessions/a.jsonl",
            kind: "interactive",
            status: "working",
            live: true,
            title: "one",
            updated_at: "2026-08-22T11:00:00.000Z",
        }];
        expect(workspaceSidebarSessions(agents)).toEqual([{
            id: "a",
            workspace: "/w/one",
            sessionPath: "/sessions/a.jsonl",
            kind: "interactive",
            status: "working",
            live: true,
            title: "one",
            updatedAt: "2026-08-22T11:00:00.000Z",
        }]);
    });
});

describe("the roster read again", () => {
    test("lists a session that arrived while the pane was open", () => {
        const state = open([session("a")], [], "a");
        const refreshed = refreshWorkspaceSidebarSessions(
            state,
            [session("a"), session("b")],
        );
        expect(workspaceSidebarText(refreshed, COLUMNS, NOW))
            .toContain("session b");
    });

    test("keeps the cursor, the pins and the session on screen", () => {
        const state = press(
            open([session("a"), session("b")], ["b"], "a"),
            "down",
        ).state!;
        const refreshed = refreshWorkspaceSidebarSessions(
            state,
            [session("a"), session("b"), session("c")],
        );
        expect(refreshed.selectedId).toBe(state.selectedId);
        expect(refreshed.pinnedIds).toEqual(["b"]);
        expect(refreshed.currentId).toBe("a");
    });

    test("a cursor whose session has gone lands on a listed one", () => {
        const state = open([session("a"), session("b")], [], "a");
        const refreshed = refreshWorkspaceSidebarSessions(state, [session("b")]);
        expect(workspaceSidebarLayout(refreshed, { columns: COLUMNS, now: NOW })
            .selectedId).toBe("b");
    });
});

describe("the rail", () => {
    test("is as wide as the longest row it can draw", () => {
        for (const columns of [120, 90]) {
            const rail = workspaceRailColumns(columns)!;
            const drawn = workspaceSidebarText(
                open([session("a"), session("b")], [], "a"),
                columns,
                NOW,
            ).split("\n");
            for (const line of drawn) {
                expect(line.length).toBeLessThanOrEqual(rail);
            }
        }
    });

    test("is narrower at the medium width than at the wide one", () => {
        expect(workspaceRailColumns(90)!)
            .toBeLessThan(workspaceRailColumns(120)!);
    });

    test("there is no rail where there is no room for two columns", () => {
        expect(workspaceRailColumns(60)).toBeUndefined();
    });

    test("a preferred width is clamped before either column becomes unusable", () => {
        expect(workspaceRailColumns(120, 20)).toBe(26);
        expect(workspaceRailColumns(120, 500)).toBe(83);
        expect(clampWorkspaceRailColumns(58.4, 120)).toBe(58);
        expect(workspaceRailColumns(60, 40)).toBeUndefined();
    });

    test("keeps age while squeezing, then gives its space to the title", () => {
        const state = open([session("a", {
            title: "a useful descriptive session name",
            updatedAt: "2026-08-22T11:56:00.000Z",
        })], [], "a");
        const withAge = workspaceSidebarViewState(state, 120, NOW, 37)
            .lines.find((line) => line.rowId === "a")?.text;
        const titleOnly = workspaceSidebarViewState(state, 120, NOW, 26)
            .lines.find((line) => line.rowId === "a")?.text;

        expect(withAge).toContain("4m ago (here)");
        expect(titleOnly).not.toContain("ago");
        expect(titleOnly).toContain("a useful de… (here)");
    });

    test("marks when the explorer owns keyboard focus", () => {
        const state = open([session("a")], [], "a");

        const focused = workspaceSidebarViewState(
            state,
            120,
            NOW,
            37,
            true,
            4,
        );
        expect(focused.title).toBe("[   ] Workspace · 1");
        const chat = workspaceSidebarViewState(state, 120, NOW, 37, false, 4);
        expect(chat.title).toBe("      Workspace · 1");
    });
});

describe("the cursor", () => {
    test("opens on the session already on screen", () => {
        const state = open([session("a"), session("b")], [], "b");
        expect(state.selectedId).toBe("b");
        expect(state.currentId).toBe("b");
    });

    test("down and up move it and stop at the ends", () => {
        let state = open([session("a"), session("b")], [], "a");
        state = press(state, "down").state!;
        expect(state.selectedId).toBe("b");
        state = press(state, "down").state!;
        expect(state.selectedId).toBe("b");
        state = press(state, "up").state!;
        expect(state.selectedId).toBe("a");
        state = press(state, "up").state!;
        expect(state.selectedId).toBe("a");
    });

    test("j and k move it like down and up", () => {
        let state = open([session("a"), session("b")], [], "a");
        state = press(state, "j").state!;
        expect(state.selectedId).toBe("b");
        state = press(state, "k").state!;
        expect(state.selectedId).toBe("a");
    });

    test("enter opens the session under the cursor", () => {
        const state = open([session("a"), session("b")], [], "a");
        const moved = press(state, "down").state!;
        expect(press(moved, "return").action).toEqual({
            kind: "open_session",
            session_id: "b",
            session_path: "/sessions/b.jsonl",
        });
    });

    test("escape returns to chat", () => {
        expect(press(open([session("a")]), "escape").action)
            .toEqual({ kind: "close" });
    });

    test("i returns to chat", () => {
        expect(press(open([session("a")]), "i").action)
            .toEqual({ kind: "close" });
    });

    test("a bare key it does not use is swallowed, a chord is not", () => {
        const state = open([session("a")]);
        expect(press(state, "z").handled).toBe(true);
        expect(press(state, "e", { ctrl: true }).handled).toBe(false);
        expect(press(state, "c", { ctrl: true }).handled).toBe(false);
    });
});

describe("clicking a row", () => {
    test("activates the row the mouse named, not the cursor", () => {
        const state = open([session("a"), session("b")], [], "a");
        expect(openWorkspaceSelection(state, "b")).toEqual({
            kind: "open_session",
            session_id: "b",
            session_path: "/sessions/b.jsonl",
        });
    });

    test("a row id that is not listed activates nothing", () => {
        expect(openWorkspaceSelection(open([session("a")]), "gone"))
            .toBeUndefined();
    });
});

describe("the digits", () => {
    test("address the top nine visible rows in listing order", () => {
        const sessions = Array.from(
            { length: 11 },
            (_unused, at) =>
                session(`s${at}`, {
                    updatedAt: `2026-08-22T1${9 - at}:00:00.000Z`,
                }),
        );
        const layout = workspaceSidebarLayout(open(sessions), {
            columns: COLUMNS,
            now: NOW,
        });
        expect(workspaceJumpTarget(layout, 1)).toBe(layout.selectable[0]);
        expect(workspaceJumpTarget(layout, 9)).toBe(layout.selectable[8]);
        expect(workspaceJumpTarget(layout, 10)).toBeUndefined();
    });

    test("a digit past the end of the listing does nothing", () => {
        const state = open([session("a")]);
        expect(press(state, "3").action).toBeUndefined();
        expect(press(state, "3").handled).toBe(true);
    });

    test("pressing 2 opens the second row", () => {
        const state = open([
            session("a", { updatedAt: "2026-08-22T11:59:00.000Z" }),
            session("b", { updatedAt: "2026-08-22T11:58:00.000Z" }),
        ]);
        expect(tuiBindingId("workspace", { name: "2" }))
            .toBe("workspace_jump_2");
        expect(press(state, "2").action).toEqual({
            kind: "open_session",
            session_id: "b",
            session_path: "/sessions/b.jsonl",
        });
    });
});

describe("pinning", () => {
    test("p toggles the pin on the selected session", () => {
        const state = open([session("a"), session("b")], [], "a");
        const pinned = press(state, "p");
        expect(pinned.action).toEqual({ kind: "pin", pinnedIds: ["a"] });
        expect(pinned.state?.pinnedIds).toEqual(["a"]);
        expect(press(pinned.state!, "p").state?.pinnedIds).toEqual([]);
    });

    test("toggling keeps the order of the pins it did not touch", () => {
        expect(toggleWorkspacePin(["a", "b", "c"], "b")).toEqual(["a", "c"]);
        expect(toggleWorkspacePin(["a"], "b")).toEqual(["a", "b"]);
    });

    test("a pinned session sorts to the top under its own heading", () => {
        const layout = workspaceSidebarLayout(
            open([
                session("a", { updatedAt: "2026-08-22T11:59:00.000Z" }),
                session("b", { updatedAt: "2026-08-22T10:00:00.000Z" }),
            ], ["b"]),
            { columns: COLUMNS, now: NOW },
        );
        expect(layout.selectable[0]).toBe("b");
        expect(layout.rows[0]).toMatchObject({
            kind: "group",
            group: PINNED_GROUP,
        });
    });
});

describe("status from the pushed work index", () => {
    test("reads a section and a reason as a session status", () => {
        const snapshot = index([
            workRow({ session_id: "a", section: "needs_you", reason: "approval" }),
            workRow({ session_id: "b", section: "working" }),
            workRow({ session_id: "c", section: "working", reason: "failure" }),
            workRow({ session_id: "d", section: "done_recently" }),
        ]);
        expect(workIndexStatus(snapshot, "a")).toBe("waiting");
        expect(workIndexStatus(snapshot, "b")).toBe("working");
        expect(workIndexStatus(snapshot, "c")).toBe("failed");
        expect(workIndexStatus(snapshot, "d")).toBe("completed");
        expect(workIndexStatus(snapshot, "missing")).toBeUndefined();
    });

    test("a snapshot restates the listed rows and leaves the rest alone", () => {
        const state = open([session("a"), session("b")]);
        const next = applyWorkspaceWorkIndex(
            state,
            index([workRow({ session_id: "a", section: "needs_you" })]),
        );
        expect(next.sessions[0]?.status).toBe("waiting");
        expect(next.sessions[0]?.updatedAt).toBe("2026-08-22T11:30:00.000Z");
        expect(next.sessions[1]?.status).toBe("idle");
    });

    test("attention completion cannot overwrite a terminal roster status", () => {
        const state = open([
            session("failed", { status: "failed" }),
            session("closed", { status: "closed" }),
        ]);
        const next = applyWorkspaceWorkIndex(
            state,
            index([
                workRow({ session_id: "failed", section: "done_recently" }),
                workRow({ session_id: "closed", section: "done_recently" }),
            ]),
        );
        expect(next.sessions.map((entry) => entry.status))
            .toEqual(["failed", "closed"]);
    });

    test("the marker survives a monochrome render", () => {
        const state = applyWorkspaceWorkIndex(
            open([
                session("a", { title: "needs you" }),
                session("b", { title: "running" }),
            ]),
            index([
                workRow({ session_id: "a", section: "needs_you" }),
                workRow({ session_id: "b", section: "working" }),
            ]),
        );
        const text = workspaceSidebarText(state, COLUMNS, NOW);
        expect(text).toContain("? needs you");
        expect(text).toContain("* running");
    });
});

describe("the drawn card", () => {
    test("names the session on screen in words", () => {
        const text = workspaceSidebarText(
            open([session("a"), session("b")], [], "b"),
            COLUMNS,
            NOW,
        );
        expect(text.split("\n").filter((line) => line.includes("(here)")))
            .toHaveLength(1);
    });

    test("numbers the top nine rows and stops", () => {
        const sessions = Array.from(
            { length: 10 },
            (_unused, at) =>
                session(`s${at}`, {
                    updatedAt: `2026-08-22T1${9 - at}:00:00.000Z`,
                }),
        );
        const lines = workspaceSidebarText(open(sessions), COLUMNS, NOW)
            .split("\n").filter((line) => line.includes("session s"));
        expect(lines[0]?.startsWith("1 ")).toBe(true);
        expect(lines[8]?.startsWith("9 ")).toBe(true);
        expect(lines[9]?.startsWith(" ")).toBe(true);
    });

    test("carries its own footer hint, in the pickers' shape", () => {
        // Measured against what is drawn: the card at this width is most of
        // the terminal, so it has room for the words.
        const view = workspaceSidebarViewState(open([session("a")]), 70, NOW);
        expect(view.footer)
            .toBe("↑↓/jk browse · enter open · 1-9 jump · p pin · i/esc chat");
        expect(view.title).toBe("      Workspace · 1");
    });

    test("the rail takes the short hint, wide as the terminal is", () => {
        const view = workspaceSidebarViewState(
            open([session("a")]),
            COLUMNS,
            NOW,
        );
        // A rail is as narrow as its rows whatever the terminal is, so the
        // hint is measured against the column and not against the screen.
        expect(view.footer).toBe("↑↓/jk enter 1-9 p i/esc");
        expect(view.footer.length)
            .toBeLessThanOrEqual(workspaceRailColumns(COLUMNS)!);
    });

    test("an empty listing says so rather than drawing nothing", () => {
        expect(workspaceSidebarText(open([]), COLUMNS, NOW))
            .toBe("No other sessions.");
    });

    test("the cursor line is where the card scrolls to", () => {
        const view = workspaceSidebarViewState(
            open([session("a"), session("b")], [], "b"),
            COLUMNS,
            NOW,
        );
        expect(view.lines[view.cursorLine!]?.selected).toBe(true);
    });
});
