import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
    createTuiModelSwitcherView,
    handleTuiModelSwitcherKey,
    searchedTuiModelSwitcher,
    startTuiModelSwitcher,
} from "../../clients/tui/model-switcher.ts";
import {
    createTuiSettingsPickerView,
    handleTuiSettingsPickerKey,
    startTuiReasoningPicker,
    updateTuiSettingsPickerSearch,
} from "../../clients/tui/settings-picker.ts";

const models = [
    { provider: "demo", model: "alpha-one", label: "Alpha One", favorite: true },
    { provider: "demo", model: "alpha-two", label: "Alpha Two", favorite: true },
] as const;

const levels = [
    { id: "high", label: "High", description: "Deep reasoning" },
    { id: "medium", label: "Medium", description: "Moderate reasoning" },
    { id: "low", label: "Low", description: "Light reasoning" },
] as const;

function markedLine(frame: string): string {
    const marked = frame.split("\n").filter((line) => line.includes("▌"));
    expect(marked).toHaveLength(1);
    return marked[0]!;
}

for (const width of [80, 120]) {
    test(`model search marks the Enter target in plain text at ${width} columns`, async () => {
        const setup = await createTestRenderer({ width, height: width === 80 ? 24 : 40 });
        const view = createTuiModelSwitcherView(setup.renderer);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        try {
            let state = searchedTuiModelSwitcher(
                startTuiModelSwitcher(models, { current: "demo/alpha-two" }),
                "alpha",
            );
            view.update(state);
            await setup.renderOnce();
            let frame = setup.captureCharFrame();
            expect(markedLine(frame)).toMatch(/▌\s+Alpha One\b/);
            expect(frame.split("\n").find((line) => line.includes("Alpha Two"))).toContain("✓");
            expect(handleTuiModelSwitcherKey(state, { name: "return" }).selection?.model)
                .toBe("alpha-one");

            state = handleTuiModelSwitcherKey(state, { name: "down" }).state!;
            view.update(state);
            await setup.renderOnce();
            expect(markedLine(setup.captureCharFrame())).toMatch(/▌\s+Alpha Two\b/);
            expect(handleTuiModelSwitcherKey(state, { name: "return" }).selection?.model)
                .toBe("alpha-two");

            state = handleTuiModelSwitcherKey(state, { name: "up" }).state!;
            view.update(state);
            await setup.renderOnce();
            expect(markedLine(setup.captureCharFrame())).toMatch(/▌\s+Alpha One\b/);

            state = searchedTuiModelSwitcher(state, "no-match");
            view.update(state);
            await setup.renderOnce();
            frame = setup.captureCharFrame();
            expect(frame).toContain("No favorites match");
            expect(frame).not.toContain("▌");
        } finally {
            setup.renderer.destroy();
        }
    });

    test(`model cursor remains visible while scrolling at ${width} columns`, async () => {
        const setup = await createTestRenderer({ width, height: width === 80 ? 24 : 40 });
        const view = createTuiModelSwitcherView(setup.renderer);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        try {
            const rows = Array.from({ length: 20 }, (_, index) => {
                const number = String(index + 1).padStart(2, "0");
                return {
                    provider: "demo",
                    model: `model-${number}`,
                    label: `Model ${number}`,
                    favorite: true,
                };
            });
            let state = searchedTuiModelSwitcher(startTuiModelSwitcher(rows), "model");
            view.update(state);
            await setup.renderOnce();
            for (let index = 0; index < 19; index += 1) {
                state = handleTuiModelSwitcherKey(state, { name: "down" }).state!;
            }
            view.update(state);
            await setup.renderOnce();
            await setup.renderOnce();
            expect(markedLine(setup.captureCharFrame())).toMatch(/▌\s+Model 20\b/);
            expect(handleTuiModelSwitcherKey(state, { name: "return" }).selection?.model)
                .toBe("model-20");
        } finally {
            setup.renderer.destroy();
        }
    });

    test(`reasoning marks its selected level in plain text at ${width} columns`, async () => {
        const setup = await createTestRenderer({ width, height: width === 80 ? 24 : 40 });
        const view = createTuiSettingsPickerView(setup.renderer);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        try {
            let state = startTuiReasoningPicker(levels, "high", "high");
            view.update(state);
            await setup.renderOnce();
            expect(markedLine(setup.captureCharFrame())).toMatch(/▌\s+1\. High\b/);
            expect(handleTuiSettingsPickerKey(state, { name: "return" }).selection)
                .toEqual({ kind: "reasoning", reasoningEffort: "high" });

            state = handleTuiSettingsPickerKey(state, { name: "down" }).state!;
            view.update(state);
            await setup.renderOnce();
            expect(markedLine(setup.captureCharFrame())).toMatch(/▌\s+2\. Medium\b/);
            expect(handleTuiSettingsPickerKey(state, { name: "return" }).selection)
                .toEqual({ kind: "reasoning", reasoningEffort: "medium" });

            state = handleTuiSettingsPickerKey(state, { name: "up" }).state!;
            view.update(state);
            await setup.renderOnce();
            expect(markedLine(setup.captureCharFrame())).toMatch(/▌\s+1\. High\b/);

            state = updateTuiSettingsPickerSearch(state, "low").state!;
            view.update(state);
            await setup.renderOnce();
            expect(markedLine(setup.captureCharFrame())).toMatch(/▌\s+Low\b/);
            expect(handleTuiSettingsPickerKey(state, { name: "return" }).selection)
                .toEqual({ kind: "reasoning", reasoningEffort: "low" });

            state = updateTuiSettingsPickerSearch(state, "no-match").state!;
            view.update(state);
            await setup.renderOnce();
            expect(setup.captureCharFrame()).not.toContain("▌");
            expect(handleTuiSettingsPickerKey(state, { name: "return" }).selection)
                .toBeUndefined();
        } finally {
            setup.renderer.destroy();
        }
    });
}
