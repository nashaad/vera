import { describe, expect, test } from "bun:test";
import {
    isSwitchableSession,
    layoutWorkspacePanel,
    moveWorkspaceSelection,
    WORKSPACE_COMPLETED_MARKER,
    WORKSPACE_COMPLETED_WINDOW_MS,
    WORKSPACE_QUIET_MARKER,
    WORKSPACE_SELECTED_MARKER,
    WORKSPACE_WAITING_MARKER,
    type WorkspacePanelLayout,
    type WorkspaceSession,
    type WorkspaceSessionStatus,
    workspacePanelWidth,
    workspaceStatusMarker,
} from "../../clients/tui/workspace-panel.ts";
import { tuiBrailleSpinner } from "../../clients/tui/activity-pulse.ts";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const RECENT = "2026-08-22T11:55:00.000Z";
const TEN_MINUTES_AGO = new Date(
    NOW.getTime() - WORKSPACE_COMPLETED_WINDOW_MS,
).toISOString();
const ELEVEN_MINUTES_AGO = "2026-08-22T11:49:00.000Z";

function session(
    overrides: Partial<WorkspaceSession> & { id: string },
): WorkspaceSession {
    return {
        workspace: "/Users/nash/Projects/vera",
        kind: "interactive",
        status: "idle",
        live: false,
        updatedAt: "2026-08-22T11:00:00.000Z",
        ...overrides,
    };
}

function layout(
    sessions: readonly WorkspaceSession[],
    columns = 120,
    selectedId?: string,
): WorkspacePanelLayout {
    return layoutWorkspacePanel({
        sessions,
        columns,
        now: NOW,
        ...(selectedId === undefined ? {} : { selectedId }),
    });
}

function sessionRows(result: WorkspacePanelLayout) {
    return result.rows.filter((row) => row.kind === "session");
}

describe("width breakpoints", () => {
    test("matches the dashboard's breakpoints", () => {
        expect(workspacePanelWidth(120)).toBe("wide");
        expect(workspacePanelWidth(110)).toBe("wide");
        expect(workspacePanelWidth(109)).toBe("medium");
        expect(workspacePanelWidth(74)).toBe("medium");
        expect(workspacePanelWidth(73)).toBe("narrow");
        expect(workspacePanelWidth(40)).toBe("narrow");
    });
});

describe("grouping", () => {
    test("orders workspaces touched at the same time by name", () => {
        const result = layout([
            session({ id: "z", workspace: "/w/zeta" }),
            session({ id: "a", workspace: "/w/alpha" }),
        ]);
        const headings = result.rows
            .filter((row) => row.kind === "group")
            .map((row) => row.text.trim());
        expect(headings.map((text) => text.split(" ")[0])).toEqual([
            "alpha",
            "zeta",
        ]);
    });

    test("groups interactive sessions by workspace", () => {
        const result = layout([
            session({ id: "a", workspace: "/w/one", title: "one a" }),
            session({ id: "b", workspace: "/w/two", title: "two b" }),
            session({ id: "c", workspace: "/w/one", title: "one c" }),
        ]);
        const groups = result.rows.filter((row) => row.kind === "group");
        expect(groups.map((row) => row.group)).toEqual(["/w/one", "/w/two"]);
        expect(groups.map((row) => row.sessions)).toEqual([2, 1]);
    });

    test("a git worktree groups with its parent checkout", () => {
        const result = layout([
            session({
                id: "main",
                workspace: "/Users/nash/Projects/vera",
                title: "on main",
            }),
            session({
                id: "aside",
                workspace: "/Users/nash/Projects/vera/.worktrees/aside",
                title: "count to 10",
            }),
        ]);
        const groups = result.rows.filter((row) => row.kind === "group");
        expect(groups).toHaveLength(1);
        expect(groups[0]?.group).toBe("/Users/nash/Projects/vera");
        expect(groups[0]?.text).toBe("vera");
        expect(result.rows.filter((row) => row.kind === "session")).toHaveLength(
            2,
        );
    });

    test("background agents sit in their workspace group", () => {
        const result = layout([
            session({ id: "bg", kind: "background", workspace: "/w/one" }),
            session({ id: "a", workspace: "/w/one" }),
            session({ id: "b", workspace: "/w/two" }),
        ]);
        const groups = result.rows.filter((row) => row.kind === "group");
        expect(groups.map((row) => row.group)).toEqual(["/w/one", "/w/two"]);
        expect(groups[0]?.sessions).toBe(2);
        expect(result.selectable).toEqual(["a", "bg", "b"]);
    });

    test("orders groups by their most recent session", () => {
        const result = layout([
            session({
                id: "old",
                workspace: "/w/old",
                updatedAt: "2026-08-20T00:00:00.000Z",
            }),
            session({
                id: "new",
                workspace: "/w/new",
                updatedAt: "2026-08-22T11:59:00.000Z",
            }),
        ]);
        expect(result.selectable).toEqual(["new", "old"]);
    });

    test("orders sessions inside a group by recency", () => {
        const result = layout([
            session({ id: "older", updatedAt: "2026-08-21T00:00:00.000Z" }),
            session({ id: "newer", updatedAt: "2026-08-22T11:00:00.000Z" }),
        ]);
        expect(result.selectable).toEqual(["newer", "older"]);
    });

    test("an empty listing has no rows and nothing selected", () => {
        const result = layout([]);
        expect(result.rows).toEqual([]);
        expect(result.selectable).toEqual([]);
        expect(result.selectedId).toBeUndefined();
    });
});

