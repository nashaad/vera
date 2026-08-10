import { expect, test } from "bun:test";
import { join } from "node:path";

import {
    configuredTuiClientExtensions,
    startTuiClientExtensionHost,
} from "../../clients/tui/client-extension-host.ts";

const DISABLED_BUILTINS = [
    "vera.model-presets",
    "vera.reasoning-cycle",
] as const;

test("the TUI extension host binds a configured extension to client surfaces", async () => {
    const sidebar: string[] = [];
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
        [extension],
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
        postNotice: () => {},
        reservedCommandNames: [],
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
    await registry.close();
});
