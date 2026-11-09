import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiAgentClient } from "../../../clients/tui/agent-client.ts";
import { AsyncQueue } from "../../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

test("a resident failure displays its detail and settles the turn", async () => {
    const updates = new AsyncQueue<AgentUpdate>();
    updates.push({ type: "history", entries: [], seq: 0 });
    updates.push({ type: "user_prompt", content: "Chart a course", seq: 1 });
    const client: TuiAgentClient = {
        agentId: "crow-session",
        async send() {},
        receive: (signal) => updates.receive(signal),
        async detach() {},
        close() {},
    };
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-resident-failure-")),
        dependencies: () => ({ client }),
    });
    try {
        await session.waitForVisiblePane("Chart a course");
        updates.push({
            type: "agent_failed", failureId: "failure-1", detail: "Injected context persistence failure", seq: 2,
        });
        const pane = await session.waitForVisiblePane("Injected context persistence failure");
        expect(pane).toContain("AGENT STOPPED");
        expect(pane).not.toContain("Working (");
    } finally {
        await session.close();
    }
}, 15_000);
