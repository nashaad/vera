import { expect, test } from "bun:test";
import { createCliRenderer } from "@opentui/core";

import { createTuiExperimentalHost } from "../../clients/tui/experimental-tui-host.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";

test("experimental TUI host mounts trees, scopes focus, opens overlays, and cleans up", async () => {
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
    });
    const failures: string[] = [];
    let requests = 0;
    let overlayOpen = false;
    let count = 0;
    const host = createTuiExperimentalHost({
        renderer,
        theme: VERA_TUI_THEME,
        workspace: () => "/workspace",
        transcript: () => [],
        onFailure: (extensionId, message) => {
            failures.push(`${extensionId}:${message}`);
        },
        onRenderRequested: () => {
            requests += 1;
        },
    });
    try {
        const dispose = host.adapter.mount("fixture", {
            id: "panel",
            slot: "transcript-bottom",
            focusable: true,
            render: () => ({
                kind: "stack",
                direction: "column",
                children: [
                    { kind: "text", text: `count ${count}` },
                    { kind: "button", label: "Open", action: "open" },
                ],
            }),
            keybindings: [{ keys: ["ctrl+shift+o"], action: "open" }],
            onAction: (action) => {
                if (action === "open") {
                    count += 1;
                    overlayOpen = true;
                }
            },
        });
        host.adapter.mount("fixture", {
            id: "overlay",
            slot: "overlay",
            modal: true,
            visible: () => overlayOpen,
            render: () => ({
                kind: "button",
                label: "Close",
                action: "close",
            }),
            keybindings: [{ keys: ["escape"], action: "close" }],
            onAction: (action) => {
                if (action === "close") overlayOpen = false;
            },
        });

        host.render();
        expect(host.transcriptBottom.getChildren()).toHaveLength(1);
        host.focus();
        expect(host.hasFocus()).toBe(true);
        expect(host.handleKey({
            name: "o",
            ctrl: true,
            shift: true,
            meta: false,
        })).toBe(true);
        expect(count).toBe(1);
        host.render();
        expect(host.hasModal()).toBe(true);
        expect(host.handleKey({
            name: "escape",
            ctrl: false,
            shift: false,
            meta: false,
        })).toBe(true);
        expect(overlayOpen).toBe(false);
        expect(requests).toBeGreaterThan(0);
        await dispose();
        host.render();
        expect(host.transcriptBottom.getChildren()).toHaveLength(0);
        expect(failures).toEqual([]);
    } finally {
        await host.close();
        renderer.destroy();
    }
});

test("experimental TUI host isolates malformed render trees", async () => {
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
    });
    const failures: string[] = [];
    const host = createTuiExperimentalHost({
        renderer,
        theme: VERA_TUI_THEME,
        workspace: () => "/workspace",
        transcript: () => [],
        onFailure: (extensionId, message) => {
            failures.push(`${extensionId}:${message}`);
        },
        onRenderRequested() {},
    });
    try {
        host.adapter.mount("broken", {
            id: "view",
            slot: "footer",
            render: () => ({ kind: "invalid" } as never),
        });
        expect(() => host.render()).not.toThrow();
        expect(host.footer.getChildren()).toHaveLength(0);
        expect(failures[0]).toContain("broken:");
    } finally {
        await host.close();
        renderer.destroy();
    }
});
