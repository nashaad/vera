import { expect, test } from "bun:test";

import {
    buildWorkIndex,
    sameWorkIndex,
    type WorkAgentFacts,
    type WorkScheduleFacts,
} from "../../src/host/work-index.ts";

const NOW = Date.parse("2026-08-14T12:00:00.000Z");
const now = () => NOW;

function agent(overrides: Partial<WorkAgentFacts> = {}): WorkAgentFacts {
    return {
        id: "agent",
        session_path: "/sessions/agent.jsonl",
        title: "agent",
        workspace: "/w",
        kind: "interactive",
        status: "idle",
        live: true,
        updated_at: "2026-08-14T11:59:00.000Z",
        ...overrides,
    };
}

function approvalRequest(command: string) {
    return {
        type: "tool_approval" as const,
        toolCall: { id: "call", name: "bash", input: { command } },
        reason: "",
        warning: "",
    };
}

function question(text: string) {
    return { type: "user_question" as const, question: text, choices: [] };
}

test("an open approval puts the session in needs_you with its command", () => {
    const index = buildWorkIndex([
        agent({
            id: "auth-race",
            title: "auth-race",
            status: "waiting",
            pending_request: approvalRequest("bun migrate --production"),
        }),
    ], [], { now });

    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]?.section).toBe("needs_you");
    expect(index.rows[0]?.reason).toBe("approval");
    expect(index.rows[0]?.summary).toBe("bash bun migrate --production");
    expect(index.needs_you).toBe(1);
});

test("an open question carries the question text as its summary", () => {
    const index = buildWorkIndex([
        agent({
            id: "browser-tests",
            status: "waiting",
            pending_request: question("Which environment fails?"),
        }),
    ], [], { now });

    expect(index.rows[0]?.reason).toBe("question");
    expect(index.rows[0]?.summary).toBe("Which environment fails?");
});

test("a long summary is collapsed to one truncated line", () => {
    const index = buildWorkIndex([
        agent({
            status: "waiting",
            pending_request: question(`Which\n  of ${"the ".repeat(40)}fails?`),
        }),
    ], [], { now });

    const summary = index.rows[0]?.summary ?? "";
    expect(summary).not.toContain("\n");
    expect(summary.length).toBeLessThanOrEqual(72);
    expect(summary.startsWith("Which of the the")).toBe(true);
});

test("a working session reports the tool it is running", () => {
    const index = buildWorkIndex([
        agent({ id: "relay-gui", status: "working", active_tool: "edit" }),
    ], [], { now });

    expect(index.rows[0]?.section).toBe("working");
    expect(index.rows[0]?.reason).toBeUndefined();
    expect(index.rows[0]?.summary).toBe("Running edit");
    expect(index.working).toBe(1);
});

test("a working session with no tool in flight says only that it is working", () => {
    const index = buildWorkIndex([
        agent({ status: "working" }),
    ], [], { now });

    expect(index.rows[0]?.summary).toBe("Working");
});

test("running subagents are counted onto their parent row", () => {
    const index = buildWorkIndex([
        agent({ id: "relay-gui", status: "working" }),
        agent({ id: "one", kind: "background", status: "working", parent_id: "relay-gui" }),
        agent({ id: "two", kind: "background", status: "waiting", parent_id: "relay-gui" }),
        // Finished, so it is no longer one of the parent's running subagents.
        agent({ id: "three", kind: "background", status: "completed", parent_id: "relay-gui" }),
    ], [], { now });

    const parent = index.rows.find((row) => row.id === "relay-gui");
    expect(parent?.subagent_count).toBe(2);
});

test("a running subagent is counted on its parent, not listed beside it", () => {
    const index = buildWorkIndex([
        agent({ id: "relay-gui", status: "working" }),
        agent({ id: "one", kind: "background", status: "working", parent_id: "relay-gui" }),
    ], [], { now });

    expect(index.rows.map((row) => row.id)).toEqual(["relay-gui"]);
    expect(index.working).toBe(1);
});

test("a subagent still running under a finished parent keeps its own row", () => {
    // The common shape of async work: the parent's turn ended, its children
    // did not. Folding these into a parent row that does not exist would hide
    // running work entirely.
    const index = buildWorkIndex([
        agent({ id: "relay-gui", status: "idle" }),
        agent({ id: "one", kind: "background", status: "working", parent_id: "relay-gui" }),
        agent({ id: "two", kind: "background", status: "working", parent_id: "relay-gui" }),
    ], [], { now });

    expect(index.rows.map((row) => row.id).sort()).toEqual(["one", "two"]);
    expect(index.working).toBe(2);
});

