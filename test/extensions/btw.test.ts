import { expect, test } from "bun:test";
import { join } from "node:path";

import { startClientExtensionRegistry } from "../../src/extensions/client-registry.ts";

const EXTENSION = join(import.meta.dir, "../../examples/extensions/btw");

async function start(visible: readonly {
    agentId: string;
    pane: "main" | "sidebar";
    mention?: string;
}[] = [{ agentId: "main", pane: "main" }]) {
    const calls: unknown[] = [];
    let mentions: readonly string[] = [];
    let created = 0;
    const mounted: any[] = [];
    const rawMounted: any[] = [];
    let layoutCycles = 0;
    let focusToggles = 0;
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
        experimentalTui: {
            mount(_extensionId, spec) {
                mounted.push(spec);
                return async () => {};
            },
            mountRenderable(_extensionId, spec) {
                rawMounted.push(spec);
                return async () => {};
            },
            events: {
                on() { return async () => {}; },
            },
            agentSurface: {
                current() {
                    return {
                        layout: "split" as const,
                        focused: "primary" as const,
                    };
                },
                cycleLayout() {
                    layoutCycles += 1;
                    return true;
                },
                toggleFocus() {
                    focusToggles += 1;
                    return true;
                },
            },
        },
        agents: {
            visible() {
                return visible;
            },
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
        mounted,
        rawMounted,
        layoutCycles: () => layoutCycles,
        focusToggles: () => focusToggles,
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
            attachmentLifetime: "ephemeral",
            statusLabel: "btw",
            source: { type: "branch", agentId: "main" },
        },
    }]);
    expect(harness.mentions()).toEqual(["sidekick", "all", "vera"]);
    await harness.registry.close();
});

test("pair creates a durable tool-capable peer", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("pair", "", "/workspace");

    expect(harness.calls).toEqual([{
        operation: "create",
        extensionId: "vera.btw",
        request: {
            pane: "sidebar",
            mention: "peer",
            workspace: "/workspace",
            approvalMode: "ask",
            attachmentLifetime: "durable",
            statusLabel: "pair",
        },
    }]);
    expect(harness.registry.experimentalHostedAgentAddressing("vera.btw"))
        .toEqual({ primary: "vera", secondary: "peer", broadcast: "all" });
    await harness.registry.close();
});

test("btw owns its mode footer and pane controls", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "", "/workspace");

    expect(harness.rawMounted.map((spec) => spec.id)).toContain("agent-mode");
    await harness.registry.invokeKeybinding(
        "cycle-agent-layout",
        "/workspace",
    );
    await harness.registry.invokeKeybinding(
        "switch-agent-pane",
        "/workspace",
    );
    expect(harness.layoutCycles()).toBe(1);
    expect(harness.focusToggles()).toBe(1);
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

test("btw sends submitted images to the sidekick", async () => {
    const harness = await start();

    await harness.registry.invokeCommand(
        "btw",
        "what do you see",
        "/workspace",
        undefined,
        1,
        ["/tmp/screenshot.png"],
    );

    expect(harness.calls.at(-1)).toEqual({
        operation: "message",
        extensionId: "vera.btw",
        request: {
            agentId: "side-1",
            text: "what do you see",
            imagePaths: ["/tmp/screenshot.png"],
        },
    });
    await harness.registry.close();
});

test("btw can send an image without accompanying text", async () => {
    const harness = await start();

    await harness.registry.invokeCommand(
        "btw",
        "",
        "/workspace",
        undefined,
        1,
        ["/tmp/screenshot.png"],
    );

    expect(harness.calls.at(-1)).toEqual({
        operation: "message",
        extensionId: "vera.btw",
        request: {
            agentId: "side-1",
            text: "",
            imagePaths: ["/tmp/screenshot.png"],
        },
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
        request: {
            agentId: "side-1",
            pane: "sidebar",
            mention: "sidekick",
            attachmentLifetime: "ephemeral",
            statusLabel: "btw",
        },
    });
    expect(harness.calls.filter((call: any) => call.operation === "create"))
        .toHaveLength(1);
    await harness.registry.close();
});

test("pair reuses a restored visible peer", async () => {
    const harness = await start([{
        agentId: "restored-peer",
        pane: "sidebar",
        mention: "peer",
    }]);
    await harness.registry.invokeCommand("pair", "continue", "/workspace");

    expect(harness.calls.filter((call: any) => call.operation === "create"))
        .toHaveLength(0);
    expect(harness.calls).toContainEqual({
        operation: "message",
        extensionId: "vera.btw",
        request: { agentId: "restored-peer", text: "continue" },
    });
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
