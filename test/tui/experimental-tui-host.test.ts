import { expect, test } from "bun:test";
import { BoxRenderable, createCliRenderer, TextRenderable } from "@opentui/core";

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

test("experimental TUI host respects key passthrough and non-modal overlays", async () => {
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
    });
    const host = createTuiExperimentalHost({
        renderer,
        theme: VERA_TUI_THEME,
        workspace: () => "/workspace",
        transcript: () => [],
        onFailure() {},
        onRenderRequested() {},
    });
    try {
        host.adapter.mount("fixture", {
            id: "panel",
            slot: "transcript-bottom",
            focusable: true,
            render: () => ({ kind: "text", text: "panel" }),
            onKey: () => false,
        });
        host.adapter.mount("fixture", {
            id: "notice",
            slot: "overlay",
            modal: false,
            render: () => ({ kind: "text", text: "notice" }),
        });

        host.render();
        host.focus();
        expect(host.hasModal()).toBe(false);
        expect(host.handleKey({
            name: "x",
            ctrl: false,
            shift: false,
            meta: false,
        })).toBe(false);
    } finally {
        await host.close();
        renderer.destroy();
    }
});

test("experimental TUI host mounts and disposes extension-owned renderables", async () => {
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
    });
    let requested = 0;
    let adornmentVisible = true;
    const host = createTuiExperimentalHost({
        renderer,
        theme: VERA_TUI_THEME,
        workspace: () => "/workspace",
        transcript: () => [],
        onFailure() {},
        onRenderRequested() { requested += 1; },
    });
    try {
        const dispose = host.adapter.mountRenderable("fixture", {
            id: "raw-footer",
            slot: "footer",
            create(context) {
                expect(context.renderer).toBe(renderer);
                return new TextRenderable(context.renderer, {
                    id: "raw-footer-text",
                    content: "extension-owned",
                    height: 1,
                });
            },
        });
        const disposeSecond = host.adapter.mountRenderable("other", {
            id: "raw-footer",
            slot: "footer",
            create(context) {
                return new TextRenderable(context.renderer, {
                    id: "raw-footer-text",
                    content: "same local renderable id",
                    height: 1,
                });
            },
        });
        const disposeAdornment = host.adapter.mountRenderable("fixture", {
            id: "raw-adornment",
            slot: "composer-adornment",
            visible: () => adornmentVisible,
            create(context) {
                const stack = new BoxRenderable(context.renderer, {
                    id: "raw-adornment-stack",
                    flexDirection: "column",
                });
                stack.add(new TextRenderable(context.renderer, {
                    id: "raw-adornment-first",
                    content: "composer context",
                    height: 1,
                }));
                stack.add(new TextRenderable(context.renderer, {
                    id: "raw-adornment-second",
                    content: "more context",
                    height: 1,
                }));
                return stack;
            },
        });

        host.render();
        expect(host.footer.getChildren()).toHaveLength(2);
        expect(host.bottomInsetRows()).toBe(4);
        expect(requested).toBeGreaterThan(0);
        await dispose();
        expect(host.footer.getChildren()).toHaveLength(1);
        host.render();
        expect(host.bottomInsetRows()).toBe(3);
        adornmentVisible = false;
        host.render();
        expect(host.composerAdornment.visible).toBe(false);
        expect(host.bottomInsetRows()).toBe(1);
        await disposeSecond();
        expect(host.footer.getChildren()).toHaveLength(0);
        await disposeAdornment();
        host.render();
        expect(host.bottomInsetRows()).toBe(0);
    } finally {
        await host.close();
        renderer.destroy();
    }
});

test("experimental TUI host cleans transcript renderables on conversation changes", async () => {
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
    });
    const added: string[] = [];
    const removed: string[] = [];
    const resized: number[] = [];
    const host = createTuiExperimentalHost({
        renderer,
        theme: VERA_TUI_THEME,
        workspace: () => "/workspace",
        transcript: () => [],
        onFailure() {},
        onRenderRequested() {},
        appendTranscriptRenderable(node) {
            added.push(node.id);
            return async () => { removed.push(node.id); };
        },
    });
    try {
        const dispose = host.adapter.appendTranscriptRenderable!("fixture", {
            id: "context-report",
            create(context) {
                return new TextRenderable(context.renderer, {
                    id: "context-report-root",
                    content: "context",
                    height: 1,
                });
            },
            onResize(width) {
                resized.push(width);
            },
        });
        expect(added).toEqual(["context-report-root"]);
        host.render();
        expect(resized).toEqual([]);
        host.conversationChanged();
        await Promise.resolve();
        expect(removed).toEqual(["context-report-root"]);
        await dispose();
        expect(removed).toEqual(["context-report-root"]);
    } finally {
        await host.close();
        renderer.destroy();
    }
});

