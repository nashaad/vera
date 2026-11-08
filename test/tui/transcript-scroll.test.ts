import { expect, test } from "bun:test";
import { BoxRenderable, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { settleTranscriptScrollState, snapTranscriptWindowToTail } from "../../clients/tui/main/transcript-nodes.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";
import { tuiTranscriptAtBottom } from "../../clients/tui/transcript-scroll.ts";

test("the transcript treats the last visible row as the bottom", () => {
    expect(tuiTranscriptAtBottom(49, 100, 50)).toBe(true);
    expect(tuiTranscriptAtBottom(48, 100, 50)).toBe(false);
});

test("a transcript shorter than its viewport is already at the bottom", () => {
    expect(tuiTranscriptAtBottom(0, 20, 50)).toBe(true);
});

test("scrolled fully up is never the bottom, however short the range", () => {
    expect(tuiTranscriptAtBottom(0, 51, 50)).toBe(false);
    expect(tuiTranscriptAtBottom(1, 51, 50)).toBe(true);
});

test("following the tail removes resize space beneath the working row", async () => {
    const setup = await createTestRenderer({ width: 60, height: 10 });
    const transcript = new ScrollBoxRenderable(setup.renderer, {
        width: 60,
        height: 10,
        stickyScroll: true,
        stickyStart: "bottom",
    });
    const history = new TextRenderable(setup.renderer, {
        content: Array.from({ length: 30 }, (_, index) => `log ${index}`).join("\n"),
        width: "100%",
        flexShrink: 0,
    });
    const working = new TextRenderable(setup.renderer, {
        content: "Working",
        width: "100%",
        height: 1,
        flexShrink: 0,
    });
    const spacer = new BoxRenderable(setup.renderer, { height: 6, width: "100%", flexShrink: 0 });
    transcript.add(history);
    transcript.add(working);
    transcript.add(spacer);
    setup.renderer.root.add(transcript);
    const rt = {
        renderer: setup.renderer,
        sidebar: { isShown: () => false },
        transcript,
        transcriptAnchorPadding: 6,
        transcriptAnchorSpacer: spacer,
        pendingTranscriptAnchorPaddingClear: false,
        transcriptWindowTopSpacer: new BoxRenderable(setup.renderer, { height: 0 }),
        transcriptWindowBottomSpacer: new BoxRenderable(setup.renderer, { height: 0 }),
        materializedEntryStart: 0,
        materializedEntryEnd: 0,
        entryNodes: [],
        measuredEntryRows: [],
        measuredEntryRowsWidth: 0,
    } as unknown as TuiRuntime;
    try {
        await setup.renderOnce();
        transcript.scrollTo(transcript.scrollHeight);
        await setup.renderOnce();
        expect(transcript.viewport.screenY + transcript.viewport.height - working.screenY).toBe(7);

        snapTranscriptWindowToTail(rt, []);
        await setup.renderOnce();
        settleTranscriptScrollState(rt);
        await setup.renderOnce();
        expect(rt.transcriptAnchorPadding).toBe(0);
        expect(spacer.visible).toBe(false);
        expect(transcript.viewport.screenY + transcript.viewport.height - working.screenY).toBe(1);

        rt.transcriptAnchorPadding = 6;
        spacer.height = 6;
        spacer.visible = true;
        await setup.renderOnce();
        transcript.scrollTo(transcript.scrollHeight);
        await setup.renderOnce();
        rt.pendingTranscriptScrollRestore = { scrollTop: 0, atBottom: true };
        settleTranscriptScrollState(rt);
        await setup.renderOnce();
        expect(spacer.visible).toBe(false);
        expect(transcript.viewport.screenY + transcript.viewport.height - working.screenY).toBe(1);
    } finally {
        setup.renderer.destroy();
        rt.transcriptWindowTopSpacer.destroy();
        rt.transcriptWindowBottomSpacer.destroy();
    }
});
