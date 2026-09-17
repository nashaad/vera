import { beginCreateSession, currentDraft } from "./session-ops.ts";
import { runModelOperation } from "./model-operations.ts";
import { currentModelAssignmentRows } from "./model-pickers.ts";
import { applySelectedTheme, beginSessionResume, refreshHomeSessions, overrideChangeLabel, formatContextLimit, openCatalogRefreshScopePicker, openPoolVerifyScopePicker, requestCatalogRefresh, requestModelSettingsChange, requestPermissionsChange, requestPoolAdmission, scheduleThemePreview, showStatusNotice, startCatalogRefreshSweep, startPoolVerifySweep, verifyModelInPicker } from "../main.ts";
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
import { saveTuiThemePreference, saveModelPickerPreferences } from "../theme-preference.ts";
import type { TuiRuntime } from "./runtime.ts";
import { overrideConflict } from "../../../src/engine/override-rows.ts";
import { tuiOverridesResetLevers } from "../overrides-reset-confirm.ts";
import { randomUUID } from "node:crypto";
import { eligibleForDefault } from "../../../src/model/model-operations.ts";
import { loadPoolFile } from "../../../src/model/pool-file-loader.ts";

export function applySettingsPickerTransition(rt: TuiRuntime, 
    transition:
        | TuiSettingsPickerTransition
        | TuiExtensionPickerTransition,
): void {
    const extensionPickerWasOpen = rt.settingsPicker?.kind === "extension";
    const previousPicker = rt.settingsPicker;
    const providerParent = previousPicker?.kind === "provider_actions" || previousPicker?.kind === "provider"
        ? previousPicker : undefined;
    const returningToModelPicker = rt.settingsPicker?.kind !== "model"
        && transition.state?.kind === "model";
    rt.settingsPicker = transition.state;
    if (rt.settingsPicker?.kind === "model" && rt.settingsPicker.modelJourney === "switch"
        && (previousPicker?.kind === "model_menu"
            || previousPicker?.kind === "model" && previousPicker.tab !== rt.settingsPicker.tab)) {
        try {
            saveModelPickerPreferences({ view: rt.settingsPicker.journeyView ?? "standard",
                scope: rt.settingsPicker.tab === "all" ? "all" : "pool", sort: rt.settingsPicker.journeySort ?? "library" });
        } catch (error) {
            showStatusNotice(rt, `Could not save model picker preferences: ${String(error)}`);
        }
    }
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
        rt.settingsPickerView.surface.visible = false;
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
        rt.settingsPickerView.surface.visible = false;
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
            providerParent,
        );
        return;
    }
    if (
        "editEndpoint" in transition
        && transition.editEndpoint !== undefined
    ) {
        openProviderEndpointForm(rt, 
            transition.editEndpoint,
            providerParent,
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
            previousPicker?.kind === "model" && previousPicker.modelJourney === "shortlist" ? transition.poolName.label : undefined,
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
    if ("refreshAllCatalogs" in transition && transition.refreshAllCatalogs) {
        startCatalogRefreshSweep(rt, previousPicker?.kind === "provider"
            ? previousPicker.allOptions.filter((row) => row.refreshable === true).map((row) => row.value)
            : []);
        return;
    }
    if ("poolBulk" in transition && transition.poolBulk !== undefined) {
        const bulk = transition.poolBulk;
        const bound = currentModelAssignmentRows(rt).filter((slot) => slot.declared.some((entry) =>
            bulk.models.some((model) => model.provider === entry.provider && model.model === entry.model)));
        if (bulk.action === "remove" && bound.length > 0) {
            openRemovalRecovery(rt, bound);
            renderState(rt);
            return;
        }
        runModelOperation(rt, { operation: bulk.action === "add" ? "keep" : "unkeep", models: bulk.models.flatMap((model) =>
            model.provider === undefined || model.model === undefined ? [] : [{ provider: model.provider, model: model.model }]) });
        return;
    }
    if ("poolToggle" in transition && transition.poolToggle !== undefined) {
        const toggle = transition.poolToggle;
        const bound = currentModelAssignmentRows(rt).filter((slot) => slot.declared.some((entry) =>
            entry.provider === toggle.provider && entry.model === toggle.model));
        if (toggle.action === "remove" && bound.length > 0) {
            openRemovalRecovery(rt, bound);
            renderState(rt);
            return;
        }
        // The More menu hands the toggle back with the journey as its next
        // state, so the journey path is chosen on where the toggle lands.
        const journey = (previousPicker?.kind === "model" && previousPicker.modelJourney !== undefined)
            || (transition.state?.kind === "model" && transition.state.modelJourney !== undefined);
        if (journey) {
            runModelOperation(rt, { operation: toggle.action === "add" ? "keep" : "unkeep",
                models: [{ provider: toggle.provider, model: toggle.model }] });
            return;
        }
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
                    `${toggle.provider}/${toggle.model} is already in your library`,
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
        const switchPane = previousPicker?.kind === "model" && previousPicker.modelJourney === "switch"
            ? previousPicker
            : previousPicker?.kind === "reasoning" && previousPicker.pendingModel?.modelPaneState.modelJourney === "switch"
            ? previousPicker.pendingModel.modelPaneState
            : undefined;
        if (selection.kind === "model" && switchPane !== undefined) {
            const levels = selection.reasoningEffort === undefined
                ? modelLevelFacts(rt, selection.provider, selection.model)
                : undefined;
            if (levels !== undefined && levels.levels.length > 0) {
                rt.settingsPicker = startTuiReasoningPicker(levels.levels, levels.defaultLevel,
                    rt.state.modelSettings?.reasoningEffort,
                    { provider: selection.provider, model: selection.model, modelPaneState: switchPane });
                rt.composer.blur();
                rt.settingsPickerView.update(rt.settingsPicker);
                rt.settingsPickerView.focus();
                renderState(rt);
                return;
            }
            const target = rt.settingsPickerAgent ?? focusedAgentClient(rt);
            const apply = () => {
                const client = isHomeClient(target) ? focusedAgentClient(rt) : target;
                void client.send({ type: "update_session_model_settings", requestId: randomUUID(),
                    patch: { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort ?? null } })
                    .catch((error) => { showStatusNotice(rt, String(error)); renderState(rt); });
                const chosen = selection.reasoningEffort === undefined ? selection.model : `${selection.model} (${selection.reasoningEffort})`;
                showStatusNotice(rt, `${chosen}. Applies to the next request. Not added to the library.`);
                renderState(rt);
            };
            if (isHomeClient(target)) {
                const draft = currentDraft(rt);
                beginCreateSession(rt, "stop", () => draft, apply);
            } else apply();
        } else if (selection.kind === "model") {
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
                providerParent ?? (previousPicker?.kind === "extension"
                    ? undefined
                    : previousPicker),
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
        } else if (selection.kind === "overrides") {
            // A reset drops every lever at once, which no rule can refuse.
            const valuePane = previousPicker?.kind === "override_value"
                ? previousPicker
                : undefined;
            const refusal = valuePane === undefined || selection.patch === null
                ? undefined
                : overrideConflict(
                    valuePane.overrides?.rows ?? [],
                    selection.patch,
                );
            if (valuePane !== undefined && refusal !== undefined) {
                // The pane stays open on the value that was turned down. A
                // status notice would say this behind the picker covering it,
                // and the user is looking at the list they must pick from.
                rt.settingsPicker = valuePane;
                rt.pickerTipKind = valuePane.kind;
                rt.settingsPickerView.tip = { tone: "refusal", text: refusal };
                rt.composer.blur();
                rt.settingsPickerView.update(valuePane);
                rt.settingsPickerView.focus();
                renderState(rt);
                return;
            }
            const clearing = selection.patch === null
                ? tuiOverridesResetLevers(
                    previousPicker?.kind === "overrides_settings"
                        ? previousPicker.overrides?.rows ?? []
                        : [],
                )
                : [];
            if (clearing.length > 0) {
                // Nothing is written until the answer comes back. The pane
                // behind stays as it was, so cancelling leaves no trace.
                rt.overridesResetCandidate = clearing;
            } else {
                requestModelSettingsChange(rt, 
                    { overrides: selection.patch },
                    overrideChangeLabel(selection.patch),
                    overrideChangeLabel(selection.patch),
                    rt.settingsPickerAgent,
                );
            }
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
            startPoolVerifySweep(rt, selection.onlyUnverified, selection.provider);
            return;
        } else if (selection.kind === "catalog_refresh_scope") {
            startCatalogRefreshSweep(rt, selection.providers);
            return;
        } else if (selection.kind === "model_shortlist_open"
            || selection.kind === "model_defaults_open") {
            openSettingsDestination(rt, {
                kind: selection.kind === "model_shortlist_open"
                    ? "model_shortlist" : "model_assignments",
            }, {
                ...(rt.settingsPicker?.kind === "model"
                    ? { parent: rt.settingsPicker } : {}),
            });
            return;
        } else if (selection.kind === "model_assignment_browse") {
            openSettingsDestination(rt, { kind: "model_shortlist" }, {
                parent: previousPicker?.kind === "extension" ? undefined : previousPicker,
            });
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
            if (selection.model !== undefined && selection.provider !== undefined
                && selection.remove !== true && selection.clear !== true && selection.allowSelf === undefined
                && !eligibleForDefault(loadPoolFile({ projectRoot: process.cwd() }).merged, { provider: selection.provider, model: selection.model })) {
                const operate = rt.dependencies.operateModels;
                if (operate === undefined || previousPicker === undefined || previousPicker.kind === "extension") {
                    rt.settingsPicker = previousPicker;
                    showStatusNotice(rt, "Verification is unavailable. The default was not changed.");
                    renderState(rt); return;
                }
                const pending = { ...previousPicker, loading: true, subtitle: "Verifying model before assignment. Esc cancels assignment." };
                rt.settingsPicker = pending;
                renderState(rt); focusActiveSurface(rt);
                let passed = false;
                let reason = "Verification failed. The default was not changed.";
                void operate({ operation: "verify", models: [{ provider: selection.provider, model: selection.model }] }, (result) => {
                    passed = result.status === "passed";
                    reason = result.reason?.trim() || reason;
                }, focusedAgentClient(rt).workspace).then(() => {
                    if (rt.settingsPicker !== pending) return;
                    rt.settingsPicker = previousPicker;
                    if (passed && eligibleForDefault(loadPoolFile({ projectRoot: process.cwd() }).merged, { provider: selection.provider!, model: selection.model! })) applySettingsPickerTransition(rt, transition);
                    else {
                        if (passed) reason = "Verification could not be confirmed or the model is not permitted. The default was not changed.";
                        rt.settingsPicker = { ...previousPicker, subtitle: reason };
                        showStatusNotice(rt, reason); renderState(rt); focusActiveSurface(rt);
                    }
                }).catch((error) => {
                    if (rt.settingsPicker !== pending) return;
                    rt.settingsPicker = { ...previousPicker, subtitle: `Verification failed: ${String(error)}` };
                    renderState(rt); focusActiveSurface(rt);
                });
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
        } else if (selection.kind === "session") {
            beginSessionResume(rt, 
                selection.sessionPath,
                selection.sessionId,
                false,
                false,
                selection.sourceDisposition,
                "attach",
            );
            return;
        } else if (selection.kind === "session_create_leave") {
            closeSettingsPickerSurface(rt);
            beginCreateSession(rt, selection.sourceDisposition);
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
        rt.providerForgetConfirmView.update(rt.providerForgetCandidate.label, (rt.state.modelSettings?.pooled ?? []).filter((row) => row.provider === rt.providerForgetCandidate?.providerId).length);
        rt.providerForgetConfirmView.box.focus();
    } else if (rt.overridesResetCandidate !== undefined) {
        rt.composer.blur();
        rt.overridesResetConfirmView.update(rt.overridesResetCandidate);
        rt.overridesResetConfirmView.box.focus();
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

/** The reset was confirmed: clear every lever the card named. The pane behind the card stays open, and the cleared rows arrive on it. */
export function applyOverridesReset(rt: TuiRuntime): void {
    rt.overridesResetCandidate = undefined;
    requestModelSettingsChange(
        rt,
        { overrides: null },
        overrideChangeLabel(null),
        overrideChangeLabel(null),
        rt.settingsPickerAgent,
    );
    focusActiveSurface(rt);
    renderState(rt);
}

export function closeSettingsPickerSurface(rt: TuiRuntime): void {
    rt.settingsPickerView.surface.visible = false;
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

function openRemovalRecovery(rt: TuiRuntime, bound: ReturnType<typeof currentModelAssignmentRows>): void {
    const parent = rt.settingsPicker?.kind === "model" ? rt.settingsPicker : undefined;
    const options = bound.map((slot) => ({ value: slot.assignment, label: `Reassign ${slot.label}`,
        description: slot.declared.map((model) => `${model.provider}/${model.model}`).join(", ") }));
    rt.settingsPicker = { kind: "model_defaults", title: "Cannot remove a bound model", subtitle:
        `Bound to ${bound.map((slot) => slot.label).join(", ")}. Reassign a slot below, or Esc to cancel. Nothing was removed.`,
        query: "", selectedIndex: 0, allOptions: options, options, parent };
    focusActiveSurface(rt);
}
