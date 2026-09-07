import { verificationPicker, verificationResults } from "../model-verification.ts";
import { runModelOperation } from "./model-operations.ts";
import { HOST_CAPABILITY_SESSION_SCOPED_STATE } from "../../../src/host/capabilities.ts";
import type { TuiAgentClient } from "../agent-client.ts";
import { showStatusNotice, showVerificationConsole } from "../main.ts";
import { focusedAgentClient, focusedAgentState } from "../main/agents-dials.ts";
import { sendCommand } from "../main/extension-bridge.ts";
import { focusActiveSurface, reportConnectionError } from "../main/focus-switch.ts";
import { catalogSizeOf, openModelPicker, refreshableProvidersOf } from "../main/model-pickers.ts";
import { renderState } from "../main/render-state.ts";
import { startTuiCatalogRefreshScopePicker, startTuiPoolVerifyScopePicker, withTuiPickerParent } from "../settings-picker.ts";
import { appendTuiNotice, beginTuiAdmission } from "../state.ts";
import { applyTuiThemeBindings } from "../theme-bindings.ts";
import { resolveTuiTheme } from "../theme.ts";
import type { TuiRuntime } from "./runtime.ts";
import { randomUUID } from "node:crypto";

export function requestCatalogRefresh(rt: TuiRuntime, provider: string): void {
    const requestId = randomUUID();
    rt.catalogRefreshes.set(requestId, provider);
    showStatusNotice(rt, `asking ${provider} for its model list…`);
    sendCommand(rt, { type: "catalog_refresh", requestId, provider });
    renderState(rt);
}

export function requestPoolAdmission(rt: TuiRuntime, 
    provider: string,
    model: string,
    verify = false,
    retry = false,
): string {
    const requestId = randomUUID();
    rt.poolAdmissionAttempts.set(requestId, { provider, model, verify, retry });
    rt.state = beginTuiAdmission(rt.state, requestId, `${provider}/${model}`);
    showVerificationConsole(rt, requestId, `${provider}/${model}`);
    sendCommand(rt, {
        type: "pool_add",
        requestId,
        provider,
        model,
        ...(verify ? { verify: true } : {}),
    });
    renderState(rt);
    return requestId;
}

export function dialogAdmission(rt: TuiRuntime) {
    return rt.state.admission !== undefined
            && rt.state.admission.requestId === rt.admissionDialog?.requestId
        ? rt.state.admission
        : undefined;
}

export function keptModels(rt: TuiRuntime): readonly {
    readonly provider: string;
    readonly model: string;
    readonly verified: boolean;
}[] {
    return (focusedAgentState(rt).modelSettings?.pooled ?? []).map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        verified: entry.verified === true,
    }));
}

export function openCatalogRefreshScopePicker(rt: TuiRuntime): void {
    const targetState = rt.state;
    const providers = refreshableProvidersOf(rt, 
        targetState.modelSettings?.availableModels,
        targetState.modelSettings?.refreshableProviders,
    );
    if (providers.length === 0) {
        showStatusNotice(rt, "no provider here keeps a model list to refresh");
        return;
    }
    rt.settingsPicker = withTuiPickerParent(
        startTuiCatalogRefreshScopePicker(
            providers.map((name) => ({
                name,
                models: catalogSizeOf(rt, name),
            })),
        ),
        rt.settingsPicker?.kind === "model" ? rt.settingsPicker : undefined,
    );
    renderState(rt);
    focusActiveSurface(rt);
}

