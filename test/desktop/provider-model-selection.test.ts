import { expect, test } from "bun:test";

import {
    INITIAL_DRAFT_MODEL_STATE,
    observeDraftModelSettings,
    reduceDraftModel,
    type DraftModelAction,
    type DraftModelState,
} from "../../clients/ui/src/models/draft-model-state.ts";
import { subscribeProviderModelSelected } from "../../clients/ui/src/models/provider-selection.ts";
import { draftModelFor } from "../../clients/ui/src/models/useDraftModels.ts";
import { choiceOf } from "../../clients/ui/src/models/useSessionModels.ts";
import { selectProviderModel } from "../../clients/ui/src/pages/settings/provider-wizard/select-model.ts";
import type { HostModelsResult } from "../../clients/ui/src/protocol/bridge.ts";

const starter = { provider: "openrouter", model: "openai/gpt-5.6-sol", reasoningEffort: "high" };
const deepseek = { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "high" };
const success = { selectProviderModel: async () => ({ ok: true as const }) };

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

async function flush(): Promise<void> {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function draftState() {
    let state: DraftModelState = INITIAL_DRAFT_MODEL_STATE;
    return {
        current: () => state,
        dispatch: (action: DraftModelAction) => { state = reduceDraftModel(state, action); },
    };
}

test("@core successful provider model selection clears draft overrides and reads the new host default", async () => {
    const state = draftState();
    const folders: (string | undefined)[] = [];
    let hostSettings = starter;
    let invalidated = 0;
    const stop = observeDraftModelSettings({
        readModelSettings: async (folder) => {
            folders.push(folder);
            return { ok: true, settings: hostSettings };
        },
    }, "/workspace", true, state.dispatch, () => { invalidated += 1; });
    try {
        await flush();
        expect(state.current().settings?.model).toBe(starter.model);
        state.dispatch({ type: "pick", choice: { provider: "other", model: "other-model", effort: "low" } });
        state.dispatch({ type: "effort", effort: "max" });
        expect(state.current().picked?.model).toBe("other-model");
        expect(state.current().effort).toBe("max");
        expect(draftModelFor(state.current().picked, state.current().picked, state.current().effort)).toEqual({
            provider: "other", model: "other-model", effort: "max", switched: true,
        });

        hostSettings = deepseek;
        expect(await selectProviderModel(success, "deepseek", "deepseek-v4-pro", () => true)).toEqual({ ok: true });
        await flush();
        expect(invalidated).toBe(1);
        expect(folders).toEqual(["/workspace", "/workspace"]);
        expect(state.current().picked).toBeUndefined();
        expect(state.current().effort).toBeUndefined();
        expect(state.current().settings?.provider).toBe("deepseek");
        expect(state.current().settings?.model).toBe("deepseek-v4-pro");
        expect(state.current().settings?.effort).toBe("high");
        expect(draftModelFor(choiceOf(state.current().settings!), state.current().picked, state.current().effort)).toBeUndefined();
    } finally {
        stop();
    }
});

test("@core failed and canceled model selections do not notify or clear the draft", async () => {
    const state = draftState();
    let reads = 0;
    let notifications = 0;
    const stop = observeDraftModelSettings({
        readModelSettings: async () => {
            reads += 1;
            return { ok: true, settings: starter };
        },
    }, undefined, true, state.dispatch, () => {});
    const unsubscribe = subscribeProviderModelSelected(() => { notifications += 1; });
    try {
        await flush();
        state.dispatch({ type: "pick", choice: { provider: "other", model: "other-model" } });
        state.dispatch({ type: "effort", effort: "off" });
        const refused = { selectProviderModel: async () => ({ ok: false as const, reason: "not verified" }) };
        expect(await selectProviderModel(refused, "deepseek", "deepseek-v4-pro", () => true)).toEqual({ ok: false, reason: "not verified" });
        const disconnected = { selectProviderModel: async () => { throw new Error("unavailable"); } };
        await expect(selectProviderModel(disconnected, "deepseek", "deepseek-v4-pro", () => true)).rejects.toThrow("unavailable");

        const pending = deferred<{ readonly ok: true }>();
        let current = true;
        const canceled = selectProviderModel({ selectProviderModel: () => pending.promise }, "deepseek", "deepseek-v4-pro", () => current);
        current = false;
        pending.resolve({ ok: true });
        await canceled;
        await flush();

        expect(notifications).toBe(0);
        expect(reads).toBe(1);
        expect(state.current().picked?.model).toBe("other-model");
        expect(state.current().effort).toBe("off");
        expect(state.current().settings?.model).toBe(starter.model);
    } finally {
        unsubscribe();
        stop();
    }
});

test("@core a late settings answer cannot replace the refreshed provider model", async () => {
    const state = draftState();
    const oldAnswer = deferred<HostModelsResult>();
    let reads = 0;
    const stop = observeDraftModelSettings({
        readModelSettings: () => {
            reads += 1;
            return reads === 1 ? oldAnswer.promise : Promise.resolve({ ok: true, settings: deepseek });
        },
    }, undefined, true, state.dispatch, () => {});
    try {
        await flush();
        await selectProviderModel(success, "deepseek", "deepseek-v4-pro", () => true);
        await flush();
        expect(state.current().settings?.model).toBe(deepseek.model);
        oldAnswer.resolve({ ok: true, settings: starter });
        await flush();
        expect(reads).toBe(2);
        expect(state.current().settings?.model).toBe(deepseek.model);
    } finally {
        stop();
    }
});

test("@core selection clears an inactive draft and reads when New Chat attaches", async () => {
    const state = draftState();
    let reads = 0;
    const bridge = {
        readModelSettings: async () => {
            reads += 1;
            return { ok: true as const, settings: deepseek };
        },
    };
    state.dispatch({ type: "pick", choice: { provider: "other", model: "other-model" } });
    state.dispatch({ type: "effort", effort: "max" });
    const stopInactive = observeDraftModelSettings(bridge, undefined, false, state.dispatch, () => {});
    try {
        await selectProviderModel(success, "deepseek", "deepseek-v4-pro", () => true);
        expect(reads).toBe(0);
        expect(state.current().picked).toBeUndefined();
        expect(state.current().effort).toBeUndefined();
    } finally {
        stopInactive();
    }
    const stopAttached = observeDraftModelSettings(bridge, undefined, true, state.dispatch, () => {});
    try {
        await flush();
        expect(reads).toBe(1);
        expect(state.current().settings?.model).toBe(deepseek.model);
    } finally {
        stopAttached();
    }
});
