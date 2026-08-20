import { expect, test } from "bun:test";

import { createTestRenderer } from "@opentui/core/testing";

import {
    renderTuiExperimentalView,
    validateTuiExperimentalNode,
} from "../../clients/tui/experimental-tui-renderer.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";

test("experimental TUI renderer accepts bounded declarative trees", () => {
    expect(() => validateTuiExperimentalNode({
        kind: "stack",
        direction: "column",
        gap: 2,
        children: [
            { kind: "text", text: "status", tone: "muted" },
            { kind: "rule" },
            { kind: "button", label: "Open", action: "open" },
        ],
    })).not.toThrow();
});

test("experimental TUI renderer rejects oversized or malformed trees", () => {
    expect(() => validateTuiExperimentalNode({
        kind: "text",
        text: "x".repeat(8_001),
    })).toThrow("text is invalid or too long");
    expect(() => validateTuiExperimentalNode({
        kind: "stack",
        direction: "column",
        gap: 9,
        children: [],
    })).toThrow("stack is invalid");
    expect(() => validateTuiExperimentalNode({
        kind: "button",
        label: "",
        action: "open",
    })).toThrow("button is invalid");
});

test("experimental TUI views are draggable text, except their rules", async () => {
    const setup = await createTestRenderer({ width: 40, height: 8 });
    const root = renderTuiExperimentalView({
        renderer: setup.renderer,
        theme: VERA_TUI_THEME,
        node: {
            kind: "stack",
            direction: "column",
            children: [
                { kind: "text", text: "one" },
                { kind: "rule" },
                { kind: "text", text: "two" },
            ],
        },
        id: "selectable-view",
        overlay: true,
        focus() {},
        triggerAction() {},
    });
    setup.renderer.root.add(root);
    try {
        await setup.flush();
        const selectable = new Map<string, boolean>();
        const walk = (node: { id: string; selectable?: boolean; getChildren?: () => unknown[] }): void => {
            selectable.set(node.id, node.selectable === true);
            for (const child of node.getChildren?.() ?? []) {
                walk(child as Parameters<typeof walk>[0]);
            }
        };
        walk(root as unknown as Parameters<typeof walk>[0]);
        expect(selectable.get("selectable-view-content-0")).toBe(true);
        expect(selectable.get("selectable-view-content-1")).toBe(false);
        expect(selectable.get("selectable-view-content-2")).toBe(true);
    } finally {
        setup.renderer.destroy();
    }
});

test("experimental TUI overlay title carries a client notice", async () => {
    const setup = await createTestRenderer({ width: 60, height: 6 });
    const root = renderTuiExperimentalView({
        renderer: setup.renderer,
        theme: VERA_TUI_THEME,
        node: { kind: "text", text: "body" },
        id: "notice-view",
        overlay: true,
        title: "Vera dashboard",
        notice: "copied 12 characters",
        focus() {},
        triggerAction() {},
    });
    setup.renderer.root.add(root);
    try {
        await setup.flush();
        expect(setup.captureCharFrame()).toContain(
            "Vera dashboard · copied 12 characters",
        );
    } finally {
        setup.renderer.destroy();
    }
});
