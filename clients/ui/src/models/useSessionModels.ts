import { useMemo, useState } from "react";

import { freshRequestId } from "../composer/requests.ts";
import type { DesktopBridge, ModelOperationKind } from "../protocol/bridge.ts";
import type { SessionWatch } from "../session/model.ts";
import { effortCommand, getModelSettingsCommand, switchModelCommand } from "./commands.ts";
import type { ModelControls, ProbeOutcome } from "./controls.ts";
import type { ModelChoice } from "./settings.ts";

const REFUSED = "Vera could not switch to that model.";
const WAITING = "after this turn";

// The model controls of a running session: changes go out on its watch connection.
export function useSessionModels(
    bridge: DesktopBridge,
    watch: SessionWatch,
    send: (line: string) => void,
    folder: string | undefined,
): ModelControls {
    const [sentId, setSentId] = useState<string | undefined>(undefined);
    const settings = watch.models?.settings;
    const running = watch.status !== "idle";
    const refused = sentId !== undefined && watch.modelRefused?.requestId === sentId;
    const waiting = running && watch.models?.pending === true && watch.models.requestId === sentId;

    const actions = useMemo(() => {
        const dispatch = (line: (requestId: string) => string): void => {
            const requestId = freshRequestId("model");
            setSentId(requestId);
            send(line(requestId));
        };
        const refresh = (): void => send(getModelSettingsCommand(freshRequestId("models")));
        const operate = async (operation: ModelOperationKind, provider: string, model: string): Promise<ProbeOutcome> => {
            const outcome = await runOperation(bridge, operation, provider, model, folder);
            refresh();
            return outcome;
        };
        return {
            pick: (choice: ModelChoice) => dispatch((id) => switchModelCommand(id, choice.provider, choice.model, choice.effort)),
            setEffort: (effort: string | null) => dispatch((id) => effortCommand(id, effort)),
            shortlist: async (model: { readonly provider: string; readonly model: string }, on: boolean) => {
                const outcome = await operate(on ? "keep" : "unkeep", model.provider, model.model);
                return outcome.ok ? undefined : outcome.reason;
            },
            probe: (model: { readonly provider: string; readonly model: string }) => operate("verify", model.provider, model.model),
        };
    }, [bridge, send, folder]);

    return {
        settings,
        choice: settings === undefined ? undefined : choiceOf(settings),
        enabled: watch.phase === "attached" && settings !== undefined,
        ...(refused ? { note: REFUSED } : waiting ? { note: WAITING } : {}),
        ...(folder === undefined ? {} : { workspace: folder }),
        actions,
    };
}

export function choiceOf(settings: { readonly provider?: string; readonly model: string; readonly effort?: string }): ModelChoice {
    return {
        ...(settings.provider === undefined ? {} : { provider: settings.provider }),
        model: settings.model,
        ...(settings.effort === undefined ? {} : { effort: settings.effort }),
    };
}

export async function runOperation(
    bridge: DesktopBridge,
    operation: ModelOperationKind,
    provider: string,
    model: string,
    workspace: string | undefined,
): Promise<ProbeOutcome & { readonly settings?: unknown }> {
    try {
        const result = await bridge.operateModel(operation, provider, model, workspace);
        if (!result.ok) return { ok: false, reason: result.reason };
        const failed = result.results.find((check) => check.status === "failed");
        const settings = result.settings === undefined ? {} : { settings: result.settings };
        if (failed !== undefined) return { ok: false, reason: failed.reason ?? "The provider did not accept the request.", ...settings };
        return { ok: true, ...settings };
    } catch {
        return { ok: false, reason: "The host could not change that model." };
    }
}
