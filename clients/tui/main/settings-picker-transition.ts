import { applySelectedTheme, beginSessionResume, refreshHomeSessions, developerChangeLabel, formatContextLimit, openCatalogRefreshScopePicker, openPoolVerifyScopePicker, requestCatalogRefresh, requestModelSettingsChange, requestPermissionsChange, requestPoolAdmission, scheduleThemePreview, showStatusNotice, startCatalogRefreshSweep, startPoolVerifySweep, verifyModelInPicker } from "../main.ts";
import { isHomeClient } from "../home-client.ts";
import { focusedAgentClient, modelSettingsForOpenPicker } from "../main/agents-dials.ts";
import { requestAgentSettings } from "../main/diagnostics-ops.ts";
import { sendCommand } from "../main/extension-bridge.ts";
import { focusActiveSurface } from "../main/focus-switch.ts";
import { bindModelAssignmentFromPicker, connectProvider, homeNeedsProvider, isModelShortlisted, modelLevelFacts, modelPickerActionOptions, openConfigureEditor, openModelAssignmentPicker, openProviderEditForm, openProviderPicker, reviewerPatchFor, reviewerToast } from "../main/model-pickers.ts";
import { enterWizardInstallStep, enterWizardModelStep } from "../main/onboarding-wizard-ops.ts";
import { openSettingsMenuTarget } from "../main/palette-jump.ts";
import { finishConfigurationPicker, forgetProvider, openProviderEndpointForm, openRequestOptionsEditor, openSettingsDestination } from "../main/provider-forms.ts";
import { renderState } from "../main/render-state.ts";
import { openNamePrompt } from "../main/workspace-ops.ts";
import { MODEL_ASSIGNMENT_SELF_VALUE, REVIEWER_CLEAR_VALUE, startTuiProviderForm, startTuiReasoningPicker, syncTuiModelPicker, tuiPickerAfterSelection, type TuiExtensionPickerTransition, type TuiSettingsPickerTransition } from "../settings-picker.ts";
import { saveTuiThemePreference } from "../theme-preference.ts";
import type { TuiRuntime } from "./runtime.ts";
import { randomUUID } from "node:crypto";

