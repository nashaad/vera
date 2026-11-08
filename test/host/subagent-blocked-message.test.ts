import { expect, test } from "bun:test";

import type { AgentRegistry } from "../../src/host/agent-registry.ts";
import { messageSubagent } from "../../src/host/agent-registry/subagent.ts";
import { SessionBlockedError } from "../../src/host/resident-agent.ts";
import type { SessionStore } from "../../src/store/session-store.ts";

const BLOCKED = "Session child-1 is blocked. Nothing new runs in it until 'vera unblock child-1'.";

test("messaging a blocked async subagent returns the blocked error at once", async () => {
    let attempts = 0;
    const child = {
        kind: "background",
        parentId: "parent",
        failure: undefined,
        agent: {
            closed: false,
            sendPrompt(): void {
                attempts += 1;
                throw new SessionBlockedError(BLOCKED);
            },
        },
    };
    const reg = { agents: new Map([["child-1", child]]) } as unknown as AgentRegistry;
    const parentStore = { header: { id: "parent" } } as unknown as SessionStore;

    const output = await messageSubagent(reg, parentStore, {
        type: "message_subagent",
        subagentId: "child-1",
        message: "status please",
    });

    expect(output).toEqual({ kind: "output", output: BLOCKED, isError: true });
    expect(attempts).toBe(1);
});