test("a subagent whose parent is gone is work in its own right", () => {
    const index = buildWorkIndex([
        agent({ id: "orphan", kind: "background", status: "working", parent_id: "gone" }),
    ], [], { now });

    expect(index.rows.map((row) => row.id)).toEqual(["orphan"]);
});

test("a subagent blocked on an approval reaches the inbox itself", () => {
    const index = buildWorkIndex([
        agent({ id: "relay-gui", status: "working" }),
        agent({
            id: "child",
            kind: "background",
            status: "waiting",
            parent_id: "relay-gui",
            pending_request: approvalRequest("rm -rf build"),
        }),
    ], [], { now });

    const child = index.rows.find((row) => row.id === "child");
    expect(child?.section).toBe("needs_you");
    expect(child?.reason).toBe("approval");
});

test("a parent with no running subagents carries no count at all", () => {
    const index = buildWorkIndex([
        agent({ id: "solo", status: "working" }),
    ], [], { now });

    expect(index.rows[0]?.subagent_count).toBeUndefined();
});

test("a finished background result nobody opened lands in done_recently", () => {
    const index = buildWorkIndex([
        agent({
            id: "provider-fallback",
            kind: "background",
            status: "completed",
            unread_result: true,
            updated_at: "2026-08-14T11:46:00.000Z",
        }),
    ], [], { now });

    expect(index.rows[0]?.section).toBe("done_recently");
    expect(index.rows[0]?.reason).toBe("completion");
    expect(index.rows[0]?.summary).toBe("Finished, unread result");
});

test("an idle session with nothing outstanding is not work", () => {
    expect(buildWorkIndex([agent({ status: "idle" })], [], { now }).rows)
        .toEqual([]);
});

test("a live interactive failure is actionable and a background one is not", () => {
    const index = buildWorkIndex([
        agent({ id: "here", failure: "provider refused the turn", live: true }),
        agent({
            id: "there",
            kind: "background",
            live: false,
            failure: "provider refused the turn",
        }),
    ], [], { now });

    const here = index.rows.find((row) => row.id === "here");
    const there = index.rows.find((row) => row.id === "there");
    expect(here?.section).toBe("needs_you");
    expect(here?.reason).toBe("failure");
    expect(there?.section).toBe("done_recently");
    expect(there?.reason).toBe("completion");
});

test("sections come in a fixed order and each is newest first", () => {
    const index = buildWorkIndex([
        agent({
            id: "old-work",
            status: "working",
            updated_at: "2026-08-14T11:30:00.000Z",
        }),
        agent({
            id: "done",
            kind: "background",
            status: "completed",
            unread_result: true,
            updated_at: "2026-08-14T11:55:00.000Z",
        }),
        agent({
            id: "new-work",
            status: "working",
            updated_at: "2026-08-14T11:58:00.000Z",
        }),
        agent({
            id: "asked",
            status: "waiting",
            pending_request: question("Which one?"),
        }),
    ], [], { now });

    expect(index.rows.map((row) => row.id))
        .toEqual(["asked", "new-work", "old-work", "done"]);
});

test("a completed schedule run is a done_recently row of its own", () => {
    const schedule: WorkScheduleFacts = {
        schedule_id: "nightly-digest",
        session_id: "session",
        session_path: "/sessions/session.jsonl",
        title: "nightly-digest",
        workspace: "/w",
        completed_at: "2026-08-14T11:00:00.000Z",
    };
    const index = buildWorkIndex([], [schedule], { now });

    expect(index.rows[0]?.section).toBe("done_recently");
    expect(index.rows[0]?.reason).toBe("schedule");
    expect(index.rows[0]?.summary).toBe("Scheduled run completed");
    expect(index.rows[0]?.id).toBe(
        "schedule:nightly-digest:2026-08-14T11:00:00.000Z",
    );
});

test("finished work older than the recent window drops off entirely", () => {
    const index = buildWorkIndex([
        agent({
            id: "yesterday",
            kind: "background",
            status: "completed",
            unread_result: true,
            updated_at: "2026-08-13T12:00:00.000Z",
        }),
    ], [{
        schedule_id: "nightly",
        session_id: "session",
        session_path: "/sessions/session.jsonl",
        title: "nightly",
        workspace: "/w",
        completed_at: "2026-08-13T12:00:00.000Z",
    }], { now });

    expect(index.rows).toEqual([]);
});