describe("status markers", () => {
    const expected: Record<WorkspaceSessionStatus, string> = {
        waiting: WORKSPACE_WAITING_MARKER,
        working: tuiBrailleSpinner(0),
        completed: WORKSPACE_QUIET_MARKER,
        failed: WORKSPACE_QUIET_MARKER,
        closed: WORKSPACE_QUIET_MARKER,
        idle: WORKSPACE_QUIET_MARKER,
    };

    for (const [status, marker] of Object.entries(expected)) {
        test(`${status} reads as ${JSON.stringify(marker)}`, () => {
            expect(workspaceStatusMarker(status as WorkspaceSessionStatus))
                .toBe(marker);
            const result = layout([
                session({ id: "a", status: status as WorkspaceSessionStatus }),
            ]);
            expect(sessionRows(result)[0]?.marker).toBe(marker);
        });
    }

    test("a live idle session still reads as completed", () => {
        expect(workspaceStatusMarker("idle", 0, true, RECENT, NOW))
            .toBe(WORKSPACE_COMPLETED_MARKER);
        const result = layout([
            session({
                id: "a",
                status: "idle",
                live: true,
                title: "count to 5",
                updatedAt: RECENT,
            }),
        ]);
        expect(sessionRows(result)[0]?.marker).toBe(WORKSPACE_COMPLETED_MARKER);
    });

    test("a live finished turn keeps the mark at ten minutes", () => {
        expect(workspaceStatusMarker("idle", 0, true, TEN_MINUTES_AGO, NOW))
            .toBe(WORKSPACE_COMPLETED_MARKER);
    });

    test("a live finished turn older than ten minutes is blank", () => {
        expect(workspaceStatusMarker("idle", 0, true, ELEVEN_MINUTES_AGO, NOW))
            .toBe(WORKSPACE_QUIET_MARKER);
        const result = layout([
            session({
                id: "a",
                status: "idle",
                live: true,
                title: "count to 5",
                updatedAt: ELEVEN_MINUTES_AGO,
            }),
        ]);
        expect(sessionRows(result)[0]?.marker).toBe(WORKSPACE_QUIET_MARKER);
        expect(sessionRows(result)[0]?.text).not.toContain("●");
    });

    test("a completed file view is not a completed mark", () => {
        const result = layout([
            session({
                id: "a",
                status: "completed",
                live: false,
                title: "auth-refactor",
                updatedAt: RECENT,
            }),
        ]);
        expect(sessionRows(result)[0]?.marker).toBe(WORKSPACE_QUIET_MARKER);
        expect(sessionRows(result)[0]?.text).not.toContain("●");
    });

    test("an idle file view is not a completed mark", () => {
        expect(workspaceStatusMarker("idle", 0, false))
            .toBe(WORKSPACE_QUIET_MARKER);
        const result = layout([
            session({ id: "a", status: "idle", live: false, title: "old chat" }),
        ]);
        expect(sessionRows(result)[0]?.marker).toBe(WORKSPACE_QUIET_MARKER);
        expect(sessionRows(result)[0]?.text).not.toContain("●");
    });

    test("working advances through the braille spinner", () => {
        expect(workspaceStatusMarker("working", 0)).toBe(tuiBrailleSpinner(0));
        expect(workspaceStatusMarker("working", 1)).toBe(tuiBrailleSpinner(1));
        expect(workspaceStatusMarker("working", 1))
            .not.toBe(workspaceStatusMarker("working", 0));
        const spinning = layoutWorkspacePanel({
            sessions: [session({ id: "a", status: "working", title: "run" })],
            columns: 120,
            now: NOW,
            animationFrame: 1,
        });
        expect(sessionRows(spinning)[0]?.marker).toBe(tuiBrailleSpinner(1));
    });
});