export function applySettingsPickerTransition(rt: TuiRuntime, 
    transition:
        | TuiSettingsPickerTransition
        | TuiExtensionPickerTransition,
): void {
    const extensionPickerWasOpen = rt.settingsPicker?.kind === "extension";
    const previousPicker = rt.settingsPicker;
    const returningToModelPicker = rt.settingsPicker?.kind !== "model"
        && transition.state?.kind === "model";
    rt.settingsPicker = transition.state;
    if (
        extensionPickerWasOpen
        && transition.selection?.kind === "extension"
    ) {
        const pending = rt.pendingExtensionPicker;
        rt.pendingExtensionPicker = undefined;
        pending?.removeAbortListener();
        pending?.resolve({
            outcome: "selected",
            rowId: transition.selection.rowId,
            actionId: transition.selection.actionId,
        });
        rt.settingsPickerView.box.visible = false;
        focusActiveSurface(rt);
        renderState(rt);
        return;
    } else if (
        extensionPickerWasOpen
        && transition.state === undefined
        && transition.selection === undefined
    ) {
        const pending = rt.pendingExtensionPicker;
        rt.pendingExtensionPicker = undefined;
        pending?.removeAbortListener();
        pending?.resolve({ outcome: "cancelled" });
        rt.settingsPickerView.box.visible = false;
        focusActiveSurface(rt);
        renderState(rt);
        return;
    }
    if (
        rt.activeConfigurationRequest !== undefined
        && previousPicker?.kind === "model_assignment"
        && previousPicker.modelAssignment === "subagents"
        && transition.selection === undefined
        && (
            transition.state === undefined
            || transition.state === previousPicker.parent
        )
    ) {
        finishConfigurationPicker(rt);
        return;
    }
    if (
        "previewTheme" in transition
        && transition.previewTheme !== undefined
    ) {
        scheduleThemePreview(rt, transition.previewTheme);
    }
    if (
        "trashCandidate" in transition
        && transition.trashCandidate !== undefined
    ) {
        rt.sessionTrashCandidate = transition.trashCandidate;
    }
    if (
        "renameCandidate" in transition
        && transition.renameCandidate !== undefined
    ) {
        openNamePrompt(rt, 
            {
                kind: "session",
                sessionId: transition.renameCandidate.sessionId,
            },
            transition.renameCandidate.label,
            previousPicker?.kind === "extension"
                ? undefined
                : previousPicker,
            transition.renameCandidate.value,
        );
        return;
    }
    if (
        "requestOptions" in transition
        && transition.requestOptions !== undefined
        && previousPicker?.kind === "model"
    ) {
        openRequestOptionsEditor(rt, 
            transition.requestOptions,
            previousPicker,
        );
        return;
    }
    if ("openProviders" in transition && transition.openProviders === true) {
        openProviderPicker(rt, 
            rt.settingsPicker?.kind === "model"
                ? rt.settingsPicker
                : previousPicker?.kind === "extension"
                ? undefined
                : previousPicker,
        );
        return;
    }
    if (
        "forgetProvider" in transition
        && transition.forgetProvider !== undefined
    ) {
        forgetProvider(rt, 
            transition.forgetProvider,
            previousPicker?.kind === "provider"
                ? previousPicker.parent
                : undefined,
        );
        return;
    }
    if (
        "editProvider" in transition
        && transition.editProvider !== undefined
    ) {
        openProviderEditForm(rt, 
            transition.editProvider,
            previousPicker?.kind === "provider" ? previousPicker : undefined,
        );
        return;
    }
    if (
        "editEndpoint" in transition
        && transition.editEndpoint !== undefined
    ) {
        openProviderEndpointForm(rt, 
            transition.editEndpoint,
            previousPicker?.kind === "provider" ? previousPicker : undefined,
        );
        return;
    }
    if (
        "declareProvider" in transition
        && transition.declareProvider === true
    ) {
        rt.providerForm = startTuiProviderForm(
            previousPicker?.kind === "provider" ? previousPicker : undefined,
        );
        rt.settingsPicker = undefined;
        rt.composer.blur();
        renderState(rt);
        focusActiveSurface(rt);
        return;
    }
    if (
        "refreshCatalog" in transition
        && transition.refreshCatalog !== undefined
    ) {
        requestCatalogRefresh(rt, transition.refreshCatalog);
        return;
    }
    if (
        "refreshCatalogScope" in transition
        && transition.refreshCatalogScope === true
    ) {
        openCatalogRefreshScopePicker(rt);
        return;
    }
    if ("poolVerifySweep" in transition && transition.poolVerifySweep === true) {
        openPoolVerifyScopePicker(rt);
        return;
    }
    if ("poolVerify" in transition && transition.poolVerify !== undefined) {
        verifyModelInPicker(rt, 
            transition.poolVerify.provider,
            transition.poolVerify.model,
        );
        return;
    }
    if ("poolName" in transition && transition.poolName !== undefined) {
        openNamePrompt(rt, 
            {
                kind: "pool",
                provider: transition.poolName.provider,
                model: transition.poolName.model,
            },
            transition.poolName.label,
            previousPicker?.kind === "extension" ? undefined : previousPicker,
        );
        return;
    }
    if ("poolMove" in transition && transition.poolMove !== undefined) {
        const move = transition.poolMove;
        sendCommand(rt, {
            type: "pool_move",
            requestId: randomUUID(),
            provider: move.provider,
            model: move.model,
            delta: move.delta,
        });
        return;
    }
    if ("poolToggle" in transition && transition.poolToggle !== undefined) {
        const toggle = transition.poolToggle;
        rt.poolChangeUndo = undefined;
        if (rt.settingsPicker?.kind === "model") {
            rt.settingsPicker = {
                ...rt.settingsPicker,
                canUndoPoolChange: false,
            };
        }
        if (toggle.action === "add") {
            const pickerSettings = modelSettingsForOpenPicker(rt, 
                rt.state.modelSettings,
            );
            if (
                isModelShortlisted(rt, 
                    pickerSettings,
                    toggle.provider,
                    toggle.model,
                )
            ) {
                if (rt.settingsPicker?.kind === "model") {
                    rt.settingsPicker = syncTuiModelPicker(
                        rt.settingsPicker,
                        {
                            ...(pickerSettings ?? {}),
                            actionOptions: modelPickerActionOptions(rt, 
                                pickerSettings,
                            ),
                        },
                    );
                }
                showStatusNotice(rt, 
                    `${toggle.provider}/${toggle.model} is already shortlisted`,
                );
                renderState(rt);
                return;
            }
            const requestId = requestPoolAdmission(rt, 
                toggle.provider,
                toggle.model,
            );
            rt.pendingPoolName = {
                requestId,
                provider: toggle.provider,
                model: toggle.model,
                label: `${toggle.provider}/${toggle.model}`,
            };
            rt.pendingPoolChanges.set(requestId, {
                action: "remove",
                provider: toggle.provider,
                model: toggle.model,
            });
            return;
        }
        const removed = rt.state.modelSettings?.pooled?.find((entry) =>
            entry.provider === toggle.provider
            && entry.model === toggle.model
        );
        const requestId = randomUUID();
        rt.pendingPoolChanges.set(requestId, {
            action: "add",
            provider: toggle.provider,
            model: toggle.model,
            ...(removed?.poolName === undefined
                ? {}
                : { poolName: removed.poolName }),
        });
        sendCommand(rt, {
            type: "pool_remove",
            requestId,
            provider: toggle.provider,
            model: toggle.model,
        });
    }
    if (
        "undoPoolChange" in transition
        && transition.undoPoolChange === true
        && rt.poolChangeUndo !== undefined
    ) {
        const undo = rt.poolChangeUndo;
        if (rt.settingsPicker?.kind === "model") {
            rt.settingsPicker = {
                ...rt.settingsPicker,
                canUndoPoolChange: false,
            };
        }
        if (undo.action === "remove") {
            const requestId = randomUUID();
            rt.pendingPoolUndos.set(requestId, {
                undo,
                completesOnSettings: true,
            });
            sendCommand(rt, {
                type: "pool_remove",
                requestId,
                provider: undo.provider,
                model: undo.model,
            });
        } else {
            const requestId = requestPoolAdmission(rt, 
                undo.provider,
                undo.model,
            );
            rt.pendingPoolUndos.set(requestId, {
                undo,
                completesOnSettings: undo.poolName === undefined,
            });
        }
        return;
    }
    if (transition.selection !== undefined) {
        const selection = transition.selection;
        if (selection.kind === "extension") {
            return;
        }
        if (selection.kind === "configure") {
            closeSettingsPickerSurface(rt);
            renderState(rt);
            void openConfigureEditor(rt, selection.file);
            return;
        }
        if (selection.kind === "model") {
            const chosenLevels = selection.reasoningEffort === undefined
                ? modelLevelFacts(rt, selection.provider, selection.model)
                : undefined;
            if (
                chosenLevels !== undefined
                && chosenLevels.levels.length > 0
                && previousPicker?.kind === "model"
            ) {
                rt.settingsPicker = startTuiReasoningPicker(
                    chosenLevels.levels,
                    chosenLevels.defaultLevel,
                    rt.state.modelSettings?.reasoningEffort,
                    {
                        provider: selection.provider,
                        model: selection.model,
                        modelPaneState: previousPicker,
                    },
                );
                rt.composer.blur();
                rt.settingsPickerView.update(rt.settingsPicker);
                rt.settingsPickerView.focus();
                renderState(rt);
                return;
            }
            const chosen = selection.reasoningEffort === undefined
                ? `${selection.provider}/${selection.model}`
                : `${selection.provider}/${selection.model} (${selection.reasoningEffort})`;
            requestModelSettingsChange(rt, 
                {
                    provider: selection.provider,
                    model: selection.model,
                    ...(selection.reasoningEffort === undefined
                        ? {}
                        : { reasoningEffort: selection.reasoningEffort }),
                },
                `model → ${chosen}`,
                `the model to ${chosen}`,
                rt.settingsPickerAgent,
            );
        } else if (selection.kind === "provider") {
            const asked = connectProvider(rt, 
                selection.providerId,
                previousPicker?.kind === "extension"
                    ? undefined
                    : previousPicker,
            );
            // A provider that needs no credential has cleared the key gate by
            // being chosen, so an unfinished flow carries on to the model step
            // rather than stopping on the notice.
            if (asked === "install") {
                enterWizardInstallStep(rt, selection.providerId);
            } else if (asked === "none" && homeNeedsProvider(rt)) {
                enterWizardModelStep(rt, selection.providerId);
            }
            return;
        } else if (selection.kind === "reasoning") {
            requestModelSettingsChange(rt, 
                { reasoningEffort: selection.reasoningEffort },
                `reasoning → ${selection.reasoningEffort}`,
                `reasoning to ${selection.reasoningEffort}`,
                rt.settingsPickerAgent,
            );
        } else if (selection.kind === "permissions") {
            if (selection.mode === "full_access") {
                rt.confirmingFullAccess = true;
                rt.confirmingFullAccessAgent = rt.settingsPickerAgent;
            } else {
                requestPermissionsChange(rt, 
                    selection.mode,
                    rt.settingsPickerAgent,
                );
            }
        } else if (selection.kind === "theme") {
            rt.themeName = selection.theme;
            saveTuiThemePreference(rt.themeName);
            void applySelectedTheme(rt, rt.themeName, true);
        } else if (selection.kind === "context_limit") {
            const label = selection.limit === null
                ? "Auto"
                : formatContextLimit(rt, selection.limit);
            requestModelSettingsChange(rt, 
                { contextLimit: selection.limit },
                `context limit → ${label}`,
                `context limit to ${label}`,
                rt.settingsPickerAgent,
            );
        } else if (selection.kind === "developer") {
            requestModelSettingsChange(rt, 
                { developer: selection.patch },
                developerChangeLabel(selection.patch),
                developerChangeLabel(selection.patch),
                rt.settingsPickerAgent,
            );
        } else if (selection.kind === "menu") {
            rt.settingsPicker = undefined;
            openSettingsMenuTarget(rt, 
                selection.target,
                previousPicker?.kind === "extension"
                    ? undefined
                    : previousPicker,
            );
            return;
        } else if (selection.kind === "reviewer") {
            const patch = reviewerPatchFor(rt, selection);
            if (patch === undefined) {
                showStatusNotice(rt, "Choose a primary classifier first");
            } else {
                requestModelSettingsChange(rt, 
                    { reviewer: patch },
                    `classifier → ${reviewerToast(rt, selection)}`,
                    `the ${selection.slot === "primary"
                        ? "classifier"
                        : "failsafe classifier"}`,
                    rt.settingsPickerAgent,
                );
            }
        } else if (selection.kind === "pool_verify_scope") {
            startPoolVerifySweep(rt, selection.onlyUnverified);
            return;
        } else if (selection.kind === "catalog_refresh_scope") {
            startCatalogRefreshSweep(rt, selection.providers);
            return;
        } else if (selection.kind === "model_assignment_browse") {
            openSettingsDestination(rt, { kind: "model_shortlist" });
            return;
        } else if (selection.kind === "model_assignment_open") {
            openSettingsDestination(rt, 
                {
                    kind: "model_assignment",
                    assignment: selection.assignment,
                },
                {
                    parent: previousPicker?.kind === "extension"
                        ? undefined
                        : previousPicker,
                },
            );
            return;
        } else if (selection.kind === "model_assignment") {
            const assignedLevels = selection.model === undefined
                || selection.remove === true
                || selection.reasoningEffort !== undefined
                || selection.acceptDefaultReasoning === true
                ? undefined
                : modelLevelFacts(rt, selection.provider, selection.model);
            if (
                assignedLevels !== undefined
                && assignedLevels.levels.length > 0
                && previousPicker?.kind === "model_assignment"
            ) {
                rt.settingsPicker = startTuiReasoningPicker(
                    assignedLevels.levels,
                    assignedLevels.defaultLevel,
                    undefined,
                    {
                        provider: selection.provider as string,
                        model: selection.model as string,
                        modelPaneState: previousPicker,
                        assignment: selection.assignment,
                    },
                );
                rt.composer.blur();
                rt.settingsPickerView.update(rt.settingsPicker);
                rt.settingsPickerView.focus();
                renderState(rt);
                return;
            }
            const bindingError = bindModelAssignmentFromPicker(rt, selection);
            if (bindingError !== undefined) {
                rt.settingsPicker = previousPicker?.kind === "model_assignment"
                    ? { ...previousPicker, subtitle: bindingError }
                    : previousPicker;
                showStatusNotice(rt, bindingError);
                renderState(rt);
                focusActiveSurface(rt);
                return;
            }
            if (selection.assignment === "subagents") {
                const assignmentPane = previousPicker?.kind
                        === "model_assignment"
                    ? previousPicker
                    : previousPicker !== undefined
                            && "pendingModel" in previousPicker
                            && previousPicker.pendingModel?.modelPaneState.kind
                            === "model_assignment"
                    ? previousPicker.pendingModel.modelPaneState
                    : undefined;
                const selectedValue = selection.allowSelf !== undefined
                    ? MODEL_ASSIGNMENT_SELF_VALUE
                    : selection.clear === true
                    ? REVIEWER_CLEAR_VALUE
                    : selection.model === undefined
                    ? undefined
                    : `${selection.provider ?? ""}/${selection.model}`;
                openModelAssignmentPicker(rt, 
                    "subagents",
                    assignmentPane?.parent,
                    selectedValue,
                );
                return;
            }
        } else {
            beginSessionResume(rt, 
                selection.sessionPath,
                selection.sessionId,
                false,
                false,
                selection.sourceDisposition,
                "attach",
            );
            return;
        }
        rt.settingsPicker = rt.confirmingFullAccess
                || previousPicker?.kind === "extension"
            ? undefined
            : tuiPickerAfterSelection(selection, previousPicker);
    }
    if (rt.sessionTrashCandidate !== undefined) {
        rt.composer.blur();
        rt.sessionTrashConfirmView.update(rt.sessionTrashCandidate.label);
        rt.sessionTrashConfirmView.box.focus();
    } else if (rt.providerForgetCandidate !== undefined) {
        rt.composer.blur();
        rt.providerForgetConfirmView.update(rt.providerForgetCandidate.label);
        rt.providerForgetConfirmView.box.focus();
    } else if (rt.settingsPicker === undefined) {
        closeSettingsPickerSurface(rt);
    } else {
        rt.composer.blur();
        rt.settingsPickerView.update(rt.settingsPicker);
        rt.settingsPickerView.focus();
    }
    if (returningToModelPicker) {
        requestAgentSettings(rt, focusedAgentClient(rt));
    }
    renderState(rt);
}

export function closeSettingsPickerSurface(rt: TuiRuntime): void {
    rt.settingsPickerView.box.visible = false;
    rt.settingsPickerAgent = undefined;
    if (rt.pendingUiRequest === undefined) {
        rt.composer.focus();
    }
    // A picker is where a provider gets connected, so the cold card may no
    // longer be cold once one closes.
    if (isHomeClient(rt.client)) {
        void refreshHomeSessions(rt);
    }
}
