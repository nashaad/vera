import { expect, test } from "bun:test";
import { BoxRenderable, Renderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { addTranscriptEntryNode, applyTranscriptScrollAnchor, captureTranscriptScrollAnchor } from "../../clients/tui/main/transcript-nodes.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import type { TuiTranscriptEntry } from "../../clients/tui/state.ts";

const WIDTH = 40;
const HEIGHT = 12;

interface FakeTranscript {
    readonly rt: TuiRuntime;
    readonly close: () => void;
}

async function fakeTranscript(firstIndex: number, lastIndex: number, rowsAbove: number): Promise<FakeTranscript> {
    const setup = await createTestRenderer({ width: WIDTH, height: HEIGHT });
    const transcript = new ScrollBoxRenderable(setup.renderer, {
        id: "transcript",
        width: WIDTH,
        height: HEIGHT,
        stickyScroll: true,
        stickyStart: "bottom",
        contentOptions: { flexDirection: "column", gap: 0 },
    });
    const top = new BoxRenderable(setup.renderer, { id: "top-spacer", width: "100%", height: rowsAbove, flexShrink: 0 });
    const bottom = new BoxRenderable(setup.renderer, { id: "bottom-spacer", width: "100%", height: 0, visible: false, flexShrink: 0 });
    const anchorSpacer = new BoxRenderable(setup.renderer, { id: "anchor-spacer", width: "100%", height: 0, visible: false, flexShrink: 0 });
    transcript.add(top);
    transcript.add(bottom);
    transcript.add(anchorSpacer);
    setup.renderer.root.add(transcript);

    const entries: TuiTranscriptEntry[] = Array.from({ length: lastIndex }, (_, index) => ({
        kind: "assistant",
        text: `row ${index}`,
    }));
    const rt = {
        renderer: setup.renderer,
        transcript,
        transcriptWindowTopSpacer: top,
        transcriptWindowBottomSpacer: bottom,
        transcriptAnchorSpacer: anchorSpacer,
        transcriptAnchorPadding: 0,
        transcriptResizeAnchor: undefined,
        pendingTranscriptScrollAnchor: undefined,
        entryNodes: [],
        entryNodeKinds: [],
        materializedEntryStart: firstIndex,
        materializedEntryEnd: firstIndex,
        state: { entries },
    } as unknown as TuiRuntime;

    for (let index = firstIndex; index < lastIndex; index += 1) {
        addRow(rt, index);
    }
    rt.materializedEntryEnd = lastIndex;
    return { rt, close: () => setup.renderer.destroy() };
}

function addRow(rt: TuiRuntime, index: number): TextRenderable {
    const node = new TextRenderable(rt.renderer, {
        id: `entry-${index}`,
        content: `row ${index}`,
        width: "100%",
        flexShrink: 0,
    });
    rt.entryNodes[index] = node;
    rt.entryNodeKinds[index] = "assistant";
    addTranscriptEntryNode(rt, node, index);
    return node;
}

async function paint(rt: TuiRuntime): Promise<void> {
    await (rt.renderer as unknown as { loop(): Promise<void> }).loop();
}

function contentChildIds(rt: TuiRuntime): string[] {
    return rt.transcript.content.getChildren().map((child: Renderable) => child.id);
}

test("entries are direct scroll children, between the spacers", async () => {
    const fake = await fakeTranscript(3, 6, 10);
    try {
        fake.rt.materializedEntryStart = 0;
        for (const index of [0, 1, 2]) addRow(fake.rt, index);
        expect(contentChildIds(fake.rt)).toEqual([
            "top-spacer",
            "entry-0",
            "entry-1",
            "entry-2",
            "entry-3",
            "entry-4",
            "entry-5",
            "bottom-spacer",
            "anchor-spacer",
        ]);
    } finally {
        fake.close();
    }
});

test("only entries near the viewport reach the frame", async () => {
    const fake = await fakeTranscript(200, 400, 2);
    const proto = Renderable.prototype as unknown as {
        updateLayout: (...args: unknown[]) => unknown;
    };
    const original = proto.updateLayout;
    const visited = new Set<string>();
    proto.updateLayout = function (this: unknown, ...args: unknown[]) {
        const id = (this as { id?: string }).id;
        if (id?.startsWith("entry-")) visited.add(id);
        return original.apply(this, args);
    };
    try {
        fake.rt.transcript.stickyScroll = false;
        fake.rt.transcript.scrollTo(0);
        await paint(fake.rt);
        visited.clear();
        fake.rt.renderer.requestRender();
        await paint(fake.rt);
        expect(visited.size).toBeGreaterThan(2);
        expect(visited.size).toBeLessThan(HEIGHT + 25);
        expect(visited.has("entry-200")).toBe(true);
        expect(visited.has("entry-399")).toBe(false);
    } finally {
        proto.updateLayout = original;
        fake.close();
    }
});

test("an anchored row keeps its screen row when earlier entries are trimmed in", async () => {
    const fake = await fakeTranscript(60, 120, 300);
    try {
        await paint(fake.rt);
        fake.rt.transcript.stickyScroll = false;
        fake.rt.transcript.scrollTo(330);
        await paint(fake.rt);
        captureTranscriptScrollAnchor(fake.rt);
        const anchor = fake.rt.pendingTranscriptScrollAnchor;
        expect(anchor).toBeDefined();
        const anchoredNode = fake.rt.entryNodes[anchor!.index]!;
        const before = anchoredNode.screenY;

        // Ten rows arrive above the view, so every materialized row moves ten
        // rows down the scroll height before the anchor is applied.
        fake.rt.materializedEntryStart = 50;
        for (let index = 50; index < 60; index += 1) addRow(fake.rt, index);
        await paint(fake.rt);
        applyTranscriptScrollAnchor(fake.rt);
        await paint(fake.rt);
        expect(anchoredNode.screenY).toBe(before);
    } finally {
        fake.close();
    }
});