describe("row text", () => {
    test("wide shows marker, title, and relative age", () => {
        const result = layout([
            session({
                id: "a",
                title: "fix the composer",
                updatedAt: "2026-08-22T10:00:00.000Z",
            }),
        ]);
        const row = sessionRows(result)[0]!;
        expect(row.age).toBe("2h ago");
        expect(row.text).toContain("fix the composer");
        expect(row.text.trimEnd().endsWith("2h ago")).toBe(true);
    });

    test("the session on screen is not wrapped in brackets", () => {
        const result = layoutWorkspacePanel({
            sessions: [session({
                id: "a",
                title: "fix the composer",
                updatedAt: "2026-08-22T10:00:00.000Z",
            })],
            columns: 120,
            now: NOW,
            currentId: "a",
        });
        const row = sessionRows(result)[0]!;
        expect(row.text).toContain("fix the composer");
        expect(row.text).not.toContain("[");
        expect(row.text).not.toContain("]");
        expect(row.text).toContain(WORKSPACE_SELECTED_MARKER);
    });

    test("medium drops the age and truncates the title", () => {
        const result = layout([
            session({
                id: "a",
                title: "a title that runs well past the medium column budget",
            }),
        ], 80);
        const row = sessionRows(result)[0]!;
        expect(result.width).toBe("medium");
        expect(row.age).toBe("");
        expect(row.title.endsWith("…")).toBe(true);
        expect(row.title.length).toBe(24);
        expect(row.text).not.toContain("ago");
    });

    test("wide truncates a title longer than its own budget", () => {
        const long = "x".repeat(200);
        const result = layout([session({ id: "a", title: long })]);
        const row = sessionRows(result)[0]!;
        expect(row.title.endsWith("…")).toBe(true);
        expect(row.title.length).toBe(25);
    });

    test("narrow keeps the age and gives the title more room", () => {
        const long = "y".repeat(200);
        const result = layout([session({ id: "a", title: long })], 60);
        const row = sessionRows(result)[0]!;
        expect(result.width).toBe("narrow");
        expect(row.age).toBe("1h ago");
        expect(row.title.length).toBe(37);
    });

    test("falls back to the id when a session has no title", () => {
        const result = layout([session({ id: "abc123" })]);
        expect(sessionRows(result)[0]?.title).toBe("abc123");
    });

    test("a session with no usable timestamp shows no age", () => {
        const result = layout([
            session({ id: "a", title: "t", updatedAt: undefined }),
        ]);
        expect(sessionRows(result)[0]?.age).toBe("");
    });

    test("group headers name the workspace without a count", () => {
        const result = layout([
            session({ id: "a", workspace: "/Users/nash/Projects/vera" }),
            session({ id: "b", workspace: "/Users/nash/Projects/vera" }),
        ]);
        const header = result.rows.find((row) => row.kind === "group")!;
        expect(header.text).toBe("vera");
        expect(header.sessions).toBe(2);
    });
});

