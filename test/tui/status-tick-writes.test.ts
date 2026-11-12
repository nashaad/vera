import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { createTuiKeysCardView } from "../../clients/tui/keys-card.ts";
import { createTuiThinkingWindow, animateTuiThinkingWindow } from "../../clients/tui/thinking-window.ts";
import { updateLinesViewIfChanged, type LinesView, type LinesViewState } from "../../clients/tui/lines-view.ts";
import type { TuiTextTranscriptEntry } from "../../clients/tui/state.ts";

const STATE: LinesViewState = { title: "Work", lines: [], footer: "esc" };

function countingRenderer(renderer: { requestRender: () => void }): () => number {
    let count = 0;
    const original = renderer.requestRender.bind(renderer);
    renderer.requestRender = () => {
        count += 1;
        original();
    };
    return () => count;
}

test("an unchanged lines state does not rebuild the view", () => {
    let updates = 0;
    let width = 40;
    const view = {
        contentWidth: () => width,
        visibleRows: () => 10,
        update: () => {
            updates += 1;
        },
    } as unknown as LinesView;

    updateLinesViewIfChanged(view, STATE);
    updateLinesViewIfChanged(view, { ...STATE });
    expect(updates).toBe(1);

    width = 60;
    updateLinesViewIfChanged(view, { ...STATE });
    expect(updates).toBe(2);

    updateLinesViewIfChanged(view, { ...STATE, footer: "enter" });
    expect(updates).toBe(3);
});

test("an unchanged keys card update requests no render", async () => {
    const setup = await createTestRenderer({ width: 100, height: 40 });
    const renders = countingRenderer(setup.renderer);
    const view = createTuiKeysCardView(setup.renderer);
    setup.renderer.root.add(view.box);

    view.update("working", 60, 20);
    const first = renders();
    view.update("working", 60, 20);
    expect(first).toBeGreaterThan(0);
    expect(renders()).toBe(first);
    setup.renderer.destroy();
});

test("an unchanged thinking spinner frame requests no render", async () => {
    const setup = await createTestRenderer({ width: 100, height: 40 });
    const entry = { kind: "thinking", text: "considering" } as unknown as TuiTextTranscriptEntry;
    const window = createTuiThinkingWindow(setup.renderer, "thinking-test", entry, 0, 1);
    setup.renderer.root.add(window);
    const renders = countingRenderer(setup.renderer);

    animateTuiThinkingWindow(window, 3);
    const first = renders();
    animateTuiThinkingWindow(window, 3);
    expect(first).toBe(1);
    expect(renders()).toBe(first);
    animateTuiThinkingWindow(window, 4);
    expect(renders()).toBe(2);
    setup.renderer.destroy();
});