export function startCatalogRefreshSweep(rt: TuiRuntime, providers: readonly string[]): void {
    const queue = providers.length > 0
        ? providers
        : refreshableProvidersOf(rt, 
            rt.state.modelSettings?.availableModels,
            rt.state.modelSettings?.refreshableProviders,
        );
    rt.composer.blur();
    if (rt.catalogRefreshSweep !== undefined) {
        showStatusNotice(rt, "a refresh is already running");
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (queue.length === 0) {
        showStatusNotice(rt, "no provider here keeps a model list to refresh");
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    rt.catalogRefreshSweep = { queue, index: 0, results: [] };
    renderState(rt);
    focusActiveSurface(rt);
    advanceCatalogRefreshSweep(rt);
}

export function advanceCatalogRefreshSweep(rt: TuiRuntime): void {
    const sweep = rt.catalogRefreshSweep;
    if (sweep === undefined) return;
    const next = sweep.queue[sweep.index];
    if (next === undefined) {
        rt.catalogRefreshSweep = undefined;
        showStatusNotice(rt, catalogRefreshSummary(rt, sweep.results));
        renderState(rt);
        return;
    }
    sweep.results.push({ provider: next, before: catalogSizeOf(rt, next) });
    showStatusNotice(rt, 
        `asking ${next} (${sweep.index + 1}/${sweep.queue.length})\u2026`,
    );
    const requestId = randomUUID();
    sweep.requestId = requestId;
    sendCommand(rt, { type: "catalog_refresh", requestId, provider: next });
    renderState(rt);
}

export function catalogRefreshSweepResult(rt: TuiRuntime, 
    requestId: string,
    refreshed: boolean,
): boolean {
    const sweep = rt.catalogRefreshSweep;
    if (sweep === undefined || sweep.requestId !== requestId) return false;
    const result = sweep.results.at(-1);
    if (result !== undefined && refreshed) {
        result.after = catalogSizeOf(rt, result.provider);
    }
    sweep.index += 1;
    advanceCatalogRefreshSweep(rt);
    return true;
}

export function catalogRefreshSummary(rt: TuiRuntime, 
    results: readonly {
        readonly provider: string;
        readonly before: number;
        readonly after?: number;
    }[],
): string {
    return results
        .map((entry) => {
            if (entry.after === undefined) {
                return `${entry.provider}: could not ask`;
            }
            const delta = entry.after - entry.before;
            return delta === 0
                ? `${entry.provider}: ${entry.after}, nothing new`
                : `${entry.provider}: ${entry.after}, ${
                    delta > 0 ? `+${delta} new` : `${-delta} gone`
                }`;
        })
        .join(" \u00b7 ");
}

export function openPoolVerifyScopePicker(rt: TuiRuntime): void {
    rt.settingsPicker = rt.modelVerification?.running
        ? verificationResults(rt.modelVerification) : verificationPicker(keptModels(rt));
    renderState(rt);
    focusActiveSurface(rt);
}

export function startPoolVerifySweep(rt: TuiRuntime, onlyUnverified: boolean, provider?: string): void {
    runModelOperation(rt, { operation: "verify", models: keptModels(rt)
        .filter((entry) => (!onlyUnverified || !entry.verified) && (provider === undefined || entry.provider === provider)) });
}

export function advancePoolVerifySweep(rt: TuiRuntime): void {
    const sweep = rt.poolVerifySweep;
    if (sweep === undefined) return;
    const next = sweep.queue[sweep.index];
    if (next === undefined) {
        rt.poolVerifySweep = undefined;
        showStatusNotice(rt, 
            `probed ${sweep.total}, ${sweep.answered} answered`,
        );
        renderState(rt);
        return;
    }
    showStatusNotice(rt, 
        `probing ${next.provider}/${next.model} (${sweep.index + 1}/${sweep.total})`,
    );
    sweep.requestId = requestPoolAdmission(rt, next.provider, next.model, true);
}

export function poolVerifySweepResult(rt: TuiRuntime, requestId: string, verdict: string): boolean {
    const sweep = rt.poolVerifySweep;
    if (sweep === undefined || sweep.requestId !== requestId) return false;
    if (verdict === "added") sweep.answered += 1;
    sweep.index += 1;
    advancePoolVerifySweep(rt);
    return true;
}

export function verifyModelInPicker(rt: TuiRuntime, provider: string, model: string): void {
    runModelOperation(rt, { operation: "verify", models: [{ provider, model }] });
    rt.composer.blur();
    renderState(rt);
    focusActiveSurface(rt);
}

export function closeAdmissionDialog(rt: TuiRuntime, reopenPoolPicker: boolean): void {
    const returnPicker = rt.admissionReturnPicker;
    rt.admissionDialog = undefined;
    rt.admissionReturnPicker = undefined;
    if (reopenPoolPicker && returnPicker !== undefined) {
        openModelPicker(rt, returnPicker.parent);
        return;
    }
    rt.settingsPicker = returnPicker;
    focusActiveSurface(rt);
    renderState(rt);
}

export function requestPermissionsChange(rt: TuiRuntime, 
    mode: string,
    target: TuiAgentClient = focusedAgentClient(rt),
    scope: "session" | "global" = "global",
): void {
    const requestId = randomUUID();
    rt.requestedPermissionChanges.set(requestId, `permissions to ${mode}`);
    const sessionScoped = scope === "session"
        && target.supportsHostCapability?.(
                HOST_CAPABILITY_SESSION_SCOPED_STATE,
            ) !== false;
    void target.send({
        type: sessionScoped
            ? "update_session_permission_mode"
            : "update_permissions",
        requestId,
        mode,
    }).catch(((error: unknown) => reportConnectionError(rt, error)));
    showStatusNotice(rt, 
        `permissions → ${mode}${sessionScoped ? "" : " (default too)"}`,
    );
}

export async function applySelectedTheme(rt: TuiRuntime, 
    selectedTheme: typeof rt.themeName,
    announce: boolean,
): Promise<void> {
    if (announce && rt.pendingThemePreview !== undefined) {
        clearTimeout(rt.pendingThemePreview);
        rt.pendingThemePreview = undefined;
    }
    const version = ++rt.themeApplicationVersion;
    const resolvedTheme = await resolveTuiTheme(rt.renderer, selectedTheme);
    if (version !== rt.themeApplicationVersion || rt.shuttingDown) {
        return;
    }
    rt.theme = resolvedTheme;
    applyTuiThemeBindings(rt.theme, rt.themeBindings);

    if (announce) {
        rt.state = appendTuiNotice(
            rt.state,
            `theme changed: ${selectedTheme}`,
            "soft",
            "theme",
        );
    }
    renderState(rt);
}

export function scheduleThemePreview(rt: TuiRuntime, selectedTheme: typeof rt.themeName): void {
    if (rt.pendingThemePreview !== undefined) {
        clearTimeout(rt.pendingThemePreview);
    }
    rt.pendingThemePreview = setTimeout(() => {
        rt.pendingThemePreview = undefined;
        void applySelectedTheme(rt, selectedTheme, false);
    }, 50);
}
