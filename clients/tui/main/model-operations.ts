import { providerCatalogsOf } from "../../../src/host/model-catalog-settings.ts";
import type { ModelOperation } from "../../../src/model/model-operations.ts";
import { verificationResults } from "../model-verification.ts";
import { mergeTuiModelPickerSettings, syncTuiModelPicker } from "../settings-picker.ts";
import { focusedAgentClient } from "./agents-dials.ts";
import { focusActiveSurface } from "./focus-switch.ts";
import { showStatusNotice } from "./notices.ts";
import { renderState } from "./render-state.ts";
import type { TuiRuntime } from "./runtime.ts";

export function runModelOperation(rt: TuiRuntime, operation: ModelOperation): void {
    if (operation.models.length === 0) return;
    const operate = rt.dependencies.operateModels;
    if (operate === undefined) {
        showStatusNotice(rt, "This host does not support model operations.");
        renderState(rt); return;
    }
    const verifying = operation.operation === "verify";
    if (verifying && rt.modelVerification?.running) {
        rt.settingsPicker = verificationResults(rt.modelVerification);
        renderState(rt); focusActiveSurface(rt); return;
    }
    if (verifying) {
        rt.modelVerification = { targets: operation.models, results: [], running: true };
        rt.settingsPicker = verificationResults(rt.modelVerification);
        renderState(rt); focusActiveSurface(rt);
    }
    void operate(operation, (result) => {
        if (verifying && rt.modelVerification !== undefined) {
            rt.modelVerification = { ...rt.modelVerification, results: [...rt.modelVerification.results, result] };
            if (rt.settingsPicker?.kind === "model_verification") rt.settingsPicker = verificationResults(rt.modelVerification);
        } else if (result.status === "failed" || result.reason !== undefined) {
            showStatusNotice(rt, result.reason ?? "Model operation failed.");
            if (rt.settingsPicker?.kind === "model") rt.settingsPicker = { ...rt.settingsPicker, journeyNotice: result.reason };
        }
        renderState(rt);
    }, focusedAgentClient(rt).workspace).then((settings) => {
        if (settings !== undefined) {
            // Home settings carry host defaults; retain the live conversation's pair.
            rt.state = { ...rt.state, modelSettings: mergeTuiModelPickerSettings(rt.state.modelSettings, settings) };
            const sidebar = rt.hostedSidebar.pane?.state;
            if (sidebar !== undefined) sidebar.state = { ...sidebar.state,
                modelSettings: mergeTuiModelPickerSettings(sidebar.state.modelSettings, settings) };
            if (rt.settingsPicker?.kind === "model") rt.settingsPicker = syncTuiModelPicker(rt.settingsPicker, { ...settings, providerCatalogs: providerCatalogsOf(settings) });
        }
    }).catch((error) => {
        const reason = error instanceof Error ? error.message : String(error);
        showStatusNotice(rt, reason);
        if (verifying && rt.modelVerification !== undefined) {
            const run = rt.modelVerification;
            rt.modelVerification = { ...run, results: run.targets.map((target) =>
                run.results.find((row) => row.provider === target.provider && row.model === target.model)
                    ?? { ...target, status: "failed", reason }) };
        }
    })
        .finally(() => {
            if (verifying && rt.modelVerification !== undefined) {
                rt.modelVerification = { ...rt.modelVerification, running: false };
                if (rt.settingsPicker?.kind === "model_verification") rt.settingsPicker = verificationResults(rt.modelVerification);
            }
            renderState(rt);
        });
}
