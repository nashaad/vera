import { expect, test } from "bun:test";
import { join } from "node:path";

import { startClientExtensionRegistry } from "../../src/extensions/client-registry.ts";

const EXTENSION = join(import.meta.dir, "../../examples/extensions/btw");

async function start() {
    const calls: unknown[] = [];
    let mentions: readonly string[] = [];
    let created = 0;
    const registry = await startClientExtensionRegistry({
        extensions: [{ path: EXTENSION, enabled: true, config: null }],
        preferences: {
            async get() {
                return undefined;
            },
            async set() {},
            async delete() {},
        },
        modelSettings: {
            current: () => undefined,
            async update() {
                return { status: "rejected", reason: "unavailable" };
            },
            subscribe: () => () => undefined,
        },
        picker: {
            async request() {
                return { outcome: "cancelled" };
            },
        },
        notice: { post() {} },
        mentions: {
            set(_extensionId, names) {
                mentions = [...names];
            },
        },
        agents: {
            async create(extensionId, request) {
                created += 1;
                calls.push({ operation: "create", extensionId, request });
                return { agentId: `side-${created}` };
            },
            async open(extensionId, request) {
                calls.push({ operation: "open", extensionId, request });
            },
            async message(extensionId, request) {
                calls.push({ operation: "message", extensionId, request });
            },
        },
    });
    return {
        registry,
        calls,
        mentions: () => mentions,
    };
}

test("bare btw creates and opens a readonly hosted sidekick", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "", "/workspace");

    expect(harness.calls).toEqual([{
        operation: "create",
        extensionId: "vera.btw",
        request: {
            pane: "sidebar",
            mention: "sidekick",
            workspace: "/workspace",
            approvalMode: "readonly",
        },
    }]);
    expect(harness.mentions()).toEqual(["sidekick", "all", "vera"]);
    await harness.registry.close();
});

test("btw text sends the text to the hosted sidekick", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", " inspect this ", "/workspace");

    expect(harness.calls.at(-1)).toEqual({
        operation: "message",
        extensionId: "vera.btw",
        request: { agentId: "side-1", text: "inspect this" },
    });
    await harness.registry.close();
});

test("another btw reopens the same sidekick instead of creating one", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "first", "/workspace");
    await harness.registry.invokeCommand("btw", "second", "/workspace");

    expect(harness.calls).toContainEqual({
        operation: "open",
        extensionId: "vera.btw",
        request: { agentId: "side-1", pane: "sidebar", mention: "sidekick" },
    });
    expect(harness.calls.filter((call: any) => call.operation === "create"))
        .toHaveLength(1);
    await harness.registry.close();
});

test("a new main conversation gets a new sidekick", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "first", "/workspace");
    harness.registry.conversationChanged();
    expect(harness.mentions()).toEqual([]);
    await harness.registry.invokeCommand("btw", "second", "/workspace");

    expect(harness.calls).toContainEqual({
        operation: "message",
        extensionId: "vera.btw",
        request: { agentId: "side-2", text: "second" },
    });
    await harness.registry.close();
});
