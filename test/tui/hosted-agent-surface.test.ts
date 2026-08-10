import { describe, expect, test } from "bun:test";
import { createTuiHostedAgentSurface } from "../../clients/tui/hosted-agent-surface.ts";

describe("hosted agent surface", () => {
    test("reports only the owning extension's visible surface", () => {
        let layout: "split" | "main" | "sidebar" = "sidebar";
        const surface = createTuiHostedAgentSurface({
            owner: () => "vera.btw",
            hasAgent: () => true,
            layout: () => layout,
            isFocused: () => true,
            cycleSidebarLayout: () => {},
            setSidebarFocused: () => {},
            focusComposer: () => {},
            renderState: () => {},
            renderStatus: () => {},
            requestRender: () => {},
        });

        expect(surface.current("another.extension")).toBeUndefined();
        expect(surface.current("vera.btw")).toEqual({
            layout: "secondary",
            focused: "secondary",
        });
        layout = "main";
        expect(surface.current("vera.btw")?.layout).toBe("primary");
    });

    test("cycles layout and refreshes the client", () => {
        const calls: string[] = [];
        const surface = createTuiHostedAgentSurface({
            owner: () => "vera.btw",
            hasAgent: () => true,
            layout: () => "split",
            isFocused: () => false,
            cycleSidebarLayout: () => calls.push("cycle"),
            setSidebarFocused: () => calls.push("focus"),
            focusComposer: () => calls.push("composer"),
            renderState: () => calls.push("state"),
            renderStatus: () => calls.push("status"),
            requestRender: () => calls.push("render"),
        });

        expect(surface.cycleLayout("another.extension")).toBe(false);
        expect(surface.cycleLayout("vera.btw")).toBe(true);
        expect(calls).toEqual([
            "cycle",
            "composer",
            "state",
            "status",
            "render",
        ]);
    });

    test("toggles focus only in a split layout", () => {
        let layout: "split" | "main" | "sidebar" = "main";
        let focused = false;
        const surface = createTuiHostedAgentSurface({
            owner: () => "vera.btw",
            hasAgent: () => true,
            layout: () => layout,
            isFocused: () => focused,
            cycleSidebarLayout: () => {},
            setSidebarFocused: (next) => {
                focused = next;
            },
            focusComposer: () => {},
            renderState: () => {},
            renderStatus: () => {},
            requestRender: () => {},
        });

        expect(surface.toggleFocus("vera.btw")).toBe(false);
        layout = "split";
        expect(surface.toggleFocus("vera.btw")).toBe(true);
        expect(focused).toBe(true);
    });
});
