import { expect, test } from "bun:test";
import { join } from "node:path";

import {
    configuredTuiClientExtensions,
    createTuiClientExtensionHostController,
    startTuiClientExtensionHost,
} from "../../clients/tui/client-extension-host.ts";
import { TuiCommandRegistry } from "../../clients/tui/commands.ts";
import type { ClientExtensionRegistry } from
    "../../src/extensions/client-registry.ts";

const DISABLED_BUILTINS = [
    "vera.model-presets",
    "vera.reasoning-cycle",
] as const;

function fakeRegistry(
    name: string,
    events: string[],
): ClientExtensionRegistry {
    return {
        close: async () => {
            events.push(`close:${name}`);
        },
    } as unknown as ClientExtensionRegistry;
}

test("the client extension controller replaces generations in order", async () => {
    const events: string[] = [];
    let generation = 0;
    const controller = createTuiClientExtensionHostController(
        async () => {
            const name = String(++generation);
            events.push(`start:${name}`);
            return fakeRegistry(name, events);
        },
        (registry) => events.push(registry === undefined ? "none" : "ready"),
    );

    await controller.reload();
    await Promise.all([controller.reload(), controller.reload()]);

    expect(events).toEqual([
        "start:1",
        "ready",
        "none",
        "close:1",
        "start:2",
        "ready",
        "none",
        "close:2",
        "start:3",
        "ready",
    ]);
    expect(controller.current()).toBeDefined();
    await controller.close();
    expect(events.slice(-2)).toEqual(["none", "close:3"]);
});

test("closing during activation disposes the unpublished generation", async () => {
    const events: string[] = [];
    const started = Promise.withResolvers<void>();
    const activated = Promise.withResolvers<ClientExtensionRegistry>();
    const controller = createTuiClientExtensionHostController(
        () => {
            started.resolve();
            return activated.promise;
        },
        () => events.push("published"),
    );

    const loading = controller.reload();
    await started.promise;
    const closing = controller.close();
    activated.resolve(fakeRegistry("late", events));
    await Promise.all([loading, closing]);

    expect(controller.current()).toBeUndefined();
    expect(events).toEqual(["close:late"]);
});

test("closing aborts an activation that has not settled", async () => {
    const started = Promise.withResolvers<void>();
    const controller = createTuiClientExtensionHostController(
        (signal) => {
            started.resolve();
            return new Promise((_resolve, reject) => {
                signal.addEventListener(
                    "abort",
                    () => reject(new Error("activation cancelled")),
                    { once: true },
                );
            });
        },
        () => {},
    );

    const loading = controller.reload();
    await started.promise;
    const closing = controller.close();

    await expect(loading).rejects.toThrow("activation cancelled");
    await closing;
    expect(controller.current()).toBeUndefined();
});

test("the TUI extension host binds a configured extension to client surfaces", async () => {
    const sidebar: string[] = [];
    const notices: string[] = [];
    const commandRegistry = new TuiCommandRegistry();
    const extension = {
        path: join(
            import.meta.dir,
            "../support/fixtures/sidebar-extension",
        ),
        enabled: true,
        config: {},
    };
    const extensions = configuredTuiClientExtensions(
        DISABLED_BUILTINS,
        [extension, {
            path: join(
                import.meta.dir,
                "../support/fixtures/conflicting-keybinding-extension",
            ),
            enabled: true,
            config: {},
        }],
    );
    const registry = await startTuiClientExtensionHost({
        extensions,
        currentModelSettings: () => undefined,
        updateModelSettings: async () => {
            throw new Error("unused");
        },
        subscribeModelSettings: () => () => {},
        requestPicker: async () => {
            throw new Error("unused");
        },
        requestConsult: async () => {
            throw new Error("unused");
        },
        openSidebar: (extensionId) => sidebar.push(`open:${extensionId}`),
        appendSidebar: (extensionId, block) =>
            sidebar.push(`append:${extensionId}:${block.text}`),
        clearSidebar: () => {},
        closeSidebar: (extensionId) => sidebar.push(`close:${extensionId}`),
        setMentions: () => {},
        setAddressing: () => {},
        agents: {
            visible: () => [],
            create: async () => {
                throw new Error("unused");
            },
            open: async () => {
                throw new Error("unused");
            },
            message: async () => {
                throw new Error("unused");
            },
        },
        experimentalTui: {
            mount: () => () => {},
            mountRenderable: () => () => {},
            events: { on: () => () => {} },
            agentSurface: {
                current: () => undefined,
                cycleLayout: () => false,
                toggleFocus: () => false,
            },
        },
        readThread: () => [],
        appendTranscript: () => {},
        postNotice: (text) => notices.push(text),
        commandRegistry,
        onFailure: (failure) => {
            throw new Error(failure.message);
        },
    });

    await registry.invokeCommand("pane", "", "/tmp");
    await registry.invokeCommand("unpane", "", "/tmp");

    expect(sidebar).toEqual([
        "open:test.sidebar",
        "append:test.sidebar:beside the transcript",
        "close:test.sidebar",
    ]);
    expect(commandRegistry.hasCommand("pane")).toBe(true);
    expect(commandRegistry.registeredPaletteActions()).toHaveLength(2);
    expect(notices).toEqual([
        "open-help cannot use ctrl+p: Vera already uses it to open the command palette",
    ]);
    await registry.close();
    expect(commandRegistry.hasCommand("pane")).toBe(false);
    expect(commandRegistry.hasCommand("unpane")).toBe(false);
    expect(commandRegistry.registeredPaletteActions()).toEqual([]);
});
