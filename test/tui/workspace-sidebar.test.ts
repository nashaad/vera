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
    workspaceJumpTargets,
    workspaceSidebarLayout,
    workspaceSidebarSessions,
    WORKSPACE_FOOTER_TABLE,
    WORKSPACE_QUIET_FOOTER_TABLE,
    workspaceSidebarFooter,
    workspaceSidebarHeader,
    workspaceSidebarText,
    workspaceSidebarViewState,
    workspaceWorkingSet,
    workspaceCycleTarget,
    workspaceHeaderAction,
    MIN_RAIL_COLUMNS,
    WORKSPACE_RECENT_IDLE,
    WORKSPACE_EMPTY_LINES,
    WORKSPACE_HEADER_ALL_ACTION,
    WORKSPACE_HEADER_NEW_ACTION,
    WORKSPACE_JUMPS_ENABLED,
    WORKSPACE_SELECTION_MARKER,
    type WorkspaceSidebarSession,
    type WorkspaceSidebarState,
} from "../../clients/tui/workspace-sidebar.ts";
import {
    IDLE_GROUP,
    PINNED_GROUP,
    RECENT_GROUP,
    WORKING_GROUP,
    WORKSPACE_PINS_ENABLED,
} from "../../clients/tui/workspace-panel.ts";
import { tuiBrailleSpinner } from "../../clients/tui/activity-pulse.ts";
import { tuiBindingId, tuiKeyChord } from "../../clients/tui/keymap.ts";
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
            .toBe("VERA · 12");
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
            .toBe("VERA · 6");
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
        expect(text).not.toContain("test-do-serverless");
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

    test("saved pins do not expand the working set while dormant", () => {
        const sessions = Array.from({ length: 6 }, (_unused, at) =>
            session(`idle-${at}`, {
                updatedAt: `2026-08-22T11:0${at}:00.000Z`,
            }));
        expect(workspaceWorkingSet(sessions, undefined, ["idle-0"]).map(
            (entry) => entry.id,
        )).toEqual([
            "idle-1",
            "idle-2",
            "idle-3",
            "idle-4",
            "idle-5",
        ]);
        expect(workspaceSidebarText(open(sessions, ["idle-0"]), COLUMNS, NOW))
            .not.toContain("session idle-0");
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

    test("puts age at the right and drops it only when squeezed", () => {
        const state = open([session("a", {
            title: "a useful descriptive session name",
            updatedAt: "2026-08-22T11:56:00.000Z",
        })], []);
        const withAge = workspaceSidebarViewState(state, 120, NOW, 37)
            .lines.filter((line) => line.rowId === "a").map((line) => line.text);
        const titleOnly = workspaceSidebarViewState(state, 120, NOW, 15)
            .lines.filter((line) => line.rowId === "a").map((line) => line.text);

        expect(withAge).toHaveLength(1);
        expect(withAge[0]?.startsWith("· a useful descriptive")).toBe(true);
        expect(withAge[0]?.endsWith("4m ago")).toBe(true);
        expect(withAge.join("\n")).not.toContain("[");
        expect(titleOnly.join("\n")).not.toContain("ago");
        expect(titleOnly[0]?.startsWith("· a useful")).toBe(true);
        expect(titleOnly.join("\n")).not.toContain("[");
    });

    test("says which side has the keyboard without moving its title", () => {
        const state = open([session("a")], [], "a");

        // The title is the rail's name, so it neither blinks nor shifts with
        // focus: the frame it is handed changes nothing about it either.
        for (const frame of [0, 3, 6]) {
            const focused = workspaceSidebarViewState(
                state,
                120,
                NOW,
                37,
                true,
                frame,
            );
            expect(focused.title).toBe("VERA · 1");
            expect(focused.titleLeading).toEqual({
                text: "VERA",
                tone: "accent",
            });
            expect(focused.focused).toBe(true);
        }
        const chat = workspaceSidebarViewState(state, 120, NOW, 37, false, 4);
        expect(chat.title).toBe("VERA · 1");
        expect(chat.focused).toBeUndefined();
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
        expect(chat.lines.find((line) => line.rowId === "a")?.text
            .startsWith("· ")).toBe(true);
        expect(chat.cursorLine).toBe(focused.cursorLine);
    });

    test("draws state headings and disambiguates mixed workspaces", () => {
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
        expect(headings.map((line) => line.text)).toEqual([WORKING_GROUP]);
        expect(focused.lines.find((line) => line.text.includes("session a"))
            ?.text.startsWith(tuiBrailleSpinner(0))).toBe(true);
        expect(focused.lines.some((line) => line.text.endsWith("one")))
            .toBe(true);
        expect(focused.lines.some((line) => line.text.endsWith("two")))
            .toBe(true);
        expect(focused.hint).toBe("");
        expect(focused.headerActions).toEqual([
            { id: WORKSPACE_HEADER_ALL_ACTION, text: "≡" },
            { id: WORKSPACE_HEADER_NEW_ACTION, text: "+" },
        ]);
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

    test("the file on screen is listed as recent, not as active", () => {
        const state = open(
            [session("a"), session("b", { live: true })],
            [],
            "a",
        );
        const layout = workspaceSidebarLayout(state, {
            columns: COLUMNS,
            now: NOW,
        });
        const groups = layout.rows
            .filter((row) => row.kind === "group")
            .map((row) => (row as { group: string }).group);
        expect(groups).toEqual([IDLE_GROUP, RECENT_GROUP]);
        const active = layout.rows
            .filter((row) => row.kind === "session" && row.active)
            .map((row) => (row as { id: string }).id);
        // Reading a file is not running one, so no digit addresses the row
        // being read either.
        expect(active).toEqual(["b"]);
        expect(workspaceJumpTargets(layout)).toEqual(["b"]);
    });

    test("ctrl+r opens the resume picker directly", () => {
        expect(press(open([session("a")]), "r", { ctrl: true }).action)
            .toEqual({ kind: "resume_picker" });
    });

    test("a bare r no longer reaches the resume picker", () => {
        // The rail claims every bare key while it holds the focus. What
        // changed is that the letter stopped meaning anything.
        expect(press(open([session("a")]), "r").action).toBeUndefined();
    });

    test("escape hides the rail", () => {
        expect(press(open([session("a")]), "escape").action)
            .toEqual({ kind: "hide" });
    });

    test("tab returns to chat and leaves the rail up", () => {
        // The chord the block advertises. Enter is the other way out of the
        // rail and it opens the highlighted row, which is the wrong chat
        // whenever the highlight is not already the one on screen.
        expect(press(open([session("a")]), "tab").action)
            .toEqual({ kind: "close" });
        // `i` is the same action under the key a vim hand reaches for. It is
        // not in the block.
        expect(press(open([session("a")]), "i").action)
            .toEqual({ kind: "close" });
        expect(workspaceSidebarFooter(MIN_RAIL_COLUMNS)).not.toContain(" i");
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

describe("clicking the branded header", () => {
    test("the list control opens all conversations", () => {
        expect(workspaceHeaderAction(WORKSPACE_HEADER_ALL_ACTION))
            .toEqual({ kind: "resume_picker" });
    });

    test("the plus control starts a new conversation", () => {
        expect(workspaceHeaderAction(WORKSPACE_HEADER_NEW_ACTION))
            .toEqual({ kind: "new_session" });
    });

    test("a session id is not a header action", () => {
        expect(workspaceHeaderAction("session-a")).toBeUndefined();
    });
});

describe("dormant digit jumps", () => {
    test("retains the top-nine target calculation", () => {
        const sessions = Array.from(
            { length: 11 },
            (_unused, at) =>
                session(`s${at}`, {
                    live: true,
                    status: "working",
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

    test("keeps the binding but does not open a row", () => {
        const state = open([
            session("a", {
                live: true,
                status: "working",
                updatedAt: "2026-08-22T11:59:00.000Z",
            }),
            session("b", {
                workerPid: 41,
                updatedAt: "2026-08-22T11:58:00.000Z",
            }),
        ]);
        expect(tuiBindingId("workspace", { name: "2" }))
            .toBe("workspace_jump_2");
        expect(WORKSPACE_JUMPS_ENABLED).toBe(false);
        expect(press(state, "2").action).toBeUndefined();
    });

    test("a digit never addresses a recent row", () => {
        const state = open([session("a"), session("b")]);
        expect(press(state, "1").action).toBeUndefined();
    });
});

describe("pinning", () => {
    test("the pin key is dormant during the state-grouped trial", () => {
        const state = open([session("a"), session("b")], [], "a");
        const pinned = press(state, "p");
        expect(WORKSPACE_PINS_ENABLED).toBe(false);
        expect(pinned.action).toBeUndefined();
        expect(pinned.state?.pinnedIds).toEqual([]);
    });

    test("toggling keeps the order of the pins it did not touch", () => {
        expect(toggleWorkspacePin(["a", "b", "c"], "b")).toEqual(["a", "c"]);
        expect(toggleWorkspacePin(["a"], "b")).toEqual(["a", "b"]);
    });

    test("saved pins do not change state grouping while dormant", () => {
        const layout = workspaceSidebarLayout(
            open([
                session("a", { updatedAt: "2026-08-22T11:59:00.000Z" }),
                session("b", { updatedAt: "2026-08-22T10:00:00.000Z" }),
            ], ["b"]),
            { columns: COLUMNS, now: NOW },
        );
        expect(layout.selectable).toEqual(["a", "b"]);
        expect(layout.rows.some((row) =>
            row.kind === "group" && row.group === PINNED_GROUP
        )).toBe(false);
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
        expect(text).toContain("NEEDS YOU");
        expect(text).toContain(WORKING_GROUP);
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
        expect(text).not.toContain("✓ session b");
    });

    test("an idle session you are looking at still reads as completed", () => {
        const state = open(
            [session("a", {
                title: "count to 5",
                status: "idle",
                live: true,
                updatedAt: "2026-08-22T11:55:00.000Z",
            })],
            [],
            "a",
        );
        const text = workspaceSidebarText(state, COLUMNS, NOW);
        expect(text).toContain("✓ count to 5");
        expect(text).not.toContain("[ count to");
        expect(workspaceSidebarViewState(state, COLUMNS, NOW).lines.find(
            (line) => line.rowId === "a",
        )?.leading).toEqual({ text: "✓", tone: "positive" });
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
        expect(text).not.toContain("✓ do you know");
        expect(text).toContain("· do you know");
    });

    test("a live finished turn older than ten minutes returns to idle", () => {
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
        expect(text).not.toContain("✓ count to 5");
    });

    test("does not draw dormant digit shortcuts", () => {
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
            .split("\n");
        const rows = lines.filter((line) =>
            line.startsWith(tuiBrailleSpinner(0))
        );
        expect(rows).toHaveLength(10);
        expect(rows.every((row) => !/\s{2,}\d$/.test(row))).toBe(true);
    });

    test("carries its own footer hint, in the pickers' shape", () => {
        // Measured against what is drawn: the card at this width is most of
        // the terminal, so it has room for the words.
        const view = workspaceSidebarViewState(
            open([session("a")]),
            70,
            NOW,
            undefined,
            true,
        );
        expect(view.footer).toBe([
            "Move    ↑↓  j/k",
            "Page    ctrl+d/u",
            "Open    enter",
            "New     ctrl+n",
            "Resume  ctrl+r",
            "Cycle   ctrl+shift+[ ]",
            "Chat    tab",
            "Hide    ctrl+e",
        ].join("\n"));
        expect(view.footerTable).toHaveLength(8);
        expect(view.lines.some((line) => line.text.includes("Resume session")))
            .toBe(false);
        expect(view.title).toBe("VERA · 1");
    });

    test("recent history ends without a command-looking row", () => {
        const text = workspaceSidebarText(open([session("a")]), COLUMNS, NOW);
        const lines = text.split("\n");
        expect(lines[lines.length - 1]).toContain("session a");
        expect(text).not.toContain("all sessions");
    });

    test("every row is one flush-left marked line", () => {
        const text = workspaceSidebarText(
            open([
                session("busy", { status: "working", live: true }),
                session("old"),
            ]),
            COLUMNS,
            NOW,
        );
        const lines = text.split("\n");
        const busy = lines.findIndex((line) => line.includes("session busy"));
        expect(lines[busy]?.startsWith(`${tuiBrailleSpinner(0)} `)).toBe(true);
        expect(lines[busy]).not.toMatch(/\s{2,}\d$/);
        const old = lines.findIndex((line) => line.includes("session old"));
        expect(lines[old]?.startsWith("· ")).toBe(true);
        expect(lines[old]?.endsWith("1h ago")).toBe(true);
        expect(lines[old + 1]).toBeUndefined();
    });

    test("selection stays text-readable without a left gutter", () => {
        const text = workspaceSidebarText(
            open([
                session("selected", { title: "selected row" }),
                session("other", { title: "other row" }),
            ], [], "selected"),
            COLUMNS,
            NOW,
        );
        const selected = text.split("\n").find((line) =>
            line.includes("selected row")
        );
        const other = text.split("\n").find((line) => line.includes("other row"));
        expect(selected).toContain(`· selected row ${WORKSPACE_SELECTION_MARKER}`);
        expect(other).toContain("· other row");
        expect(other).not.toContain(WORKSPACE_SELECTION_MARKER);
    });

    test("a session with no title reads untitled, never its id", () => {
        const text = workspaceSidebarText(
            open([{ ...session("bare"), title: undefined } as never]),
            COLUMNS,
            NOW,
        );
        expect(text).toContain("untitled");
        expect(text).not.toContain("bare");
    });

    test("the rail takes the short hint, wide as the terminal is", () => {
        const view = workspaceSidebarViewState(
            open([session("a")]),
            COLUMNS,
            NOW,
            undefined,
            true,
        );
        // A rail is as narrow as its rows whatever the terminal is, so the
        // hint is measured against the column and not against the screen.
        expect(view.footer).toBe([
            "Move    ↑↓  j/k",
            "Page    ctrl+d/u",
            "Open    enter",
            "New     ctrl+n",
            "Resume  ctrl+r",
            "Cycle   ctrl+shift+[ ]",
            "Chat    tab",
            "Hide    ctrl+e",
        ].join("\n"));
        for (const line of view.footer.split("\n")) {
            expect(line.length)
                .toBeLessThanOrEqual(workspaceRailColumns(COLUMNS)!);
        }
        for (const line of workspaceSidebarFooter(MIN_RAIL_COLUMNS).split("\n")) {
            expect(line.length).toBeLessThanOrEqual(MIN_RAIL_COLUMNS);
        }
        expect(workspaceSidebarFooter(MIN_RAIL_COLUMNS).split("\n"))
            .toHaveLength(8);
    });

    test("an unfocused rail keeps only the chords that answer from the chat", () => {
        const idle = workspaceSidebarViewState(
            open([session("a")]),
            COLUMNS,
            NOW,
        );
        // Both of these work with the cursor in the composer: the cycle is
        // global, and ctrl+e is what hands the rail the keys.
        expect(idle.footerTable).toEqual([
            { label: "Cycle", value: "ctrl+shift+[ ]" },
            { label: "Focus", value: "tab" },
            { label: "Hide", value: "ctrl+e" },
        ]);
        expect(idle.footer).toContain("ctrl+shift+[ ]");
        // The rail's own chords are not offered to a keyboard that is elsewhere.
        expect(idle.footer).not.toContain("Move");
        expect(idle.footer).not.toContain("Pin");
        const focused = workspaceSidebarViewState(
            open([session("a")]),
            COLUMNS,
            NOW,
            undefined,
            true,
        );
        expect(focused.footer).toContain("Move");
        // Tab is one chord in both directions, so it says which one it is.
        expect(focused.footer).toContain("Chat    tab");
        expect(focused.footer).not.toContain("Focus");
    });

    test("every quiet chord is repeated by the focused block", () => {
        // The block grows on focus, it does not swap: a chord that was on
        // screen a keystroke ago must still be there.
        for (const row of WORKSPACE_QUIET_FOOTER_TABLE) {
            const wide = WORKSPACE_FOOTER_TABLE
                .find((other) => other.value === row.value);
            expect(wide).toBeDefined();
        }
        for (const row of WORKSPACE_QUIET_FOOTER_TABLE) {
            expect(`${row.label.padEnd(8)}${row.value}`.length)
                .toBeLessThanOrEqual(MIN_RAIL_COLUMNS);
        }
    });

    test("the session cycle is named where the other chords are", () => {
        const cycle = WORKSPACE_FOOTER_TABLE
            .find((row) => row.label === "Cycle");
        // Both halves of the chord, spelled the way the keymap spells them,
        // so the row cannot drift from the keys it names.
        expect(cycle?.value).toContain(tuiKeyChord("cycle_live_session_prev"));
        expect(cycle?.value)
            .toContain(tuiKeyChord("cycle_live_session_next").slice(-1));
        expect(cycle?.value).not.toContain("/");
        for (const row of WORKSPACE_FOOTER_TABLE) {
            expect(`${row.label.padEnd(8)}${row.value}`.length)
                .toBeLessThanOrEqual(MIN_RAIL_COLUMNS);
        }
    });

    test("an empty listing says so rather than drawing nothing", () => {
        const text = workspaceSidebarText(open([]), COLUMNS, NOW);
        expect(text.split("\n")).toEqual([...WORKSPACE_EMPTY_LINES]);
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
