import { useEffect, useMemo, useReducer, useRef } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";
import type { ModelControls } from "./controls.ts";
import { INITIAL_DRAFT_MODEL_STATE, observeDraftModelSettings, reduceDraftModel } from "./draft-model-state.ts";
import { parseModelSettings, type ModelChoice } from "./settings.ts";
import { choiceOf, runOperation } from "./useSessionModels.ts";

// What New Chat asks the new session to run before its first prompt.
export interface DraftModel {
    readonly provider?: string;
    readonly model: string;
    // Undefined keeps what the host picks; `null` asks for the model's own default.
    readonly effort?: string | null;
    // False when only the effort changed.
    readonly switched: boolean;
}

export interface DraftModels {
    readonly controls: ModelControls;
    // Undefined while the person has not changed the model or effort.
    readonly draft: DraftModel | undefined;
}

export function draftModelFor(model: ModelChoice | undefined, picked: ModelChoice | undefined, effort: string | null | undefined): DraftModel | undefined {
    if (model === undefined || (picked === undefined && effort === undefined)) return undefined;
    return {
        ...(model.provider === undefined ? {} : { provider: model.provider }),
        model: model.model,
        ...(effort === undefined ? {} : { effort }),
        switched: picked !== undefined,
    };
}

// New Chat's model controls: the host's defaults for the picked folder, changed only in this window
// until the session is created. New Chat mounts before the host is up, so it reads again on attach.
export function useDraftModels(bridge: DesktopBridge, folder: string | undefined, attached: boolean, enabled: boolean): DraftModels {
    const [{ settings, failure, picked, effort }, dispatch] = useReducer(reduceDraftModel, INITIAL_DRAFT_MODEL_STATE);
    const operationVersion = useRef(0);

    useEffect(() => observeDraftModelSettings(bridge, folder, attached, dispatch, () => {
        operationVersion.current += 1;
    }), [bridge, folder, attached]);

    const actions = useMemo(() => {
        const adopt = (value: unknown): void => {
            const parsed = parseModelSettings(value);
            if (parsed !== undefined) dispatch({ type: "settings", settings: parsed });
        };
        const operate = async (operation: "keep" | "unkeep" | "verify", provider: string, model: string) => {
            const version = operationVersion.current;
            const outcome = await runOperation(bridge, operation, provider, model, folder);
            if (version === operationVersion.current && outcome.settings !== undefined) adopt(outcome.settings);
            return outcome.ok ? { ok: true as const } : { ok: false as const, reason: outcome.reason };
        };
        return {
            pick: (choice: ModelChoice) => dispatch({ type: "pick", choice }),
            setEffort: (next: string | null) => dispatch({ type: "effort", effort: next }),
            shortlist: async (model: { readonly provider: string; readonly model: string }, on: boolean) => {
                const outcome = await operate(on ? "keep" : "unkeep", model.provider, model.model);
                return outcome.ok ? undefined : outcome.reason;
            },
            probe: (model: { readonly provider: string; readonly model: string }) => operate("verify", model.provider, model.model),
        };
    }, [bridge, folder]);

    const base = settings === undefined ? undefined : choiceOf(settings);
    const model = picked ?? base;
    const shownEffort = effort === undefined ? model?.effort : effort ?? undefined;
    const choice = model === undefined
        ? undefined
        : { ...(model.provider === undefined ? {} : { provider: model.provider }), model: model.model, ...(shownEffort === undefined ? {} : { effort: shownEffort }) };
    const draft = draftModelFor(model, picked, effort);

    return {
        controls: {
            settings,
            choice,
            enabled: enabled && settings !== undefined,
            ...(failure === undefined ? {} : { note: failure }),
            ...(folder === undefined ? {} : { workspace: folder }),
            actions,
        },
        draft,
    };
}
