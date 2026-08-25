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
    workspaceSidebarFooter,
    workspaceSidebarHeader,
    workspaceSidebarText,
    workspaceSidebarViewState,
    workspaceWorkingSet,
    workspaceCycleTarget,
    MIN_RAIL_COLUMNS,
    WORKSPACE_RECENT_IDLE,
    type WorkspaceSidebarSession,
    type WorkspaceSidebarState,
} from "../../clients/tui/workspace-sidebar.ts";
import { PINNED_GROUP } from "../../clients/tui/workspace-panel.ts";
import { tuiBrailleSpinner } from "../../clients/tui/activity-pulse.ts";
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
    viewportRows?: number,
) {
    return handleWorkspaceSidebarKey(
        state,
        { name, ...modifiers },
        NOW,
        COLUMNS,
        viewportRows,
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

    test("a parked worker is active even when live is false", () => {
        const agents: readonly RegisteredAgentSummary[] = [{
            id: "parked",
            workspace: "/w/one",
            session_path: "/sessions/parked.jsonl",
            kind: "interactive",
            status: "idle",
            live: false,
            worker_pid: 4242,
            title: "parked",
            updated_at: "2026-08-22T11:00:00.000Z",
        }];
        const sessions = workspaceSidebarSessions(agents);
        expect(sessions[0]?.workerPid).toBe(4242);
        expect(press(open(sessions), "return").action).toEqual({
            kind: "open_session",
            session_id: "parked",
            session_path: "/sessions/parked.jsonl",
            active: true,
        });
    });

    test("hides empty history but keeps an empty live session", () => {
        const agent = (
            id: string,
            live: boolean,
            hasUserContent: boolean | undefined,
        ): RegisteredAgentSummary => ({
            id,
            workspace: "/w/one",
            session_path: `/sessions/${id}.jsonl`,
            kind: "interactive",
            status: live ? "working" : "idle",
            live,
            ...(hasUserContent === undefined
                ? {}
                : { has_user_content: hasUserContent }),
        });

        const sessions = workspaceSidebarSessions([
            agent("empty-history", false, false),
            agent("empty-running", true, false),
            agent("conversation", false, true),
            agent("older-host", false, undefined),
        ]);

        expect(sessions.map((session) => session.id)).toEqual([
            "empty-running",
            "conversation",
            "older-host",
        ]);
    });
});

