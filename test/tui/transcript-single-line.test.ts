import { expect, test } from "bun:test";
import { ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createHistoryPaging } from "../../clients/tui/history-paging-state.ts";
import { applyTranscriptScroll } from "../../clients/tui/main/keypress.ts";
import { renderJumpToBottom } from "../../clients/tui/main/notices.ts";
import type { TuiRuntime } from "../../clients/tui/main/runtime.ts";

test("a single upward line leaves follow until scrolling down", async () => {
    const setup = await createTestRenderer({ width: 60, height: 10 });
    const transcript = new ScrollBoxRenderable(setup.renderer, {
        width: 60, height: 10, stickyScroll: true, stickyStart: "bottom",
    });
    transcript.add(new TextRenderable(setup.renderer, {
        width: "100%", flexShrink: 0,
        content: Array.from({ length: 50 }, (_, index) => `line ${index}`).join("\n"),
    }));
    setup.renderer.root.add(transcript);
    const rt = {
        transcript,
        state: { entries: [] },
        transcriptAnchorPadding: 0,
        historyPaging: createHistoryPaging(),
        experimentalTuiHost: { hasModal: () => false },
        sidebar: { isFocused: () => false },
        jumpToBottom: { visible: false },
        commandSuggestionsBox: { visible: false },
        JUMP_TO_BOTTOM_LABEL: "Jump to bottom",
    } as unknown as TuiRuntime;
    try {
        await setup.renderOnce();
        transcript.scrollTo(transcript.scrollHeight);
        await setup.renderOnce();
        const bottom = transcript.scrollTop;
        applyTranscriptScroll(rt, "scroll_line_up");
        expect(transcript.scrollTop).toBe(bottom - 1);
        expect(rt.jumpToBottom.visible).toBe(true);
        renderJumpToBottom(rt);
        await setup.renderOnce();
        expect(transcript.scrollTop).toBe(bottom - 1);
        applyTranscriptScroll(rt, "scroll_line_down");
        expect(rt.jumpToBottom.visible).toBe(false);
        expect(transcript.scrollTop).toBe(bottom);

        applyTranscriptScroll(rt, "scroll_line_up");
        applyTranscriptScroll(rt, "scroll_line_up");
        expect(transcript.scrollTop).toBe(bottom - 2);
        applyTranscriptScroll(rt, "scroll_line_down");
        expect(rt.jumpToBottom.visible).toBe(false);
        expect(transcript.scrollTop).toBe(bottom);
    } finally {
        setup.renderer.destroy();
    }
});
