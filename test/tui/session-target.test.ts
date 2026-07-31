import { expect, test } from "bun:test";

import {
    renderResumeHint,
    resolveContinueTarget,
    resolveResumeTarget,
} from "../../clients/tui/session-target.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";

test("resume selectors prefer exact interactive IDs and preserve paths", () => {
    const agents: RegisteredAgentSummary[] = [
        {
            id: "session-1",
            workspace: "/work/vera",
            session_path: "/sessions/session-1.jsonl",
            kind: "interactive",
            status: "idle",
            live: false,
        },
        {
            id: "background-1",
            workspace: "/work/vera",
            session_path: "/sessions/background-1.jsonl",
            kind: "background",
            status: "working",
            live: false,
        },
    ];

    expect(resolveResumeTarget(agents, "session-1")).toEqual({
        type: "attach",
        agentId: "session-1",
    });
    expect(resolveResumeTarget(agents, "/sessions/session-1.jsonl")).toEqual({
        type: "resume",
        sessionPath: "/sessions/session-1.jsonl",
    });
    expect(resolveResumeTarget(agents, "background-1")).toEqual({
        type: "attach",
        agentId: "background-1",
    });
});

test("continue selects the latest interactive session, not a child", () => {
    const agents: RegisteredAgentSummary[] = [
        {
            id: "older",
            workspace: "/work/vera",
            session_path: "/sessions/older.jsonl",
            kind: "interactive",
            status: "idle",
            live: false,
            updated_at: "2026-07-28T12:00:00.000Z",
        },
        {
            id: "child",
            workspace: "/work/vera",
            session_path: "/sessions/child.jsonl",
            kind: "background",
            status: "completed",
            live: false,
            updated_at: "2026-07-29T13:00:00.000Z",
        },
        {
            id: "latest",
            workspace: "/work/vera",
            session_path: "/sessions/latest.jsonl",
            kind: "interactive",
            status: "idle",
            live: false,
            updated_at: "2026-07-29T12:00:00.000Z",
        },
    ];

    expect(resolveContinueTarget(agents)).toEqual({
        type: "attach",
        agentId: "latest",
    });
    expect(resolveContinueTarget(agents, "older")).toEqual({
        type: "attach",
        agentId: "older",
    });
    expect(resolveContinueTarget(agents, "missing")).toEqual({
        type: "attach",
        agentId: "latest",
    });
    expect(() => resolveContinueTarget([agents[1]!])).toThrow(
        "No previous Vera session to continue",
    );
});

test("the TUI exit hint names the session that can be resumed", () => {
    expect(renderResumeHint("019f8d27-4206-7f61-9123-a65fa174d97c")).toBe(
        "\nTo continue this session, run: "
        + "vera resume 019f8d27-4206-7f61-9123-a65fa174d97c\n",
    );
    expect(renderResumeHint(undefined)).toBe("");
});
