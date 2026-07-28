import { expect, test } from "bun:test";

import { resolveResumeTarget } from "../../clients/tui/session-target.ts";
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
