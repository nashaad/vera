import { randomUUID } from "node:crypto";
import { isHomeClient } from "../home-client.ts";
import {
    modelSwitcherKey,
    refreshedTuiModelSwitcher,
    startTuiModelSwitcher,
    type TuiModelSwitcherRow,
    type TuiModelSwitcherState,
} from "../model-switcher.ts";
import { requestPoolAdmission, showStatusNotice } from "../main.ts";
import { focusedAgentClient, focusedAgentState } from "./agents-dials.ts";
import { requestAgentSettings } from "./diagnostics-ops.ts";
import { sendCommand } from "./extension-bridge.ts";
import { focusActiveSurface } from "./focus-switch.ts";
import { modelLevelFacts, openProviderPicker } from "./model-pickers.ts";
import { renderState } from "./render-state.ts";
import { beginCreateSession, currentDraft } from "./session-ops.ts";
import { startTuiReasoningPicker } from "../settings-picker.ts";
import { effortWentStale } from "../../../src/model/effort-ladder.ts";
import type { TuiRuntime } from "./runtime.ts";
import type { TuiState } from "../state.ts";

/**
 * The rows the switcher lists: every connected model, favorites and recents
 * first. Reduction-hidden entries stay out; they are duplicates and dated
 * snapshots of rows already here, not models the pool is holding back.
 *
 * With nothing in the pool the catalog's recommended models stand in as
 * favorites, so the default path works before anyone curates. They are seeded,
 * not pooled, so the first `^f` on one adds it rather than trying to remove it.
 */
export function modelSwitcherRows(rt: TuiRuntime): readonly TuiModelSwitcherRow[] {
    const settings = focusedAgentState(rt).modelSettings;
    const pooled = settings?.pooled ?? [];
    const favorites = new Set(pooled.map(modelSwitcherKey));
    const seed = pooled.length === 0;
    const efforts = lastEfforts(focusedAgentState(rt));
    return (settings?.availableModels ?? [])
        .filter((model) => model.hiddenByDefault === undefined)
        .map((model) => {
            const key = `${model.provider}/${model.model}`;
            const effort = efforts.get(key);
            return {
                provider: model.provider,
                model: model.model,
                label: model.label,
                providerLabel: model.provider,
                ...(favorites.has(key) ? { favorite: true } : {}),
                ...(seed && model.recommended === true ? { seeded: true } : {}),
                ...(model.verificationError === undefined ? {} : { unavailable: true }),
                ...(effort === undefined ? {} : { effort }),
            };
        });
}

/** Most recent first, one entry per model. */
function lastEfforts(state: TuiState): ReadonlyMap<string, string> {
    const efforts = new Map<string, string>();
    for (const { settings } of state.modelSettingsHistory ?? []) {
        if (settings.provider === undefined) continue;
        const key = `${settings.provider}/${settings.model}`;
        if (efforts.has(key) || settings.reasoningEffort === undefined) continue;
        efforts.set(key, settings.reasoningEffort);
    }
    return efforts;
}

function switcherRecents(rt: TuiRuntime): readonly string[] {
    const seen: string[] = [];
    for (const { settings } of focusedAgentState(rt).modelSettingsHistory ?? []) {
        if (settings.provider === undefined) continue;
        const key = `${settings.provider}/${settings.model}`;
        if (!seen.includes(key)) seen.push(key);
    }
    return seen;
}

function currentKey(rt: TuiRuntime): string | undefined {
    const settings = focusedAgentState(rt).modelSettings;
    if (settings?.provider === undefined || settings.model === undefined) {
        return undefined;
    }
    return `${settings.provider}/${settings.model}`;
}

export function openModelSwitcher(rt: TuiRuntime): void {
    rt.settingsPickerAgent = focusedAgentClient(rt);
    const current = currentKey(rt);
    rt.modelSwitcher = startTuiModelSwitcher(modelSwitcherRows(rt), {
        ...(current === undefined ? {} : { current }),
        recents: switcherRecents(rt),
    });
    requestAgentSettings(rt, focusedAgentClient(rt));
    requestModelSettingsHistory(rt);
    renderState(rt);
    focusActiveSurface(rt);
}

