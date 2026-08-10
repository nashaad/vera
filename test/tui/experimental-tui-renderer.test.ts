import { expect, test } from "bun:test";

import { validateTuiExperimentalNode } from "../../clients/tui/experimental-tui-renderer.ts";

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