test("experimental TUI host fails closed when native transcript wiring is absent", async () => {
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
    });
    const host = createTuiExperimentalHost({
        renderer,
        theme: VERA_TUI_THEME,
        workspace: () => "/workspace",
        transcript: () => [],
        onFailure() {},
        onRenderRequested() {},
    });
    try {
        expect(() => host.adapter.appendTranscriptRenderable!("fixture", {
            id: "context-report",
            create(context) {
                return new TextRenderable(context.renderer, {
                    id: "context-report-root",
                    content: "context",
                    height: 1,
                });
            },
        })).toThrow("Native transcript renderables are unavailable");
    } finally {
        await host.close();
        renderer.destroy();
    }
});

test("experimental TUI host isolates raw visibility failures", async () => {
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
        onFailure(extensionId, message) {
            failures.push(`${extensionId}:${message}`);
        },
        onRenderRequested() {},
    });
    try {
        host.adapter.mountRenderable("broken", {
            id: "raw-view",
            slot: "footer",
            visible: () => {
                throw new Error("raw visibility failed");
            },
            create(context) {
                return new TextRenderable(context.renderer, {
                    id: "raw-view-text",
                    content: "raw",
                    height: 1,
                });
            },
        });
        host.render();
        expect(host.footer.visible).toBe(false);
        expect(failures).toEqual(["broken:raw visibility failed"]);
    } finally {
        await host.close();
        renderer.destroy();
    }
});

test("experimental TUI host attributes async listener failures", async () => {
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
        onFailure(extensionId, message) {
            failures.push(`${extensionId}:${message}`);
        },
        onRenderRequested() {},
    });
    try {
        host.adapter.events.on("broken-extension", "agent_event", async () => {
            throw new Error("listener failed");
        });
        host.agentEvent({ type: "turn_finished" });
        await Promise.resolve();
        await Promise.resolve();
        expect(failures).toEqual([
            "broken-extension:listener failed",
        ]);
    } finally {
        await host.close();
        renderer.destroy();
    }
});

test("experimental TUI host shows raw modal overlays", async () => {
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
    });
    const host = createTuiExperimentalHost({
        renderer,
        theme: VERA_TUI_THEME,
        workspace: () => "/workspace",
        transcript: () => [],
        onFailure() {},
        onRenderRequested() {},
    });
    try {
        host.adapter.mountRenderable("fixture", {
            id: "raw-modal",
            slot: "overlay",
            modal: true,
            create(context) {
                return new TextRenderable(context.renderer, {
                    id: "raw-modal-text",
                    content: "modal",
                    height: 1,
                });
            },
        });
        host.render();
        expect(host.overlay.visible).toBe(true);
        expect(host.hasModal()).toBe(true);
    } finally {
        await host.close();
        renderer.destroy();
    }
});

test("experimental TUI host finishes cleanup after raw destroy throws", async () => {
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
    });
    const failures: string[] = [];
    let nestedChildDestroyed = false;
    const host = createTuiExperimentalHost({
        renderer,
        theme: VERA_TUI_THEME,
        workspace: () => "/workspace",
        transcript: () => [],
        onFailure(extensionId, message) {
            failures.push(`${extensionId}:${message}`);
        },
        onRenderRequested() {},
    });
    host.adapter.mountRenderable("broken", {
        id: "broken-destroy",
        slot: "footer",
        create(context) {
            const root = new TextRenderable(context.renderer, {
                id: "broken-destroy-text",
                content: "broken",
                height: 1,
            });
            Object.defineProperty(root, "destroy", {
                value: () => { throw new Error("destroy failed"); },
            });
            return root;
        },
    });
    host.adapter.mountRenderable("healthy", {
        id: "healthy-destroy",
        slot: "footer",
        create(context) {
            const root = new BoxRenderable(context.renderer, {
                id: "healthy-destroy-root",
            });
            const child = new TextRenderable(context.renderer, {
                id: "healthy-destroy-child",
                content: "healthy",
                height: 1,
            });
            const destroy = child.destroy.bind(child);
            Object.defineProperty(child, "destroy", {
                value: () => {
                    nestedChildDestroyed = true;
                    destroy();
                },
            });
            root.add(child);
            return root;
        },
    });

    await expect(host.close()).resolves.toBeUndefined();
    expect(nestedChildDestroyed).toBe(true);
    expect(failures).toEqual(["broken:destroy failed"]);
    renderer.destroy();
});