describe("the working set", () => {
    test("keeps every live session, however many there are", () => {
        const sessions = Array.from({ length: 12 }, (_unused, at) =>
            session(`live-${at}`, { live: true, status: "working" }));
        expect(workspaceWorkingSet(sessions).map((entry) => entry.id))
            .toEqual(sessions.map((entry) => entry.id));
        expect(workspaceSidebarHeader(open(sessions)))
            .toBe("Agent sidebar · 12");
    });

    test("lists idle rows when there are only a few of them", () => {
        const few = [
            session("a"),
            session("b"),
            session("c"),
        ];
        expect(workspaceWorkingSet(few).map((entry) => entry.id))
            .toEqual(["a", "b", "c"]);
    });

    test("keeps the five most recent idle rows when the pile is large", () => {
        const idle = Array.from({ length: 8 }, (_unused, at) =>
            session(`idle-${at}`, {
                updatedAt: `2026-08-22T11:0${at}:00.000Z`,
            }));
        const sessions = [
            ...idle,
            session("live", { live: true, status: "working" }),
        ];
        expect(workspaceWorkingSet(sessions).map((entry) => entry.id))
            .toEqual([
                "idle-3",
                "idle-4",
                "idle-5",
                "idle-6",
                "idle-7",
                "live",
            ]);
        expect(workspaceWorkingSet(sessions)).toHaveLength(
            WORKSPACE_RECENT_IDLE + 1,
        );
        expect(workspaceSidebarHeader(open(sessions)))
            .toBe("Agent sidebar · 6");
    });

    test("an older second project stays listed when the session on screen already made the last five", () => {
        const sessions = [
            session("whats-this", {
                title: "whats this",
                workspace: "/w/vera",
                updatedAt: "2026-08-22T11:57:00.000Z",
            }),
            session("ask-one", {
                title: "ask me a question",
                workspace: "/w/vera",
                updatedAt: "2026-08-22T11:54:00.000Z",
            }),
            session("ask-two", {
                title: "ask me a question",
                workspace: "/w/vera",
                updatedAt: "2026-08-22T11:53:00.000Z",
            }),
            session("we-made", {
                title: "we made a bunch",
                workspace: "/w/vera",
                updatedAt: "2026-08-22T11:52:00.000Z",
            }),
            session("add-to", {
                title: "add to workspace",
                workspace: "/w/vera",
                updatedAt: "2026-08-22T11:51:00.000Z",
            }),
            session("please-configure", {
                title: "please configure",
                workspace: "/w/test-do-serverless",
                updatedAt: "2026-08-22T11:50:00.000Z",
            }),
        ];
        const withOlderCurrent = workspaceWorkingSet(sessions, "add-to");
        const withNewerCurrent = workspaceWorkingSet(sessions, "we-made");
        expect(withOlderCurrent.map((entry) => entry.id)).toEqual([
            "whats-this",
            "ask-one",
            "ask-two",
            "we-made",
            "add-to",
            "please-configure",
        ]);
        expect(withNewerCurrent.map((entry) => entry.id))
            .toEqual(withOlderCurrent.map((entry) => entry.id));
        const text = workspaceSidebarText(
            open(sessions, [], "we-made"),
            COLUMNS,
            NOW,
        );
        expect(text).toContain("test-do-serverless");
        expect(text).not.toContain("/w/test-do-serverless");
        expect(text).toContain("please configure");
        expect(text).toContain("we made a bunch");
        expect(text).not.toContain("[ we made a bunch ]");
    });

    test("keeps the idle session on screen even when it is older than the last five", () => {
        const sessions = [
            session("live", { live: true, status: "working" }),
            session("current", { updatedAt: "2026-08-22T10:00:00.000Z" }),
            session("idle-1", { updatedAt: "2026-08-22T11:01:00.000Z" }),
            session("idle-2", { updatedAt: "2026-08-22T11:02:00.000Z" }),
            session("idle-3", { updatedAt: "2026-08-22T11:03:00.000Z" }),
            session("idle-4", { updatedAt: "2026-08-22T11:04:00.000Z" }),
            session("idle-5", { updatedAt: "2026-08-22T11:05:00.000Z" }),
            session("idle-6", { updatedAt: "2026-08-22T11:06:00.000Z" }),
        ];
        expect(workspaceWorkingSet(sessions, "current").map((entry) => entry.id))
            .toEqual([
                "live",
                "current",
                "idle-2",
                "idle-3",
                "idle-4",
                "idle-5",
                "idle-6",
            ]);
        expect(workspaceSidebarText(open(sessions, [], "current"), COLUMNS, NOW))
            .toContain("session current");
        expect(workspaceSidebarText(open(sessions, [], "current"), COLUMNS, NOW))
            .not.toContain("[ session current ]");
        expect(workspaceSidebarText(open(sessions, [], "current"), COLUMNS, NOW))
            .toContain("session idle-6");
        expect(workspaceSidebarText(open(sessions, [], "current"), COLUMNS, NOW))
            .not.toContain("session idle-1");
    });

    test("keeps a pinned idle session that is older than the last five", () => {
        const sessions = Array.from({ length: 6 }, (_unused, at) =>
            session(`idle-${at}`, {
                updatedAt: `2026-08-22T11:0${at}:00.000Z`,
            }));
        expect(workspaceWorkingSet(sessions, undefined, ["idle-0"]).map(
            (entry) => entry.id,
        )).toEqual([
            "idle-0",
            "idle-1",
            "idle-2",
            "idle-3",
            "idle-4",
            "idle-5",
        ]);
        expect(workspaceSidebarText(open(sessions, ["idle-0"]), COLUMNS, NOW))
            .toContain("session idle-0");
    });
});

