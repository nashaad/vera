import { expect, test } from "bun:test";
import { BoxRenderable, SyntaxStyle, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { TuiAgentPaneState } from "../../clients/tui/agent-pane-state.ts";
import { DEFAULT_TUI_APPEARANCE } from "../../clients/tui/appearance.ts";
import { destroySidebarTranscript, renderSidebarTranscript } from "../../clients/tui/main/sidebar-transcript.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import { createTuiSidebar } from "../../clients/tui/sidebar.ts";
import { createTuiState } from "../../clients/tui/state.ts";

const style = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } });

test("an owner extension's clearSidebar and appendSidebar do not strand the side transcript", async () => {
    const setup = await createTestRenderer({ width: 120, height: 20 });
    const sidebar = createTuiSidebar({
        renderer: setup.renderer,
        transcript: new BoxRenderable(setup.renderer, { flexGrow: 1 }),
        theme: { handle: "#333333", handleActive: "#666666", muted: "#888888", text: "#ffffff", focus: "#22c55e", inactive: "#4b5563" },
        syntaxStyle: style,
    });
    const paneState = new TuiAgentPaneState();
    paneState.apply({
        type: "history", seq: 1,
        entries: Array.from({ length: 100 }, (_, index) => ({
            kind: "user" as const,
            id: `id-${index}`,
            text: `crow ${index}`,
        })),
    });
    const pane = { state: paneState, client: { agentId: "side" } };
    const rt = {
        renderer: setup.renderer, sidebar, hostedSidebar: { pane },
        appearance: DEFAULT_TUI_APPEARANCE, entrySpacing: { message: 1, toolGroup: 0 },
        theme: { element: "#333333" }, markdownStyle: style,
        state: createTuiState(), entryNodes: [],
    } as unknown as TuiRuntime;
    setup.renderer.root.add(sidebar.body);
    sidebar.open();
    try {
        renderSidebarTranscript(rt, pane as never, false);
        await setup.renderOnce();
        expect(rt.sidebarEntryNodes.filter(Boolean).length).toBeGreaterThan(0);

        // The calls the extension surface makes: clearSidebar then appendSidebar.
        sidebar.clear();
        sidebar.append("extension", "extension note");
        expect(sidebar.content.getChildren().some((child) => child.id.startsWith("sidebar-block-"))).toBe(true);

        // The sidebar update that follows must restore the transcript.
        renderSidebarTranscript(rt, pane as never, false);
        await setup.renderOnce();
        await setup.renderOnce();

        const children: Renderable[] = sidebar.content.getChildren();
        const entries: Renderable[] = [];
        for (let index = 0; index < paneState.state.entries.length; index += 1) {
            const node = rt.sidebarEntryNodes[index];
            if (node !== undefined) entries.push(node);
        }
        expect(entries.length).toBeGreaterThan(0);
        expect(children[0]?.id).toBe("sidebar-transcript-top");
        expect(children[children.length - 1]?.id).toBe("sidebar-transcript-bottom");
        expect(children.length).toBe(entries.length + 2);
        for (let index = 0; index < entries.length; index += 1) {
            expect(children[index + 1]).toBe(entries[index]);
        }
        expect(children.some((child) => child.id.startsWith("sidebar-block-"))).toBe(false);
        expect(sidebar.blocks().length).toBe(entries.length);
        expect(sidebar.blocks().every((block) => block.speaker === "you")).toBe(true);

        const frame = setup.captureCharFrame();
        expect(frame).toContain("crow 99");
        expect(frame).not.toContain("extension note");
    } finally {
        destroySidebarTranscript(rt);
        setup.renderer.destroy();
    }
});
