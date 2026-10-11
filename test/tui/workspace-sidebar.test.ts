import { describe, expect, test } from "bun:test";
import {
    applyWorkspaceWorkIndex,
    clampWorkspaceRailColumns,
    MIN_RAIL_COLUMNS,
    openWorkspaceSelection,
    refreshWorkspaceSidebarSessions,
    startWorkspaceSidebar,
    workspaceRailColumns,
    workIndexStatus,
    workspaceSidebarLayout,
    workspaceSidebarSessions,
    workspaceSidebarHeader,
    workspaceSidebarText,
    workspaceSidebarViewState,
    workspaceWorkingSet,
    workspaceCycleTarget,
    WORKSPACE_EMPTY_LINES,
    type WorkspaceSidebarSession,
    type WorkspaceSidebarState,
} from "../../clients/tui/workspace-sidebar.ts";
import {
    IDLE_GROUP,
    WORKING_GROUP,
    WORKSPACE_COMPLETED_WINDOW_MS,
} from "../../clients/tui/workspace-panel.ts";
import { tuiBrailleSpinner } from "../../clients/tui/activity-pulse.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import type {
    WorkIndexSnapshot,
    WorkRow,
} from "../../src/host/work-index.ts";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const COLUMNS = 120;
const RECENT_IDLE = "2026-08-22T11:55:00.000Z";
const ELEVEN_MINUTES_AGO = new Date(
    NOW.getTime() - WORKSPACE_COMPLETED_WINDOW_MS - 60_000,
).toISOString();

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
// A session the host still runs. The rail lists nothing else.
function running(
    id: string,
    overrides: Partial<WorkspaceSidebarSession> = {},
): WorkspaceSidebarSession {
    return session(id, { live: true, ...overrides });
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

    test("labels an imported session with its source tool", () => {
        const agents: readonly RegisteredAgentSummary[] = [{
            id: "imp",
            workspace: "/w/one",
            session_path: "/sessions/imp.jsonl",
            kind: "interactive",
            status: "idle",
            live: false,
            title: "old work",
            imported_from: {
                tool: "claude-code",
                source_session_id: "src",
                source_started_at: "2026-09-01T10:00:00.000Z",
                message_count: 4,
                last_message_id: "m4",
            },
        }];
        expect(workspaceSidebarSessions(agents)[0]?.importLabel)
            .toBe("[imported · Claude Code]");
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
        expect(openWorkspaceSelection(open(sessions), sessions[0]?.id)).toEqual({
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

    test("labels an imported session with its source tool", () => {
        const agents: readonly RegisteredAgentSummary[] = [{
            id: "imp",
            workspace: "/w/one",
            session_path: "/sessions/imp.jsonl",
            kind: "interactive",
            status: "idle",
            live: false,
            title: "old work",
            imported_from: {
                tool: "claude-code",
                source_session_id: "src",
                source_started_at: "2026-09-01T10:00:00.000Z",
                message_count: 4,
                last_message_id: "m4",
            },
        }];
        expect(workspaceSidebarSessions(agents)[0]?.importLabel)
            .toBe("[imported · Claude Code]");
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
        expect(openWorkspaceSelection(open(sessions), sessions[0]?.id)).toEqual({
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

    test("lists running sessions only, never parked history", () => {
        const sessions = [
            session("parked", { updatedAt: RECENT_IDLE }),
            running("idle-live"),
            session("waiting", { status: "waiting" }),
            session("worker", { workerPid: 4242 }),
        ];
        expect(workspaceWorkingSet(sessions).map((entry) => entry.id))
            .toEqual(["idle-live", "waiting", "worker"]);
        const text = workspaceSidebarText(open(sessions), COLUMNS, NOW);
        expect(text).not.toContain("session parked");
        expect(workspaceSidebarHeader(open(sessions))).toBe("VERA · 3");
    });

    test("the parked file on screen is not listed either", () => {
        const text = workspaceSidebarText(
            open([session("here"), running("other")], [], "here"),
            COLUMNS,
            NOW,
        );
        expect(text).not.toContain("session here");
        expect(text).toContain("session other");
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
                    updatedAt: RECENT_IDLE,
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

    test("idle conversations left running stay in the cycle", () => {
        const state = open(
            [
                session("fresh", {
                    live: true,
                    status: "idle",
                    updatedAt: RECENT_IDLE,
                }),
                session("previous", {
                    live: true,
                    status: "idle",
                    updatedAt: RECENT_IDLE,
                }),
            ],
            [],
            "fresh",
        );
        expect(workspaceCycleTarget(state, 1, NOW, COLUMNS)?.id).toBe("previous");
        const layout = workspaceSidebarLayout(state, {
            columns: COLUMNS,
            now: NOW,
        });
        expect(layout.rows
            .filter((row) => row.kind === "group")
            .map((row) => (row as { group: string }).group)).toEqual([IDLE_GROUP]);
        expect(openWorkspaceSelection(state, "previous")).toEqual({
            kind: "open_session",
            session_id: "previous",
            session_path: "/sessions/previous.jsonl",
            active: true,
        });
    });

    test("a leftover stays in the cycle until the host parks it", () => {
        const state = open(
            [
                session("fresh", {
                    live: true,
                    status: "idle",
                    updatedAt: RECENT_IDLE,
                }),
                session("stale", {
                    live: true,
                    status: "idle",
                    updatedAt: ELEVEN_MINUTES_AGO,
                }),
            ],
            [],
            "fresh",
        );
        expect(workspaceCycleTarget(state, 1, NOW, COLUMNS)?.id).toBe("stale");
        const layout = workspaceSidebarLayout(state, {
            columns: COLUMNS,
            now: NOW,
        });
        expect(layout.rows
            .filter((row) => row.kind === "group")
            .map((row) => (row as { group: string }).group))
            .toEqual([IDLE_GROUP]);
        expect(openWorkspaceSelection(state, "stale")).toEqual({
            kind: "open_session",
            session_id: "stale",
            session_path: "/sessions/stale.jsonl",
            active: true,
        });
    });

    test("the conversation on screen stays idle after ten minutes", () => {
        const state = open(
            [
                session("on-screen", {
                    live: true,
                    status: "idle",
                    updatedAt: ELEVEN_MINUTES_AGO,
                }),
                session("previous", {
                    live: true,
                    status: "idle",
                    updatedAt: RECENT_IDLE,
                }),
            ],
            [],
            "on-screen",
        );
        expect(workspaceCycleTarget(state, 1, NOW, COLUMNS)?.id).toBe("previous");
        const layout = workspaceSidebarLayout(state, {
            columns: COLUMNS,
            now: NOW,
        });
        const idle = layout.rows
            .filter((row) => row.kind === "session" && row.group === IDLE_GROUP)
            .map((row) => (row as { id: string }).id);
        expect(idle).toEqual(["previous", "on-screen"]);
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
    test("lists a session that started while the rail was up", () => {
        const state = open([running("a")], [], "a");
        const refreshed = refreshWorkspaceSidebarSessions(
            state,
            [running("a"), running("b")],
        );
        expect(workspaceSidebarText(refreshed, COLUMNS, NOW))
            .toContain("session b");
    });

    test("drops a session the host parked", () => {
        const state = open([running("a"), running("b")], [], "a");
        const refreshed = refreshWorkspaceSidebarSessions(
            state,
            [running("a"), session("b")],
        );
        expect(workspaceSidebarText(refreshed, COLUMNS, NOW))
            .not.toContain("session b");
        expect(refreshed.currentId).toBe("a");
    });
});

describe("the rail", () => {
    test("is as wide as the longest row it can draw", () => {
        for (const columns of [120, 90]) {
            const rail = workspaceRailColumns(columns)!;
            const drawn = workspaceSidebarText(
                open([running("a"), running("b")], [], "a"),
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

    test("the title is the wordmark and a count, steady across frames", () => {
        const state = open([running("a")], [], "a");
        for (const frame of [0, 3, 6]) {
            const view = workspaceSidebarViewState(state, 120, NOW, 37, frame);
            expect(view.title).toBe("VERA · 1");
            expect(view.titleLeading).toEqual({ text: "VERA", tone: "accent" });
            expect(view.hint).toBe("");
        }
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
        const view = workspaceSidebarViewState(state, 120, NOW, 37);
        const headings = view.lines.filter((line) => line.tone === "heading");
        expect(headings.map((line) => line.text)).toEqual([WORKING_GROUP]);
        expect(view.lines.find((line) => line.text.includes("session a"))
            ?.text.startsWith(tuiBrailleSpinner(0))).toBe(true);
        expect(view.lines.some((line) => line.text.endsWith("one")))
            .toBe(true);
        expect(view.lines.some((line) => line.text.endsWith("two")))
            .toBe(true);
        expect(view.headerActions).toBeUndefined();
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
                running("a", { title: "needs you" }),
                running("b", { title: "running" }),
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
    test("only displays: no row ids, no cursor, no selection", () => {
        const view = workspaceSidebarViewState(
            open([running("a"), running("b", { status: "working" })], [], "a"),
            COLUMNS,
            NOW,
        );
        expect(view.lines.every((line) => line.rowId === undefined)).toBe(true);
        expect(view.lines.every((line) => line.selected === undefined)).toBe(true);
        expect(view.cursorLine).toBeUndefined();
        expect(view.focused).toBeUndefined();
        expect(view.dimmed).toBeUndefined();
    });

    test("the session on screen is marked current, the others are not", () => {
        const view = workspaceSidebarViewState(
            open([running("a"), running("b")], [], "b"),
            COLUMNS,
            NOW,
        );
        const shown = view.lines.find((line) => line.text.includes("session b"));
        const other = view.lines.find((line) => line.text.includes("session a"));
        expect(shown?.current).toBe(true);
        expect(shown?.tone).toBe("text");
        expect(other?.current).toBeUndefined();
        expect(other?.tone).toBe("text");
        const text = workspaceSidebarText(open([running("b")], [], "b"), COLUMNS, NOW);
        expect(text).not.toContain("[ session b ]");
        expect(text).not.toContain("(here)");
    });

    test("an idle session you are looking at still reads as completed", () => {
        const state = open(
            [running("a", {
                title: "count to 5",
                status: "idle",
                updatedAt: "2026-08-22T11:55:00.000Z",
            })],
            [],
            "a",
        );
        const text = workspaceSidebarText(state, COLUMNS, NOW);
        expect(text).toContain("✓ count to 5");
        expect(workspaceSidebarViewState(state, COLUMNS, NOW).lines.find(
            (line) => line.text.includes("count to 5"),
        )?.leading).toEqual({ text: "✓", tone: "positive" });
    });

    test("a new session with no messages reads idle, not finished", () => {
        const state = open([running("a", {
            title: "fresh",
            status: "idle",
            updatedAt: RECENT_IDLE,
            hasUserContent: false,
        })]);
        const text = workspaceSidebarText(state, COLUMNS, NOW);
        expect(text).toContain(". fresh");
        expect(text).not.toContain("✓");
    });

    test("the listing carries whether a session has messages", () => {
        const agents: readonly RegisteredAgentSummary[] = [{
            id: "a",
            workspace: "/w/one",
            session_path: "/sessions/a.jsonl",
            kind: "interactive",
            status: "idle",
            live: true,
            has_user_content: false,
        }];
        expect(workspaceSidebarSessions(agents)[0]?.hasUserContent).toBe(false);
    });

    test("a live finished turn older than ten minutes returns to idle", () => {
        const state = open(
            [running("a", {
                title: "count to 5",
                status: "idle",
                updatedAt: ELEVEN_MINUTES_AGO,
            })],
            [],
            "a",
        );
        const layout = workspaceSidebarLayout(state, { columns: COLUMNS, now: NOW });
        expect(layout.rows.filter((row) => row.kind === "session")
            .map((row) => (row as { group: string }).group)).toEqual([IDLE_GROUP]);
        expect(workspaceSidebarText(state, COLUMNS, NOW))
            .not.toContain("✓ count to 5");
    });

    test("a session with no title reads untitled, never its id", () => {
        const text = workspaceSidebarText(
            open([{ ...running("bare"), title: undefined } as never]),
            COLUMNS,
            NOW,
        );
        expect(text).toContain("untitled");
        expect(text).not.toContain("bare");
    });

    test("the footer names the keys for the previous and next session, switch, and hide", () => {
        const view = workspaceSidebarViewState(open([running("a")]), COLUMNS, NOW);
        expect(view.footerTable).toEqual([
            { label: "Prev session", value: "Ctrl+Shift+←" },
            { label: "Next session", value: "Ctrl+Shift+→" },
            { label: "Switch", value: "Ctrl+E" },
            { label: "Hide", value: "Ctrl+X b" },
        ]);
        expect(view.footer).toBe([
            "Prev session  Ctrl+Shift+←",
            "Next session  Ctrl+Shift+→",
            "Switch        Ctrl+E",
            "Hide          Ctrl+X b",
        ].join("\n"));
    });

    test("the hints fit the narrowest rail", () => {
        const view = workspaceSidebarViewState(open([running("a")]), COLUMNS, NOW);
        // One column for the divider and one for the left padding.
        for (const line of view.footer.split("\n")) {
            expect(line.length).toBeLessThanOrEqual(MIN_RAIL_COLUMNS - 2);
        }
    });

    test("a usage summary sits above the hints", () => {
        const summary = [{ label: "Spend", value: "$1.20" }];
        const view = workspaceSidebarViewState(
            open([running("a")]),
            COLUMNS,
            NOW,
            undefined,
            0,
            summary,
        );
        expect(view.footerTable?.map((row) => row.label))
            .toEqual(["Spend", "", "Prev session", "Next session", "Switch", "Hide"]);
        expect(view.footer.split("\n")[0]).toBe("Spend         $1.20");
    });

    test("an empty listing says so rather than drawing nothing", () => {
        const text = workspaceSidebarText(open([session("parked")]), COLUMNS, NOW);
        expect(text.split("\n")).toEqual([...WORKSPACE_EMPTY_LINES]);
    });
});
