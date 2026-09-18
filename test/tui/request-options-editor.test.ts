import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiRequestOptionsEditorView,
    handleTuiRequestOptionsEditorKey,
    renderTuiRequestOptionsEditor,
    startTuiRequestOptionsEditor,
} from "../../clients/tui/request-options-editor.ts";
import type { TuiSettingsPickerState } from
    "../../clients/tui/settings-picker.ts";

const parent: TuiSettingsPickerState = {
    kind: "model",
    allOptions: [],
    options: [],
    selectedIndex: 0,
    query: "",
};

const candidate = {
    provider: "openrouter",
    model: "z-ai/glm-5.3-flash",
    support: {
        providerLabel: "OpenRouter",
        label: "OpenRouter request body",
        explanation:
            "Added to the OpenRouter request body. \"provider\" means the upstream host used by OpenRouter.",
        documentationUrl:
            "https://openrouter.ai/docs/guides/routing/provider-selection",
    },
} as const;

test("the request-options editor names scope and opens pretty JSON", () => {
    const state = startTuiRequestOptionsEditor(
        candidate,
        "default",
        { provider: { only: ["z-ai"], allow_fallbacks: false } },
        parent,
    );

    const frame = renderTuiRequestOptionsEditor(state);
    expect(frame).toContain("Vera provider   OpenRouter");
    expect(frame).toContain("Model           z-ai/glm-5.3-flash");
    expect(frame).toContain("default profile · every use of this model");
    expect(frame).toContain('"allow_fallbacks": false');
    expect(frame).toContain("Ctrl+S save");
});

test("valid JSON saves and an empty object clears the exact entry", () => {
    const valid = {
        ...startTuiRequestOptionsEditor(candidate, "default", undefined, parent),
        text: '{"provider":{"only":["z-ai"],"allow_fallbacks":false}}',
    };
    expect(handleTuiRequestOptionsEditorKey(valid, { name: "s", ctrl: true }).save)
        .toEqual({
            provider: "openrouter",
            model: "z-ai/glm-5.3-flash",
            body: {
                provider: { only: ["z-ai"], allow_fallbacks: false },
            },
            parent,
        });

    const clear = { ...valid, text: "{}" };
    expect(handleTuiRequestOptionsEditorKey(clear, { name: "s", ctrl: true })
        .save?.body).toEqual({});
});

test("invalid JSON and provider fields retain the exact editor text", () => {
    for (const text of [
        '{"provider":',
        '{ "provider": { "future": true } }',
    ]) {
        const state = {
            ...startTuiRequestOptionsEditor(candidate, "default", undefined, parent),
            text,
        };
        const transition = handleTuiRequestOptionsEditorKey(
            state,
            { name: "s", ctrl: true },
        );
        expect(transition.save).toBeUndefined();
        expect(transition.state?.text).toBe(text);
        expect(transition.state?.error?.length).toBeGreaterThan(0);
    }
});

test("Escape cancels without producing a save", () => {
    const state = startTuiRequestOptionsEditor(
        candidate,
        "default",
        undefined,
        parent,
    );
    const transition = handleTuiRequestOptionsEditorKey(state, {
        name: "escape",
    });
    expect(transition.cancelled).toBe(true);
    expect(transition.save).toBeUndefined();
});

test("reopening the same model discards a cancelled draft", async () => {
    const setup = await createTestRenderer({ width: 80, height: 28 });
    const view = createTuiRequestOptionsEditorView(setup.renderer);
    const stored = startTuiRequestOptionsEditor(
        candidate,
        "default",
        { provider: { only: ["z-ai"] } },
        parent,
    );
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    view.update(stored);
    view.focus();
    view.handlePaste(stored, "cancelled-draft");

    view.update(startTuiRequestOptionsEditor(
        candidate,
        "default",
        { provider: { only: ["z-ai"] } },
        parent,
    ));
    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).not.toContain("cancelled-draft");
        expect(frame).toContain('"only": [');
        expect(frame).toContain('"z-ai"');
    } finally {
        setup.renderer.destroy();
    }
});

test("narrow monochrome rendering keeps context, error, and footer readable", async () => {
    const setup = await createTestRenderer({ width: 64, height: 24 });
    const view = createTuiRequestOptionsEditorView(setup.renderer);
    const state = {
        ...startTuiRequestOptionsEditor(candidate, "default", undefined, parent),
        error: "request options.provider.only must contain nonempty provider names",
    };
    setup.renderer.root.add(view.surface);
    view.surface.visible = true;
    view.update(state);
    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Request options");
        expect(frame).toContain("OpenRouter");
        expect(frame).toContain("z-ai/glm-5.3-flash");
        expect(frame).toContain("┌");
        expect(frame).toContain("▲ request options.provider.only");
        expect(frame).toContain("esc cancel  Ctrl+S save");
    } finally {
        setup.renderer.destroy();
    }
});