test("work in progress stays on the list however long it has been running", () => {
    const index = buildWorkIndex([
        agent({ status: "working", updated_at: "2026-08-01T12:00:00.000Z" }),
    ], [], { now });

    expect(index.rows).toHaveLength(1);
});

test("the row count is bounded", () => {
    const many = Array.from({ length: 10 }, (_, offset) =>
        agent({ id: `agent-${offset}`, status: "working" }));

    expect(buildWorkIndex(many, [], { now, maxRows: 4 }).rows).toHaveLength(4);
    expect(buildWorkIndex(many, [], { now, maxRows: 4 }).working).toBe(4);
});

test("two indexes are the same only when every row field matches", () => {
    const build = (overrides: Partial<WorkAgentFacts>) =>
        buildWorkIndex([agent({ status: "working", ...overrides })], [], { now });
    const base = build({});

    expect(sameWorkIndex(base, build({}))).toBe(true);
    expect(sameWorkIndex(base, build({ active_tool: "bash" }))).toBe(false);
    expect(sameWorkIndex(base, build({ title: "renamed" }))).toBe(false);
    expect(sameWorkIndex(base, buildWorkIndex([], [], { now }))).toBe(false);
});

test("a finished session that changed files is ready to review", () => {
    const index = buildWorkIndex([
        agent({ id: "auth-race", status: "completed", changed_files: 5 }),
        agent({ id: "one-file", status: "idle", changed_files: 1 }),
    ], [], { now });

    const many = index.rows.find((row) => row.id === "auth-race");
    expect(many?.section).toBe("ready_to_review");
    expect(many?.reason).toBe("review");
    expect(many?.summary).toBe("5 files changed");
    expect(many?.changed_files).toBe(5);
    expect(index.rows.find((row) => row.id === "one-file")?.summary)
        .toBe("1 file changed");
});

test("the count is what it claims and nothing more", () => {
    const index = buildWorkIndex([
        agent({ id: "touched", status: "completed", changed_files: 2 }),
    ], [], { now });

    // No verdict on the change: not passing, not ready, not mergeable.
    const summary = index.rows[0]?.summary ?? "";
    expect(summary).toBe("2 files changed");
    for (const claim of ["ready", "pass", "merge", "%", "review"]) {
        expect(summary.toLowerCase()).not.toContain(claim);
    }
});

test("review sits below working and above done, in that order", () => {
    const index = buildWorkIndex([
        agent({
            id: "done",
            kind: "background",
            status: "completed",
            unread_result: true,
        }),
        agent({ id: "changed", status: "completed", changed_files: 1 }),
        agent({ id: "busy", status: "working" }),
        agent({
            id: "asked",
            status: "waiting",
            pending_request: question("Which one?"),
        }),
    ], [], { now });

    expect(index.rows.map((row) => row.id))
        .toEqual(["asked", "busy", "changed", "done"]);
});

test("what a session is doing outranks what it has changed", () => {
    // Still running, so the count would be wrong the moment it was drawn, and
    // the row that matters is what it is doing now.
    const working = buildWorkIndex([
        agent({ id: "busy", status: "working", changed_files: 3 }),
    ], [], { now });
    expect(working.rows[0]?.section).toBe("working");

    // An unread result is a thing to read; the files are still there when it
    // is opened.
    const unread = buildWorkIndex([
        agent({
            id: "done",
            kind: "background",
            status: "completed",
            unread_result: true,
            changed_files: 3,
        }),
    ], [], { now });
    expect(unread.rows[0]?.section).toBe("done_recently");
});

test("a session that changed nothing is not waiting to be reviewed", () => {
    expect(buildWorkIndex([
        agent({ id: "quiet", status: "completed", changed_files: 0 }),
        agent({ id: "untouched", status: "completed" }),
    ], [], { now }).rows).toEqual([]);
});

test("changes older than the recent window drop off like finished work", () => {
    expect(buildWorkIndex([
        agent({
            id: "yesterday",
            status: "completed",
            changed_files: 4,
            updated_at: "2026-08-13T12:00:00.000Z",
        }),
    ], [], { now }).rows).toEqual([]);
});
