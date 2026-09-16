import { expect, test } from "bun:test";
import { join } from "node:path";

import { startClientExtensionRegistry } from "../../src/extensions/client-registry.ts";

const EXTENSION = join(import.meta.dir, "../../extensions/btw");

async function start(visible: readonly {
    agentId: string;
    pane: "main" | "sidebar";
    mention?: string;
}[] = [{ agentId: "main", pane: "main" }], syncOutcomes: string[] = []) {
    const calls: unknown[] = [];
    const syncs: string[] = [];
    const failures: { message: string }[] = [];
    let mentions: readonly string[] = [];
    let created = 0;
    const mounted: any[] = [];
    const rawMounted: any[] = [];
    let layoutCycles = 0;
    let focusToggles = 0;
    let focused: "primary" | "secondary" = "primary";
    const registry = await startClientExtensionRegistry({
        extensions: [{ path: EXTENSION, enabled: true, config: null }],
        onFailure(failure) {
            failures.push(failure);
        },
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
        sidebar: {
            open() {},
            append() {},
            clear() {},
            close(extensionId) {
                calls.push({ operation: "close", extensionId });
            },
        },
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
                        focused,
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
            async syncContext(_extensionId, agentId) {
                syncs.push(agentId);
                const outcome = syncOutcomes.shift() ?? "unchanged";
                return { outcome: outcome as "unchanged", turns: 0 };
            },
            async message(extensionId, request) {
                calls.push({ operation: "message", extensionId, request });
            },
        },
    });
    return {
        registry,
        calls,
        syncs,
        failures,
        mentions: () => mentions,
        mounted,
        rawMounted,
        layoutCycles: () => layoutCycles,
        focusToggles: () => focusToggles,
        focus(pane: "primary" | "secondary") {
            focused = pane;
        },
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
            hideInheritedMessages: true,
            initialMessages: [{
                role: "user",
                text: expect.stringContaining("reference context only"),
                hidden: true,
                compactionBarrier: true,
            }],
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

test("pair close detaches the peer pane without creating another session", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("pair", "", "/workspace");
    harness.calls.length = 0;

    await harness.registry.invokeCommand("pair", "close", "/workspace");

    expect(harness.calls).toEqual([{
        operation: "close",
        extensionId: "vera.btw",
    }]);
    expect(harness.mentions()).toEqual([]);
    await harness.registry.close();
});

test("btw owns pane controls without mounting client chrome", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "", "/workspace");

    expect(harness.rawMounted).toEqual([]);
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
    expect(harness.syncs).toEqual(["side-1"]);
    await harness.registry.close();
});

test("a bare prompt from the primary while btw is open synchronizes", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "first", "/workspace");
    harness.syncs.length = 0;

    expect(await harness.registry.interceptMessage({
        text: "follow up",
        workspace: "/workspace",
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    expect(harness.syncs).toEqual(["side-1"]);
    expect(harness.failures).toEqual([]);
    await harness.registry.close();
});

test("repeated messages while the sidekick is focused skip sync", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "first", "/workspace");
    harness.syncs.length = 0;
    harness.focus("secondary");

    expect(await harness.registry.interceptMessage({
        text: "second",
        workspace: "/workspace",
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    expect(await harness.registry.interceptMessage({
        text: "third",
        workspace: "/workspace",
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    expect(harness.syncs).toEqual([]);
    expect(harness.failures).toEqual([]);
    await harness.registry.close();
});

test("an @sidekick message skips sync even when the primary is focused", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "first", "/workspace");
    harness.syncs.length = 0;

    expect(await harness.registry.interceptMessage({
        text: "@sidekick what broke",
        workspace: "/workspace",
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    expect(harness.syncs).toEqual([]);
    expect(harness.failures).toEqual([]);
    await harness.registry.close();
});

test("an @vera message still synchronizes while the sidekick is focused", async () => {
    const harness = await start();
    await harness.registry.invokeCommand("btw", "first", "/workspace");
    harness.syncs.length = 0;
    harness.focus("secondary");

    expect(await harness.registry.interceptMessage({
        text: "@vera keep going",
        workspace: "/workspace",
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    expect(harness.syncs).toEqual(["side-1"]);
    expect(harness.failures).toEqual([]);
    await harness.registry.close();
});

test("a busy primary sync on a primary prompt is a no-op", async () => {
    const harness = await start(undefined, ["busy"]);
    await harness.registry.invokeCommand("btw", "", "/workspace");
    harness.syncs.length = 0;
    harness.failures.length = 0;

    expect(await harness.registry.interceptMessage({
        text: "continue on vera",
        workspace: "/workspace",
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    expect(harness.syncs).toEqual(["side-1"]);
    expect(harness.failures).toEqual([]);
    await harness.registry.close();
});

test("a missing primary context still fails the interceptor", async () => {
    const harness = await start(undefined, ["not_found"]);
    await harness.registry.invokeCommand("btw", "", "/workspace");
    harness.failures.length = 0;

    expect(await harness.registry.interceptMessage({
        text: "continue on vera",
        workspace: "/workspace",
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    expect(harness.failures).toEqual([expect.objectContaining({
        extensionId: "vera.btw",
        message: expect.stringContaining("BTW primary context is unavailable"),
    })]);
    await harness.registry.close();
});

test("a failed primary sync still fails the interceptor", async () => {
    const harness = await start(undefined, ["failed"]);
    await harness.registry.invokeCommand("btw", "", "/workspace");
    harness.failures.length = 0;

    expect(await harness.registry.interceptMessage({
        text: "continue on vera",
        workspace: "/workspace",
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    expect(harness.failures).toEqual([expect.objectContaining({
        extensionId: "vera.btw",
        message: expect.stringContaining(
            "BTW primary context could not be synchronized",
        ),
    })]);
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

test("a stale cursor drops the sidekick and branches again", async () => {
    const harness = await start(undefined, ["stale_cursor"]);
    await harness.registry.invokeCommand("btw", "", "/workspace");
    harness.calls.length = 0;
    harness.syncs.length = 0;

    await harness.registry.invokeCommand("btw", "second", "/workspace");

    // The primary was rewound past the sync point, so the old branch is dead:
    // the second message goes to a fresh branch off the rewound primary.
    expect(harness.syncs).toEqual(["side-1"]);
    expect(harness.calls).toMatchObject([
        { operation: "open", request: { agentId: "side-1" } },
        { operation: "create", request: { source: { type: "branch", agentId: "main" } } },
        { operation: "message", request: { agentId: "side-2", text: "second" } },
    ]);
    await harness.registry.close();
});

test("a stale cursor on a primary prompt while btw is open branches again", async () => {
    const harness = await start(undefined, ["stale_cursor"]);
    await harness.registry.invokeCommand("btw", "", "/workspace");
    harness.calls.length = 0;

    expect(await harness.registry.interceptMessage({
        text: "follow up",
        workspace: "/workspace",
        imageCount: 0,
    })).toEqual({ kind: "pass" });
    expect(harness.calls).toMatchObject([
        { operation: "create", request: { source: { type: "branch", agentId: "main" } } },
    ]);
    expect(harness.failures).toEqual([]);
    await harness.registry.close();
});
