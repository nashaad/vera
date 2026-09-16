import { expect, test } from "bun:test";
import { TextRenderable, parseColor } from "@opentui/core";
import { TUI_NOTICE, TUI_SUCCESS } from "../../clients/tui/state.ts";
import { createTestRenderer } from "@opentui/core/testing";
import { createTuiSettingsPickerView, startTuiSettingsPicker, syncTuiModelPicker, updateTuiSettingsPickerSearch } from "../../clients/tui/settings-picker.ts";
import { journeyModels, modelJourney } from "../../clients/tui/model-journeys.ts";
import { shortlistOperationFeedback } from "../../clients/tui/model-operation-feedback.ts";

const models = [
    { provider: "p", model: "alpha", label: "Alpha", levels: [], description: "" },
    { provider: "p", model: "beta", label: "Beta", levels: [], description: "" },
    { provider: "q", model: "gamma", label: "Gamma", levels: [], description: "" },
];
const settings = { provider: "p", model: "alpha", availableModels: models,
    pooled: models.slice(1).map((row) => ({ ...row, available: true, verified: false })) };

test("membership changes retain the row, provider sections, and feedback space", async () => {
    const setup = await createTestRenderer({ width: 130, height: 40 });
    const view = createTuiSettingsPickerView(setup.renderer);
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    let state = modelJourney(startTuiSettingsPicker("model", "alpha", undefined, "ask", models, undefined, "p", undefined, settings.pooled), "shortlist");
    state = { ...state, selectedIndex: 1 };
    const initialOrder = state.options.map((row) => row.value);
    try {
        const layouts: string[] = [];
        for (const feedback of [undefined, { status: "working" as const, message: "Working" },
            { status: "success" as const, membership: "added" as const, message: "Beta added to favorites" },
            { status: "success" as const, membership: "removed" as const, message: "Beta removed from favorites" },
            { status: "error" as const, message: "Could not save" }]) {
            if (feedback?.status === "success") state = syncTuiModelPicker(state, { ...settings, pooled: settings.pooled.slice(1) });
            state = { ...state, journeyFeedback: feedback };
            view.update(state);
            view.animateFeedback(0, true);
            await setup.renderOnce();
            const lines = setup.captureCharFrame().split("\n");
            expect(lines.join("\n")).toContain(`Favorites (${feedback === undefined || feedback.status === "working" ? 2 : 1})`);
            const beta = lines.findIndex((line) => line.includes("Beta") && line.includes("price unknown"));
            const footer = lines.findIndex((line) => line.includes("⏎ / Ctrl+S"));
            layouts.push(JSON.stringify([view.box.screenY, view.box.height, beta, footer]));
            expect(state.options.map((row) => row.value)).toEqual(initialOrder);
            expect(state.options[state.selectedIndex]?.model).toBe("beta");
            expect(lines.join("\n")).not.toContain("discovered");
            expect(lines.join("\n")).not.toContain("default slot");
            if (feedback !== undefined) {
                const message = lines.findIndex((line) => line.includes(feedback.message));
                expect(message).toBeGreaterThan(beta);
                expect(message).toBeLessThan(footer);
            }
            if (feedback?.status === "working") {
                const node = view.box.getChildren().find((node) => node.id === "model-operation-working")!;
                const before = JSON.stringify((node as { content?: unknown }).content);
                view.animateFeedback(8, true);
                expect(JSON.stringify((node as { content?: unknown }).content)).not.toBe(before);
            }
            if (feedback?.status === "success") {
                const node = view.box.getChildren().find((node) => node.id === "model-operation-result") as TextRenderable;
                const removed = feedback.membership === "removed";
                expect(node.fg).toEqual(parseColor(removed ? TUI_NOTICE : TUI_SUCCESS));
                expect(lines.join("\n")).toContain(`${removed ? "−" : "✓"} ${feedback.message}`);
            }
        }
        expect(new Set(layouts).size).toBe(1);
        view.update(updateTuiSettingsPickerSearch(state, "Alpha").state!);
        await setup.renderOnce();
        expect(setup.captureCharFrame()).toContain("Favorites (1)");
    } finally { setup.renderer.destroy(); }
});

test("unkeeping an otherwise hidden model does not remove its row during editing", () => {
    const picker = startTuiSettingsPicker("model", "alpha", undefined, "ask", models, undefined, "p", undefined, settings.pooled);
    const state = modelJourney({ ...picker, allOptions: picker.allOptions.map((row) => ({ ...row, hiddenByDefault: "old" })) }, "shortlist");
    const edited = { ...state, allOptions: state.allOptions.map((row) => ({ ...row, pooledRank: undefined })) };
    expect(journeyModels(edited).map((row) => row.model)).toEqual(state.options.map((row) => row.model));
});

test("only confirmed saves show a success tick", () => {
    const operation = { operation: "keep" as const, models: [models[1]!] };
    expect(shortlistOperationFeedback(operation, "Beta", [], settings)).toEqual({ status: "success", membership: "added", message: "Beta added to favorites" });
    expect(shortlistOperationFeedback({ ...operation, operation: "unkeep" }, "Beta", [{ ...models[1]!, status: "passed" }], settings).membership).toBe("removed");
    expect(shortlistOperationFeedback(operation, "Beta", [], undefined).status).toBe("error");
    expect(shortlistOperationFeedback(operation, "Beta", [{ ...models[1]!, status: "failed", reason: "Disk full" }], settings))
        .toEqual({ status: "error", message: "Disk full" });
    expect(shortlistOperationFeedback(operation, "Beta", [{ ...models[1]!, status: "passed" }], settings, "Connection lost").status).toBe("error");
});
