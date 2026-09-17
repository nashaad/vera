import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    startClientExtensionRegistry,
    type ClientExtensionExperimentalTuiAdapter,
    type StartClientExtensionRegistryOptions,
} from "../../src/extensions/client-registry.ts";
import type {
    VeraClientSessionListRequest,
    VeraClientSessionPage,
} from "../../src/sdk/extensions.ts";
import type {
    VeraExperimentalTuiNode,
    VeraExperimentalTuiViewSpec,
} from "../../src/sdk/experimental-tui.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("the dashboard command mounts an overlay and pages the session listing", async () => {
    const directory = createExtension();
    const requests: VeraClientSessionListRequest[] = [];
    let mounted: VeraExperimentalTuiViewSpec | undefined;
    const registry = await startClientExtensionRegistry(registryOptions(
        directory,
        async (_extensionId, request) => {
            requests.push(request);
            return page(requests.length);
        },
        (_extensionId, spec) => {
            mounted = spec;
            return async () => {};
        },
    ));

    try {
        const result = await registry.invokeCommand("dashboard", "", "/work");
        expect(result?.body).toEqual({ kind: "handled" });
        expect(mounted?.slot).toBe("overlay");
        expect(mounted?.modal).toBe(true);

        await Bun.sleep(20);
        // The refresh pages until the listing is exhausted, and it names the
        // facts it needs rather than taking whatever the host offers.
        expect(requests).toHaveLength(2);
        expect(requests[0]?.include).toEqual([
            "usage",
            "context",
            "failure",
            "model",
        ]);
        expect(requests[0]?.order).toBe("recent");
        expect(requests[0]?.cursor).toBeUndefined();
        expect(requests[1]?.cursor).toBe("session-1");

        const node = mounted!.render(renderContext(120));
        const text = flatten(node).join("\n");
        expect(text).toContain("2 of 2 sessions");
        expect(text).toContain("first session");
        expect(text).toContain("second session");
        // Both pages are folded into the totals, not just the first.
        expect(text).toContain("$0.7500");
    } finally {
        await registry.close();
    }
});

test("the dashboard renders before the listing arrives", async () => {
    const directory = createExtension();
    let mounted: VeraExperimentalTuiViewSpec | undefined;
    const registry = await startClientExtensionRegistry(registryOptions(
        directory,
        () => new Promise<VeraClientSessionPage>(() => {}),
        (_extensionId, spec) => {
            mounted = spec;
            return async () => {};
        },
    ));

    try {
        await registry.invokeCommand("dashboard", "", "/work");
        const text = flatten(mounted!.render(renderContext(80))).join("\n");
        expect(text).toContain("0 sessions");
        expect(text).toContain("not refreshed yet");
    } finally {
        await registry.close();
    }
});

function page(index: number): VeraClientSessionPage {
    const first = index === 1;
    return {
        sessions: [{
            id: `session-${index}`,
            title: first ? "first session" : "second session",
            workspace: "/work",
            kind: "interactive",
            status: "idle",
            live: false,
            facts: {
                usage: {
                    rows: [{
                        provider: "faux",
                        model: "test",
                        calls: 1,
                        durationMs: 10,
                        inputTokens: 100,
                        outputTokens: 10,
                        cachedInputTokens: 0,
                        reasoningTokens: 0,
                        totalTokens: 110,
                        cost: first ? 0.5 : 0.25,
                        callsWithoutCost: 0,
                    }],
                },
            },
        }],
        ...(first ? { nextCursor: "session-1" } : {}),
        total: 2,
    };
}

function renderContext(width: number) {
    return {
        width,
        height: 60,
        workspace: "/work",
        theme: {
            text: "#fff",
            muted: "#888",
            accent: "#0af",
            notice: "#fa0",
            success: "#0f0",
            panel: "#111",
        },
        requestRender() {},
    } as unknown as Parameters<VeraExperimentalTuiViewSpec["render"]>[0];
}

function flatten(node: VeraExperimentalTuiNode): string[] {
    if (node.kind === "text") return [node.text];
    if (node.kind === "button") return [node.label];
    if (node.kind === "stack") return node.children.flatMap(flatten);
    return [];
}

function registryOptions(
    path: string,
    list: (
        extensionId: string,
        request: VeraClientSessionListRequest,
    ) => Promise<VeraClientSessionPage>,
    mount: ClientExtensionExperimentalTuiAdapter["mount"],
): StartClientExtensionRegistryOptions {
    const experimentalTui: ClientExtensionExperimentalTuiAdapter = {
        mount,
        mountRenderable: () => async () => {},
        appendTranscriptRenderable: () => async () => {},
        events: { on: () => async () => {} },
        agentSurface: {
            current: () => undefined,
            cycleLayout: () => false,
            toggleFocus: () => false,
        },
    };
    return {
        extensions: [{ path, enabled: true, config: null }],
        preferences: {
            get: async () => undefined,
            set: async () => {},
            delete: async () => {},
        },
        modelSettings: {
            current: () => undefined,
            update: async () => ({
                status: "accepted",
                settings: { model: "test" },
            }),
            subscribe: () => () => {},
        },
        picker: { request: async () => ({ outcome: "cancelled" }) },
        notice: { post: () => {} },
        sessions: { list },
        experimentalTui,
    };
}

function createExtension(): string {
    const directory = join(
        tmpdir(),
        `vera-dashboard-extension-${crypto.randomUUID()}`,
    );
    mkdirSync(directory);
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
        id: "example.dashboard.test",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "extension.ts",
        capabilities: [
            "client.commands.register",
            "client.sessions.read",
            "client.experimental_tui",
        ],
    }));
    const dashboard = join(
        import.meta.dir,
        "../../extensions/context/dashboard.ts",
    );
    writeFileSync(join(directory, "extension.ts"), `
        import { registerDashboard } from ${JSON.stringify(dashboard)};

        export function activateClient(vera) {
            registerDashboard(vera);
        }
    `);
    return directory;
}
