import { useEffect, useMemo, useState } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";
import type { ModelControls } from "./controls.ts";
import { parseModelSettings, type ModelChoice, type ModelSettings } from "./settings.ts";
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

const UNREADABLE = "The host did not list its models.";

// New Chat's model controls: the host's defaults for the picked folder, changed only in this window
// until the session is created.
export function useDraftModels(bridge: DesktopBridge, folder: string | undefined, enabled: boolean): DraftModels {
    const [settings, setSettings] = useState<ModelSettings | undefined>(undefined);
    const [failure, setFailure] = useState<string | undefined>(undefined);
    const [picked, setPicked] = useState<ModelChoice | undefined>(undefined);
    const [effort, setEffort] = useState<string | null | undefined>(undefined);

    useEffect(() => {
        let live = true;
        setFailure(undefined);
        void bridge.readModelSettings(folder).then(
            (result) => {
                if (!live) return;
                if (!result.ok) {
                    setFailure(result.reason);
                    return;
                }
                const parsed = parseModelSettings(result.settings);
                if (parsed === undefined) setFailure(UNREADABLE);
                else setSettings(parsed);
            },
            () => {
                if (live) setFailure(UNREADABLE);
            },
        );
        return () => {
            live = false;
        };
    }, [bridge, folder]);

    const actions = useMemo(() => {
        const adopt = (value: unknown): void => {
            const parsed = parseModelSettings(value);
            if (parsed !== undefined) setSettings(parsed);
        };
        const operate = async (operation: "keep" | "unkeep" | "verify", provider: string, model: string) => {
            const outcome = await runOperation(bridge, operation, provider, model, folder);
            if (outcome.settings !== undefined) adopt(outcome.settings);
            return outcome.ok ? { ok: true as const } : { ok: false as const, reason: outcome.reason };
        };
        return {
            pick: (choice: ModelChoice) => {
                setPicked(choice);
                setEffort(choice.effort);
            },
            setEffort: (next: string | null) => setEffort(next),
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
    const draft = model === undefined || (picked === undefined && effort === undefined)
        ? undefined
        : {
            ...(model.provider === undefined ? {} : { provider: model.provider }),
            model: model.model,
            ...(effort === undefined ? {} : { effort }),
            switched: picked !== undefined,
        };

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
