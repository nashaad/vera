import { applySelectedTheme, beginSessionResume, developerChangeLabel, formatContextLimit, openCatalogRefreshScopePicker, openPoolVerifyScopePicker, requestCatalogRefresh, requestModelSettingsChange, requestPermissionsChange, requestPoolAdmission, scheduleThemePreview, showStatusNotice, startCatalogRefreshSweep, startPoolVerifySweep, verifyModelInPicker } from "../main.ts";
import { focusedAgentClient, modelSettingsForOpenPicker } from "../main/agents-dials.ts";
import { requestAgentSettings } from "../main/diagnostics-ops.ts";
import { sendCommand } from "../main/extension-bridge.ts";
import { focusActiveSurface } from "../main/focus-switch.ts";
import { bindModelAssignmentFromPicker, connectProvider, isModelShortlisted, modelLevelFacts, modelPickerActionOptions, openConfigureEditor, openModelAssignmentPicker, openProviderEditForm, openProviderPicker, reviewerPatchFor, reviewerToast } from "../main/model-pickers.ts";
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
    // Captured before the reassignment below so a model selection that
    // needs to chain into a level pane can hand the model pane back to
    // Escape: `handleTuiSettingsPickerKey` returns no `state` on Enter,
    // so this is the only place that still has it.
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
        // The model pane stays underneath: connecting a provider is a
        // detour on the way to picking a model, not a change of subject.
        // The pane it returns to is the one the transition left behind, not
        // the one the key arrived on: ⇥ onto Providers wraps the list back
        // to its first tab, and Escape has to land on that.
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
        // The chord names a row, and a row names one provider, so it asks
        // that one. Choosing which providers to ask is what the More page
        // action is for.
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
        // Same rule as the toggle: the pane is rebuilt from the snapshot
        // that comes back, not from a guess about where the row landed.
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
        // The pane stays open and stays on the same row. It is not updated
        // here: the settings snapshot that comes back rebuilds it, so what
        // the user sees is what the host stored rather than a guess.
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
            // The name prompt follows the verdict, not the keypress: a
            // model that never made it into the pool cannot be named.
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
            // Choosing a model runs it and nothing else. The pool is the
            // user's own shortlist, so it is only ever written by the key
            // that says so.
            const chosenLevels = selection.reasoningEffort === undefined
                ? modelLevelFacts(rt, selection.provider, selection.model)
                : undefined;
            if (
                chosenLevels !== undefined
                && chosenLevels.levels.length > 0
                && previousPicker?.kind === "model"
            ) {
                // A model with levels opens the level pane instead of
                // closing: Enter there folds both choices into one patch.
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
            connectProvider(rt, 
                selection.providerId,
                previousPicker?.kind === "extension"
                    ? undefined
                    : previousPicker,
            );
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
            // A menu row opens the next surface over this one, which stays
            // remembered as its parent so leaving comes back here.
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
            // Keeping a model is what makes it available as a default, so
            // the row that says so lands on the collection it is kept in
            // rather than leaving the user to find it.
            openSettingsDestination(rt, { kind: "model_shortlist" });
            return;
        } else if (selection.kind === "model_assignment_open") {
            // The pane the row was chosen on, which Enter has already
            // cleared from `settingsPicker`: without it Escape closes the
            // card instead of stepping back to the list.
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
            // A model with levels asks for one before the write, the same
            // chain the session's own model goes through: an assignment
            // that named a model but no level would run the provider's
            // default rather than the one the user meant.
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
                // The request is still waiting and the setting did not
                // change, so keep the picker retryable and make the
                // terminal failure visible outside its card.
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
            // Picking a session from the list is where the person meant
            // to go, not a hop taken to answer something: there is no trip
            // to offer them back from.
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
        // Where the stack goes next is `tuiPickerAfterSelection`'s rule.
        // A confirmation overrides it: it is its own modal level, and the
        // menu would sit open behind it.
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
}