/** The recents the switcher lists come from the session's own history. */
function requestModelSettingsHistory(rt: TuiRuntime): void {
    void focusedAgentClient(rt).send({
        type: "get_session_model_settings_history",
        requestId: randomUUID(),
    }).catch(() => {});
}

export function closeModelSwitcher(rt: TuiRuntime): void {
    rt.modelSwitcher = undefined;
    rt.modelSwitcherView.surface.visible = false;
    renderState(rt);
    focusActiveSurface(rt);
}

/** Keeps an open switcher current when the pool or the catalog changes underneath it. */
export function refreshModelSwitcher(rt: TuiRuntime, notice?: string): void {
    if (rt.modelSwitcher === undefined) return;
    rt.modelSwitcher = refreshedTuiModelSwitcher(
        rt.modelSwitcher,
        modelSwitcherRows(rt),
        notice,
    );
}

export function toggleModelSwitcherFavorite(
    rt: TuiRuntime,
    row: TuiModelSwitcherRow,
): void {
    if (row.favorite === true) {
        sendCommand(rt, {
            type: "pool_remove",
            requestId: randomUUID(),
            provider: row.provider,
            model: row.model,
        });
        refreshModelSwitcher(rt, `Removing ${row.label} from favorites…`);
    } else {
        requestPoolAdmission(rt, row.provider, row.model);
        refreshModelSwitcher(rt, `Adding ${row.label} to favorites…`);
    }
    renderState(rt);
}

export function switcherNeedsProviders(rt: TuiRuntime): void {
    closeModelSwitcher(rt);
    openProviderPicker(rt);
}

export function applyModelSwitcherSelection(
    rt: TuiRuntime,
    row: TuiModelSwitcherRow,
): void {
    const levels = modelLevelFacts(rt, row.provider, row.model);
    const carriedEffort = rt.state.modelSettings?.reasoningEffort;
    const mustAsk = levels !== undefined
        && effortWentStale(levels.levels.map((level) => level.id), carriedEffort);
    if (levels !== undefined && levels.levels.length > 0 && mustAsk) {
        rt.modelSwitcher = undefined;
        rt.modelSwitcherView.surface.visible = false;
        rt.settingsPicker = startTuiReasoningPicker(
            levels.levels,
            levels.defaultLevel,
            carriedEffort,
            { provider: row.provider, model: row.model },
        );
        rt.composer.blur();
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    closeModelSwitcher(rt);
    applyModelSwitch(rt, {
        provider: row.provider,
        model: row.model,
        // The effort was not asked for, so a level the new model still
        // supports has to survive the switch rather than be cleared.
        ...(levels !== undefined && levels.levels.length > 0 && carriedEffort !== undefined
            ? { reasoningEffort: carriedEffort }
            : {}),
    });
}

export function applyModelSwitch(
    rt: TuiRuntime,
    choice: {
        readonly provider: string;
        readonly model: string;
        readonly reasoningEffort?: string;
    },
): void {
    const target = rt.settingsPickerAgent ?? focusedAgentClient(rt);
    const apply = () => {
        const client = isHomeClient(target) ? focusedAgentClient(rt) : target;
        void client.send({
            type: "update_session_model_settings",
            requestId: randomUUID(),
            patch: {
                provider: choice.provider,
                model: choice.model,
                reasoningEffort: choice.reasoningEffort ?? null,
            },
        }).catch((error: unknown) => {
            showStatusNotice(rt, String(error));
            renderState(rt);
        });
        const chosen = choice.reasoningEffort === undefined
            ? choice.model
            : `${choice.model} (${choice.reasoningEffort})`;
        showStatusNotice(rt, `${chosen}. Applies to the next request.`);
        renderState(rt);
    };
    if (isHomeClient(target)) {
        const draft = currentDraft(rt);
        beginCreateSession(rt, "stop", () => draft, apply);
    } else apply();
}

export function modelSwitcherIsOpen(
    rt: TuiRuntime,
): rt is TuiRuntime & { modelSwitcher: TuiModelSwitcherState } {
    return rt.modelSwitcher !== undefined;
}
