import { expect, test } from "bun:test";

import {
    backgroundAgentsSnapshot,
    sameBackgroundAgents,
} from "../../src/host/background-agents.ts";

test("the running count counts the live background agents only", () => {
    expect(backgroundAgentsSnapshot([
        backgroundAgent("working"),
        backgroundAgent("waiting"),
        // Resident and idle, which is every background session the host
        // restored at startup. Nothing is running in it.
        backgroundAgent("idle"),
        // Live because someone attached to read it, which is not running.
        { ...backgroundAgent("completed"), live: true },
        backgroundAgent("closed"),
        backgroundAgent("failed"),
        {
            ...backgroundAgent("working"),
            id: "interactive",
            kind: "interactive" as const,
        },
    ], "main").running).toBe(2);
});

test("the children are the attached session's running background agents", () => {
    expect(backgroundAgentsSnapshot([
        { ...backgroundAgent("working"), parent_id: "main", title: "research" },
        { ...backgroundAgent("waiting"), parent_id: "main", title: "review" },
        { ...backgroundAgent("completed"), parent_id: "main", title: "done" },
        { ...backgroundAgent("working"), parent_id: "other", title: "else" },
    ], "main").children).toEqual(["research", "review"]);
});

test("a child without a title is named by its id", () => {
    expect(backgroundAgentsSnapshot(
        [{ ...backgroundAgent("working"), parent_id: "main" }],
        "main",
    ).children).toEqual(["background-working"]);
});

test("the parent flag describes the attached session, not its children", () => {
    const agents = [
        { ...backgroundAgent("working"), id: "child", parent_id: "main" },
        { ...backgroundAgent("idle"), id: "main", kind: "interactive" as const },
    ];
    expect(backgroundAgentsSnapshot(agents, "child").has_parent).toBe(true);
    expect(backgroundAgentsSnapshot(agents, "main").has_parent).toBe(false);
});

test("two snapshots are the same only when every fact matches", () => {
    const base = { running: 1, children: ["one"], has_parent: false };
    expect(sameBackgroundAgents(base, { ...base, children: ["one"] })).toBe(true);
    expect(sameBackgroundAgents(base, { ...base, running: 2 })).toBe(false);
    expect(sameBackgroundAgents(base, { ...base, children: ["two"] }))
        .toBe(false);
    expect(sameBackgroundAgents(base, { ...base, has_parent: true }))
        .toBe(false);
});

function backgroundAgent(
    status: "idle" | "working" | "waiting" | "completed" | "closed" | "failed",
) {
    return {
        id: `background-${status}`,
        workspace: "/workspace",
        session_path: `/sessions/${status}.jsonl`,
        kind: "background" as const,
        status,
        live: status === "working" || status === "waiting",
    };
}
