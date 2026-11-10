import { expect, test } from "bun:test";
import { BoxRenderable, SyntaxStyle } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { TuiAgentPaneState } from "../../clients/tui/agent-pane-state.ts";
import { DEFAULT_TUI_APPEARANCE } from "../../clients/tui/appearance.ts";
import { destroySidebarTranscript, jumpSidebarToBottom, renderSidebarTranscript } from "../../clients/tui/main/sidebar-transcript.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import { createTuiSidebar } from "../../clients/tui/sidebar.ts";
import { createTuiState } from "../../clients/tui/state.ts";

const style = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } });

test("the side transcript windows nodes and retains selection speakers", async () => {
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
        entries: Array.from({ length: 100 }, (_, index) => ({ kind: "user" as const, id: `id-${index}`, text: `crow ${index}` })),
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
        expect(rt.sidebarEntryNodes.filter(Boolean).length).toBeLessThanOrEqual(48);
        expect(sidebar.blocks().length).toBeGreaterThan(0);
        expect(sidebar.blocks().every((block) => block.speaker === "you")).toBe(true);
        expect(paneState.state.entries.length).toBe(100);
    } finally {
        destroySidebarTranscript(rt);
        setup.renderer.destroy();
    }
});

test("a side prepend keeps the visible entry in place", async () => {
    const setup = await createTestRenderer({ width: 120, height: 20 });
    const sidebar = createTuiSidebar({
        renderer: setup.renderer,
        transcript: new BoxRenderable(setup.renderer, { flexGrow: 1 }),
        theme: { handle: "#333333", handleActive: "#666666", muted: "#888888", text: "#ffffff", focus: "#22c55e", inactive: "#4b5563" },
        syntaxStyle: style,
    });
    const paneState = new TuiAgentPaneState();
    const entries = Array.from({ length: 60 }, (_, index) => ({ kind: "user" as const, id: `id-${index}`, text: `crow ${index}` }));
    paneState.apply({ type: "history", seq: 1, entries, page: { pageVersion: 1, hasMore: true, olderBefore: "id-0" } });
    const answer = Promise.withResolvers<import("../../src/host/protocol.ts").HistoryPageResponse>();
    let calls = 0;
    const pane = { state: paneState, client: {
        agentId: "side", supportsHostCapability: () => true,
        requestHistoryPage: () => { calls += 1; return answer.promise; },
    } };
    const rt = {
        renderer: setup.renderer, sidebar, hostedSidebar: { pane },
        appearance: DEFAULT_TUI_APPEARANCE, entrySpacing: { message: 1, toolGroup: 0 },
        theme: { element: "#333333" }, markdownStyle: style,
        state: createTuiState(), entryNodes: [], renderCoalescer: { request: () => undefined },
    } as unknown as TuiRuntime;
    setup.renderer.root.add(sidebar.body);
    sidebar.open();
    try {
        renderSidebarTranscript(rt, pane as never, false);
        await setup.renderOnce();
        sidebar.content.scrollTo(20);
        await setup.renderOnce();
        await setup.renderOnce();
        expect(calls).toBe(1);
        const visible = rt.sidebarEntryNodes.findIndex((node) => node !== undefined && node.visible && node.screenY >= sidebar.content.viewport.screenY);
        const id = paneState.state.entries[visible]?.entryId;
        const before = rt.sidebarEntryNodes[visible]?.screenY;
        expect(id).toBeDefined();
        answer.resolve({
            type: "history_page", request_id: "page", before: "id-0",
            entries: [{ kind: "user", id: "older", text: "older crow" }],
            page: { pageVersion: 1, hasMore: false },
        });
        await answer.promise;
        await Promise.resolve();
        await setup.renderOnce();
        await setup.renderOnce();
        const next = paneState.state.entries.findIndex((entry) => entry.entryId === id);
        expect(rt.sidebarEntryNodes[next]?.screenY).toBe(before);
        expect(calls).toBe(1);
    } finally {
        destroySidebarTranscript(rt);
        setup.renderer.destroy();
    }
});

test("a side jump from the first entry snaps the window to the tail", async () => {
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
        entries: Array.from({ length: 1000 }, (_, index) => ({ kind: "user" as const, id: `id-${index}`, text: `crow ${index}` })),
    });
    const pane = { state: paneState, client: { agentId: "side" } };
    const rt = {
        renderer: setup.renderer, sidebar, hostedSidebar: { pane },
        appearance: DEFAULT_TUI_APPEARANCE, entrySpacing: { message: 1, toolGroup: 0 },
        theme: { element: "#333333" }, markdownStyle: style,
        state: createTuiState(), entryNodes: [], renderCoalescer: { request: () => undefined },
    } as unknown as TuiRuntime;
    setup.renderer.root.add(sidebar.body);
    sidebar.open();
    try {
        renderSidebarTranscript(rt, pane as never, false);
        await setup.renderOnce();
        sidebar.content.stickyScroll = false;
        const atFirstEntry = () => rt.sidebarEntryNodes[0] !== undefined && sidebar.content.scrollTop === 0;
        for (let frame = 0; frame < 400 && !atFirstEntry(); frame += 1) {
            sidebar.content.scrollBy(-40);
            await setup.renderOnce();
        }
        // Booleans only: a failed expect on a renderable can stall while it is printed.
        expect(atFirstEntry()).toBe(true);
        expect(rt.sidebarEntryNodes[999] === undefined).toBe(true);

        jumpSidebarToBottom(rt);
        await setup.renderOnce();
        await setup.renderOnce();
        expect(rt.sidebarEntryNodes[999]?.visible === true).toBe(true);
        expect(rt.sidebarEntryNodes.filter(Boolean).length).toBeLessThanOrEqual(48);
        expect(sidebar.isFollowing()).toBe(true);
    } finally {
        destroySidebarTranscript(rt);
        setup.renderer.destroy();
    }
});
