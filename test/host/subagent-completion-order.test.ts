import { expect, test } from "bun:test";

import type { AgentRegistry } from "../../src/host/agent-registry.ts";
import { deliverBackgroundResult } from "../../src/host/agent-registry/subagent.ts";
import type { RegisteredAgentEntry } from "../../src/host/agent-registry/support.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import type { SessionStore } from "../../src/store/session-store.ts";

test("a local completion begins recording before the next microtask", async () => {
    const order: string[] = [];
    const parentStore = {
        recordDelivery: () => {
            order.push("record");
            return Promise.resolve(true);
        },
    } as unknown as SessionStore;
    const child = {
        agent: { id: "child" },
        store: {
            header: { cwd: "/work" },
            messages: () => [{ role: "assistant", content: [{ type: "text", text: "Found the map" }] }],
        },
        pendingAsyncTurns: 1,
        pendingCompletionDeliveries: 0,
        completionSequence: 1,
        completed: false,
    } as unknown as RegisteredAgentEntry;
    const registry = {
        agents: new Map([["child", child]]),
        suppressedCompletionDeliveries: new WeakSet(),
        closingCompletionRecipients: new WeakSet(),
        spawnNotices: new Map(),
        options: {},
    } as unknown as AgentRegistry;
    const attachment = {
        receive: async () => ({ type: "turn_finished" }),
        detach: () => queueMicrotask(() => { order.push("microtask"); }),
    } as unknown as AgentAttachment;

    await deliverBackgroundResult(registry, { id: "parent", store: parentStore }, child, attachment, 1);
    expect(order).toEqual(["record", "microtask"]);
});
