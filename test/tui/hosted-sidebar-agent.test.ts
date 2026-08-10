import { expect, test } from "bun:test";

import { AsyncQueue } from "../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import type { IdentifiedTuiAgentClient } from "../../clients/tui/agent-client.ts";
import { TuiHostedSidebarAgent } from
    "../../clients/tui/hosted-sidebar-agent.ts";

function client(agentId: string) {
    const updates = new AsyncQueue<AgentUpdate>();
    const detached: string[] = [];
    const closed: string[] = [];
    const value: IdentifiedTuiAgentClient = {
        agentId,
        async send() {},
        receive: (signal) => updates.receive(signal),
        async detach() {
            detached.push(agentId);
        },
        close() {
            closed.push(agentId);
        },
    };
    return { value, detached, closed };
}

function sidebar() {
    return new TuiHostedSidebarAgent({
        onUpdate() {},
        onFailure() {},
    });
}

test("an extension can claim only the available sidebar", () => {
    const slot = sidebar();
    slot.claim("one");
    slot.claim("one");
    expect(() => slot.claim("two")).toThrow("one is using the sidebar");
    expect(slot.owner).toBe("one");
});

test("adopting a replacement detaches the previous pane and preserves metadata", async () => {
    const slot = sidebar();
    const first = client("first");
    const second = client("second");
    await slot.adopt({
        extensionId: "vera.btw",
        client: first.value,
        mention: "sidekick",
        attachmentLifetime: "ephemeral",
        initialApprovalMode: "readonly",
        statusLabel: "btw",
    });

    const previousMode = await slot.adopt({
        extensionId: "vera.btw",
        client: second.value,
        mention: "peer",
        statusLabel: "pair",
    });

    expect(first.detached).toEqual(["first"]);
    expect(previousMode).toBe("btw");
    expect(slot.pane?.agentId).toBe("second");
    expect(slot.mention).toBe("peer");
    expect(slot.modeLabel).toBe("pair");
    expect(slot.initialApprovalMode).toBe("readonly");
    slot.start();
    await slot.release()?.detach();
});

test("a cancelled or rejected adoption closes the incoming client", async () => {
    const slot = sidebar();
    slot.claim("one");
    const occupied = client("occupied");
    await expect(slot.adopt({
        extensionId: "two",
        client: occupied.value,
    })).rejects.toThrow("one is using the sidebar");
    expect(occupied.closed).toEqual(["occupied"]);

    const cancelled = client("cancelled");
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(slot.adopt({
        extensionId: "one",
        client: cancelled.value,
        signal: controller.signal,
    })).rejects.toThrow("cancelled");
    expect(cancelled.closed).toEqual([]);
});

test("the caller starts updates only after its sidebar is ready", async () => {
    const failures: string[] = [];
    const slot = new TuiHostedSidebarAgent({
        onUpdate() {},
        onFailure(error) {
            failures.push(error.message);
        },
    });
    const broken: IdentifiedTuiAgentClient = {
        agentId: "broken",
        async send() {},
        receive: () => Promise.reject(new Error("connection lost")),
        async detach() {},
        close() {},
    };

    await slot.adopt({ extensionId: "vera.btw", client: broken });
    await Promise.resolve();
    expect(failures).toEqual([]);

    slot.start();
    await Promise.resolve();
    expect(failures).toEqual(["connection lost"]);
    await slot.release()?.detach();
});
