import type { DesktopBridge } from "../protocol/bridge.ts";
import { subscribeProviderModelSelected } from "./provider-selection.ts";
import { parseModelSettings, type ModelChoice, type ModelSettings } from "./settings.ts";

const UNREADABLE = "The host did not list its models.";

export interface DraftModelState {
    readonly settings: ModelSettings | undefined;
    readonly failure: string | undefined;
    readonly picked: ModelChoice | undefined;
    readonly effort: string | null | undefined;
}

export type DraftModelAction =
    | { readonly type: "provider-selected" }
    | { readonly type: "read-started" }
    | { readonly type: "settings"; readonly settings: ModelSettings }
    | { readonly type: "failed"; readonly reason: string }
    | { readonly type: "pick"; readonly choice: ModelChoice }
    | { readonly type: "effort"; readonly effort: string | null };

export const INITIAL_DRAFT_MODEL_STATE: DraftModelState = {
    settings: undefined,
    failure: undefined,
    picked: undefined,
    effort: undefined,
};

export function reduceDraftModel(state: DraftModelState, action: DraftModelAction): DraftModelState {
    switch (action.type) {
        case "provider-selected":
            return INITIAL_DRAFT_MODEL_STATE;
        case "read-started":
            return { ...state, failure: undefined };
        case "settings":
            return { ...state, settings: action.settings };
        case "failed":
            return { ...state, failure: action.reason };
        case "pick":
            return { ...state, picked: action.choice, effort: action.choice.effort };
        case "effort":
            return { ...state, effort: action.effort };
    }
}

export function observeDraftModelSettings(
    bridge: Pick<DesktopBridge, "readModelSettings">,
    folder: string | undefined,
    attached: boolean,
    dispatch: (action: DraftModelAction) => void,
    invalidateOperations: () => void,
): () => void {
    let live = true;
    let version = 0;
    const read = (): void => {
        const request = ++version;
        if (!attached) return;
        dispatch({ type: "read-started" });
        void Promise.resolve().then(() => bridge.readModelSettings(folder)).then(
            (result) => {
                if (!live || request !== version) return;
                if (!result.ok) {
                    dispatch({ type: "failed", reason: result.reason });
                    return;
                }
                const settings = parseModelSettings(result.settings);
                if (settings === undefined) dispatch({ type: "failed", reason: UNREADABLE });
                else dispatch({ type: "settings", settings });
            },
            () => {
                if (live && request === version) dispatch({ type: "failed", reason: UNREADABLE });
            },
        );
    };
    const unsubscribe = subscribeProviderModelSelected(() => {
        invalidateOperations();
        dispatch({ type: "provider-selected" });
        read();
    });
    read();
    return () => {
        live = false;
        version += 1;
        unsubscribe();
    };
}