describe("selection", () => {
    const three = [
        session({
            id: "a",
            workspace: "/w/one",
            updatedAt: "2026-08-22T11:03:00.000Z",
        }),
        session({
            id: "b",
            workspace: "/w/one",
            updatedAt: "2026-08-22T11:02:00.000Z",
        }),
        session({
            id: "c",
            workspace: "/w/two",
            updatedAt: "2026-08-22T11:01:00.000Z",
        }),
    ];

    test("selects the first session when none is named", () => {
        expect(layout(three).selectedId).toBe("a");
    });

    test("group headers are never selectable", () => {
        const result = layout(three);
        expect(result.selectable).toEqual(["a", "b", "c"]);
        const headers = result.rows.filter((row) => row.kind === "group");
        expect(headers.length).toBe(2);
    });

    test("moves across a group boundary without landing on the header", () => {
        const result = layout(three, 120, "b");
        expect(moveWorkspaceSelection(result, 1)).toBe("c");
    });

    test("moves back across a group boundary", () => {
        const result = layout(three, 120, "c");
        expect(moveWorkspaceSelection(result, -1)).toBe("b");
    });

    test("stops at the ends rather than wrapping", () => {
        const last = layout(three, 120, "c");
        const first = layout(three, 120, "a");
        expect(moveWorkspaceSelection(last, 1)).toBe("c");
        expect(moveWorkspaceSelection(first, -1)).toBe("a");
        expect(moveWorkspaceSelection(first, 99)).toBe("c");
    });

    test("nothing to select moves nowhere", () => {
        expect(moveWorkspaceSelection(layout([]), 1)).toBeUndefined();
    });

    test("keeps the selected session when a refresh reorders the rows", () => {
        const before = layout(three, 120, "c");
        expect(before.selectable).toEqual(["a", "b", "c"]);
        const reordered = layout([
            session({
                id: "c",
                workspace: "/w/two",
                updatedAt: "2026-08-22T11:59:00.000Z",
            }),
            session({
                id: "a",
                workspace: "/w/one",
                updatedAt: "2026-08-22T11:03:00.000Z",
            }),
            session({
                id: "b",
                workspace: "/w/one",
                updatedAt: "2026-08-22T11:02:00.000Z",
            }),
        ], 120, before.selectedId);
        expect(reordered.selectable).toEqual(["c", "a", "b"]);
        expect(reordered.selectedId).toBe("c");
        const marked = sessionRows(reordered).find((row) => row.selected);
        expect(marked?.id).toBe("c");
    });

    test("falls back to the first session when the selection is gone", () => {
        const result = layout(three, 120, "missing");
        expect(result.selectedId).toBe("a");
    });

    test("lands on the nearest survivor when the selection is gone", () => {
        const result = layoutWorkspacePanel({
            sessions: three.filter((entry) => entry.id !== "b"),
            columns: 120,
            now: NOW,
            selectedId: "b",
            previousSelectable: ["a", "b", "c"],
        });
        expect(result.selectedId).toBe("c");
    });

    test("walks outward when the neighbour below went too", () => {
        const result = layoutWorkspacePanel({
            sessions: three.filter((entry) => entry.id === "a"),
            columns: 120,
            now: NOW,
            selectedId: "b",
            previousSelectable: ["a", "b", "c"],
        });
        expect(result.selectedId).toBe("a");
    });

    test("an empty listing hands the selection back untouched", () => {
        const result = layoutWorkspacePanel({
            sessions: [],
            columns: 120,
            now: NOW,
            selectedId: "b",
            previousSelectable: ["a", "b", "c"],
        });
        expect(result.selectable).toEqual([]);
        expect(result.selectedId).toBe("b");
    });

    test("marks exactly one row selected", () => {
        const rows = sessionRows(layout(three, 120, "b"));
        expect(rows.filter((row) => row.selected).map((row) => row.id))
            .toEqual(["b"]);
    });
});

describe("switchable sessions", () => {
    test("an ephemeral sidekick is not a row", () => {
        expect(isSwitchableSession(session({ id: "btw", ephemeral: true })))
            .toBe(false);
        const result = layout([
            session({ id: "primary" }),
            session({ id: "btw", ephemeral: true }),
        ]);
        expect(result.selectable).toEqual(["primary"]);
    });

    test("a durable peer is an ordinary row", () => {
        expect(isSwitchableSession(session({ id: "pair" }))).toBe(true);
        expect(isSwitchableSession(session({ id: "pair", ephemeral: false })))
            .toBe(true);
    });
});

describe("monochrome render", () => {
    test("waiting, working, and completed stay distinct without colour", () => {
        const statuses: readonly WorkspaceSessionStatus[] = [
            "waiting",
            "working",
            "idle",
            "completed",
            "failed",
            "closed",
        ];
        const result = layout(
            statuses.map((status, index) =>
                session({
                    id: `s${index}`,
                    title: status,
                    status,
                    live: status === "completed",
                    updatedAt: status === "completed"
                        ? RECENT
                        : `2026-08-22T11:${
                            `${59 - index}`.padStart(2, "0")
                        }:00.000Z`,
                })
            ),
            120,
            "s2",
        );
        const byStatus = new Map(
            sessionRows(result).map((row) => [row.status, row.marker]),
        );
        expect(byStatus.get("waiting")).toBe(WORKSPACE_WAITING_MARKER);
        expect(byStatus.get("working")).toBe(tuiBrailleSpinner(0));
        expect(byStatus.get("completed")).toBe(WORKSPACE_COMPLETED_MARKER);
        expect(byStatus.get("idle")).toBe(WORKSPACE_QUIET_MARKER);
        expect(byStatus.get("failed")).toBe(WORKSPACE_QUIET_MARKER);
        expect(byStatus.get("closed")).toBe(WORKSPACE_QUIET_MARKER);
        const marked = ["waiting", "working", "completed"].map(
            (status) => byStatus.get(status as WorkspaceSessionStatus),
        );
        expect(new Set(marked).size).toBe(3);
        // The selection marker is column one and the status marker column
        // three, so neither stands in for the other.
        const selected = sessionRows(result).filter((row) => row.selected);
        expect(selected).toHaveLength(1);
        for (const row of result.rows) {
            if (row.kind !== "session") continue;
            expect(row.text.startsWith(
                row.selected ? `${WORKSPACE_SELECTED_MARKER} ` : "  ",
            )).toBe(true);
            expect(row.text.slice(2, 3)).toBe(row.marker);
        }
    });
});