describe("cycling live sessions", () => {
    test("next and previous walk live rows and skip parked jsonl", () => {
        const state = open(
            [
                session("a", {
                    live: true,
                    status: "working",
                    updatedAt: "2026-08-22T11:02:00.000Z",
                }),
                session("parked"),
                session("b", {
                    live: true,
                    status: "idle",
                    updatedAt: "2026-08-22T11:01:00.000Z",
                }),
            ],
            [],
            "a",
        );
        expect(workspaceCycleTarget(state, 1, NOW, COLUMNS)?.id).toBe("b");
        expect(workspaceCycleTarget(state, -1, NOW, COLUMNS)?.id).toBe("b");
        expect(workspaceCycleTarget(
            { ...state, currentId: "b" },
            1,
            NOW,
            COLUMNS,
        )?.id).toBe("a");
    });

    test("looking at a parked file still lands on a live neighbour", () => {
        const state = open(
            [
                session("live", { live: true, status: "working" }),
                session("parked"),
            ],
            [],
            "parked",
        );
        expect(workspaceCycleTarget(state, 1, NOW, COLUMNS)?.id).toBe("live");
        expect(workspaceCycleTarget(state, -1, NOW, COLUMNS)?.id).toBe("live");
    });

    test("one live session already on screen is a no-op", () => {
        const state = open(
            [session("only", { live: true, status: "working" })],
            [],
            "only",
        );
        expect(workspaceCycleTarget(state, 1, NOW, COLUMNS)).toBeUndefined();
        expect(workspaceCycleTarget(state, -1, NOW, COLUMNS)).toBeUndefined();
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
        expect(workspaceRailColumns(120, 20)).toBe(28);
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
        const titleOnly = workspaceSidebarViewState(state, 120, NOW, 23)
            .lines.find((line) => line.rowId === "a")?.text;

        expect(withAge).toContain("a useful descriptive…");
        expect(withAge).toContain("4m ago");
        expect(withAge).not.toContain("[");
        expect(titleOnly).not.toContain("ago");
        expect(titleOnly).toContain("a useful descri…");
        expect(titleOnly).not.toContain("[");
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
        expect(focused.title).toBe("[   ] Agent sidebar · 1");
        const chat = workspaceSidebarViewState(state, 120, NOW, 37, false, 4);
        expect(chat.title).toBe("      Agent sidebar · 1");
    });

    test("dims when the rail is up and chat has focus", () => {
        const state = open([session("a"), session("b")], [], "a");
        const focused = workspaceSidebarViewState(state, 120, NOW, 37, true);
        const chat = workspaceSidebarViewState(state, 120, NOW, 37, false);
        expect(focused.dimmed).toBeUndefined();
        expect(focused.lines.some((line) => line.selected === true)).toBe(true);
        expect(focused.lines.find((line) => line.rowId === "a")?.tone)
            .toBe("text");
        expect(chat.dimmed).toBe(true);
        expect(chat.lines.some((line) => line.selected === true)).toBe(true);
        expect(chat.lines.every((line) => line.tone === "muted")).toBe(true);
        expect(chat.lines.find((line) => line.rowId === "a")?.text)
            .toContain("❯");
        expect(chat.cursorLine).toBe(focused.cursorLine);
    });

    test("draws folder headings in the heading tone and gaps the groups", () => {
        const state = open([
            session("a", { workspace: "/w/one", live: true, status: "working" }),
            session("b", {
                workspace: "/w/two",
                live: true,
                status: "working",
                updatedAt: "2026-08-22T10:00:00.000Z",
            }),
        ], [], "a");
        const focused = workspaceSidebarViewState(state, 120, NOW, 37, true);
        const headings = focused.lines.filter((line) => line.tone === "heading");
        expect(headings.map((line) => line.text)).toEqual(["one", "two"]);
        const first = focused.lines.findIndex((line) => line.text === "one");
        const second = focused.lines.findIndex((line) => line.text === "two");
        expect(focused.lines[second - 1]?.text).toBe("");
        expect(second).toBeGreaterThan(first);
        expect(focused.hint).toBe("");
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

    test("ctrl+d and ctrl+u jump half a page without opening", () => {
        const sessions = Array.from({ length: 10 }, (_unused, at) =>
            session(`s${at}`, {
                live: true,
                status: "working",
                updatedAt: `2026-08-22T1${9 - at}:00:00.000Z`,
            }));
        const state = open(sessions, [], "s0");
        const down = press(state, "d", { ctrl: true }, 6);
        expect(down.handled).toBe(true);
        expect(down.action).toBeUndefined();
        expect(down.state?.selectedId).toBe("s3");
        const up = press(down.state!, "u", { ctrl: true }, 6);
        expect(up.handled).toBe(true);
        expect(up.action).toBeUndefined();
        expect(up.state?.selectedId).toBe("s0");
    });

    test("enter opens the session under the cursor", () => {
        const state = open([session("a"), session("b")], [], "a");
        const moved = press(state, "down").state!;
        expect(press(moved, "return").action).toEqual({
            kind: "open_session",
            session_id: "b",
            session_path: "/sessions/b.jsonl",
            active: false,
        });
    });

    test("escape hides the rail", () => {
        expect(press(open([session("a")]), "escape").action)
            .toEqual({ kind: "hide" });
    });

    test("i returns to chat and leaves the rail up", () => {
        expect(press(open([session("a")]), "i").action)
            .toEqual({ kind: "close" });
    });

    test("ctrl+n starts a new chat without opening a row", () => {
        expect(press(open([session("a")]), "n", { ctrl: true }))
            .toEqual({ action: { kind: "new_session" }, handled: true });
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
            active: false,
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
            active: false,
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
        expect(text).toContain("! needs you");
        expect(text).toContain(`${tuiBrailleSpinner(0)} running`);
    });
});

describe("the drawn card", () => {
    test("the session on screen is not wrapped in brackets", () => {
        const text = workspaceSidebarText(
            open([session("a"), session("b")], [], "b"),
            COLUMNS,
            NOW,
        );
        expect(text).toContain("session b");
        expect(text).not.toContain("[ session b ]");
        expect(text).not.toContain("(here)");
        expect(text).not.toContain("● session b");
    });

    test("an idle session you are looking at still reads as completed", () => {
        const text = workspaceSidebarText(
            open(
                [session("a", {
                    title: "count to 5",
                    status: "idle",
                    live: true,
                    updatedAt: "2026-08-22T11:55:00.000Z",
                })],
                [],
                "a",
            ),
            COLUMNS,
            NOW,
        );
        expect(text).toContain("● count to 5");
        expect(text).toContain("❯");
        expect(text).not.toContain("[ count to");
    });

    test("an idle file view is not marked completed", () => {
        const text = workspaceSidebarText(
            open(
                [session("a", {
                    title: "do you know",
                    status: "idle",
                    live: false,
                })],
                [],
                "a",
            ),
            COLUMNS,
            NOW,
        );
        expect(text).toContain("do you know");
        expect(text).not.toContain("● do you know");
        expect(text).toContain("❯");
    });

    test("a live finished turn older than ten minutes is blank", () => {
        const text = workspaceSidebarText(
            open(
                [session("a", {
                    title: "count to 5",
                    status: "idle",
                    live: true,
                    updatedAt: "2026-08-22T11:49:00.000Z",
                })],
                [],
                "a",
            ),
            COLUMNS,
            NOW,
        );
        expect(text).toContain("count to 5");
        expect(text).not.toContain("● count to 5");
    });

    test("numbers the top nine rows and stops", () => {
        const sessions = Array.from(
            { length: 10 },
            (_unused, at) =>
                session(`s${at}`, {
                    live: true,
                    status: "working",
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
            .toBe("↑↓/jk ^d^u browse · enter open · 1-9 jump · p pin · ctrl+n new · i chat · esc hide");
        expect(view.title).toBe("      Agent sidebar · 1");
    });

    test("the rail takes the short hint, wide as the terminal is", () => {
        const view = workspaceSidebarViewState(
            open([session("a")]),
            COLUMNS,
            NOW,
        );
        // A rail is as narrow as its rows whatever the terminal is, so the
        // hint is measured against the column and not against the screen.
        expect(view.footer).toBe("↑↓/jk ^d^u ⏎ 1-9 p i ^n esc");
        expect(view.footer.length)
            .toBeLessThanOrEqual(workspaceRailColumns(COLUMNS)!);
        expect(workspaceSidebarFooter(MIN_RAIL_COLUMNS).length)
            .toBeLessThanOrEqual(MIN_RAIL_COLUMNS);
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
            undefined,
            true,
        );
        expect(view.lines[view.cursorLine!]?.selected).toBe(true);
    });
});
