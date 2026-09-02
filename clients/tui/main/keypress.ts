import { isToolApprovalUiRequestUpdate, isUserQuestionUiRequestUpdate } from "../../../src/engine/protocol.ts";
import { handleTuiAdmissionDialogKey } from "../admission-dialog.ts";
import { handleTuiCommandPaletteKey } from "../command-palette.ts";
import { tuiArgumentCompletion, tuiWithArgument } from "../commands.ts";
import { composeSuggesterDismissalKey } from "../compose-suggester.ts";
import { handleTuiDiagnosticsDialogKey } from "../diagnostics-dialog.ts";
import { handleDialStripKey } from "../dials.ts";
import { handleTuiHelpKey } from "../help.ts";
import { isHomeClient } from "../home-client.ts";
import { handleHomeKey, homeTypedCharacter } from "../home-screen.ts";
import { parseRawInputEvent, tuiInterruptAction } from "../interrupt.ts";
import { isJsonlViewClient } from "../jsonl-view-client.ts";
import { handleJumpMenuKey } from "../jump.ts";
import { activeTuiKeymap, isTuiComposerClearKey, tuiBindingId, tuiChord, tuiComposerWordDeleteDirection } from "../keymap.ts";
import { DOUBLE_ESCAPE_REWIND_WINDOW_MS, abortProviderHealthCheck, activeCompletion, activeComposeSuggester, activeFlightSurface, activeOverlayFocus, anyOverlayOpen, applyProviderFormTransition, applyRequestOptionsEditorTransition, applySecretPromptTransition, applySessionRenamePromptTransition, applySettingsPickerTransition, applyTimelineTransition, availableCommandCompletion, availableCommandSuggestions, beginCreateSession, beginParkToJsonl, beginSessionTrash, closeAdmissionDialog, closeJumpMenu, closeWorkspaceSidebar, cycleLiveSession, diagnosticsSnapshot, dialogAdmission, focusActiveSurface, focusWorkspaceSidebar, forgetProviderCredential, leaveJsonlCommandMode, openCommandPalette, openJumpMenuOverlay, openModelPicker, openResumePicker, openSearchOverlay, openWorkspaceSidebar, renderCommandSuggestions, renderDiagnostics, renderJumpMenu, renderJumpToBottom, renderState, renderStatus, reportConnectionError, requestCloseSession, requestPermissionsChange, requestPoolAdmission, resumeJsonlView, returnToHome, runHomeAction, runJumpTo, runPaletteAction, runSearchOverlayAction, runWorkTabAction, runWorkspaceSidebarAction, sendCommand, showStatusNotice, startProviderHealthCheck, submitPrompt, verificationConsoleRows } from "../main.ts";
import { abortFocusedAgent, closeDials, commitDials, composerIsAtLeftBoundary, focusedAbortRequested, focusedAgentCanAbort, focusedAgentClient, focusedAgentState, focusedUiRequest, openDials, releaseFocusedQueuedPrompts, startAutoModeAnimation, stopAutoModeAnimation, selectAgent } from "../main/agents-dials.ts";
import { adoptStandingNudgesState, toggleMainHeader, toggleSidebarHeader } from "../main/chrome.ts";
import { renderSidebarAgent } from "../main/sidebar-pane.ts";
import { handleTuiPermissionsConfirmKey } from "../permissions-confirm.ts";
import { handleTuiPreferencesListKey } from "../preferences-list.ts";
import { handleTuiProviderForgetConfirmKey } from "../provider-forget-confirm.ts";
import { jsonlViewKeyAction } from "../resume-overlay.ts";
import { handleSearchOverlayKey, updateSearchOverlayText } from "../search-overlay.ts";
import { handleTuiSecretPromptKey } from "../secret-prompt.ts";
import { handleTuiSessionCloseConfirmKey } from "../session-close-confirm.ts";
import { handleTuiSessionTrashConfirmKey } from "../session-trash-confirm.ts";
import { handleTuiSettingsPickerKey, tuiPickerViewportRows, type TuiExtensionPickerTransition, type TuiSettingsPickerTransition } from "../settings-picker.ts";
import { applyExtensionsListKey } from "./extensions-ops.ts";
import { handleTuiStandingNudgesKey } from "../standing-nudges.ts";
import { appendTuiNotice, toggleTuiThinking, toggleTuiToolDetails } from "../state.ts";
import { handleTuiTimelineKey, startTuiTimelinePicker } from "../timeline-picker.ts";
import { handleWorkTabKey } from "../work-tab.ts";
import { handleWorkspaceSidebarKey } from "../workspace-sidebar.ts";
import type { TuiRuntime } from "./runtime.ts";
import type { KeyEvent } from "@opentui/core";
import { randomUUID } from "node:crypto";

export function applyTranscriptScroll(rt: TuiRuntime, binding: string | undefined): boolean {
    const scrollLines = binding === "scroll_line_up"
        ? -1
        : binding === "scroll_line_down"
        ? 1
        : binding === "scroll_half_page_up"
        ? -Math.max(1, Math.floor(rt.transcript.viewport.height / 2))
        : binding === "scroll_half_page_down"
        ? Math.max(1, Math.floor(rt.transcript.viewport.height / 2))
        : undefined;
    if (binding !== "jump_to_bottom" && scrollLines === undefined) {
        return false;
    }
    if (scrollLines === undefined) {
        rt.transcript.scrollTo(rt.transcript.scrollHeight);
    } else {
        rt.transcript.scrollBy(scrollLines);
    }
    renderJumpToBottom(rt, scrollLines === undefined);
    return true;
}

export function handleKeypress(rt: TuiRuntime, key: KeyEvent): void {
    const inputAt = Date.now();
    if (inputAt - rt.lastInputRecordAt >= 250) {
        rt.lastInputRecordAt = inputAt;
        rt.flightRecorder?.record({
            type: "raw_input_received",
            surface: activeFlightSurface(rt),
            control: key.ctrl || key.meta || key.super || key.hyper,
        });
        queueMicrotask(() => {
            if (rt.shuttingDown) return;
            rt.flightRecorder?.record({
                type: "composer_observed",
                characters: Array.from(rt.composer.expandedText()).length,
                surface: activeFlightSurface(rt),
            });
        });
    }
    const previousIdleEscapeAt = rt.lastIdleEscapeAt;
    rt.lastIdleEscapeAt = undefined;
    if (
        isJsonlViewClient(rt.client)
        && rt.jsonlCommandMode
        && key.name === "escape"
        && !key.ctrl
        && !key.shift
        && !key.meta
        && !key.super
        && !key.hyper
    ) {
        key.preventDefault();
        key.stopPropagation();
        leaveJsonlCommandMode(rt);
        return;
    }
    if (
        isHomeClient(rt.client)
        && rt.sessionSwitchPending
        && rt.homeTypedText !== undefined
        && parseRawInputEvent(key)?.type !== "interrupt"
    ) {
        const typed = homeTypedCharacter(key);
        if (typed !== undefined || key.name === "backspace") {
            rt.homeTypedText = typed === undefined
                ? rt.homeTypedText.slice(0, -1)
                : rt.homeTypedText + typed;
            key.preventDefault();
            key.stopPropagation();
            return;
        }
        if (
            (key.name === "return" || key.name === "enter")
            && !key.ctrl && !key.meta && !key.shift && !key.super
            && !key.hyper
        ) {
            rt.homeSubmitPending = true;
            key.preventDefault();
            key.stopPropagation();
            return;
        }
    }
    if (
        isHomeClient(rt.client)
        && !rt.sessionSwitchPending
        && !rt.commandPaletteView.surface.visible
        && !anyOverlayOpen(rt)
        && !(rt.workspaceSidebarFocused && rt.workspaceSidebar !== undefined)
        && parseRawInputEvent(key)?.type !== "interrupt"
    ) {
        const transition = handleHomeKey(rt.homeState, key);
        if (transition.handled) {
            key.preventDefault();
            key.stopPropagation();
            if (transition.state !== undefined) {
                rt.homeState = transition.state;
                rt.homeView.update(rt.homeState);
                rt.renderer.requestRender();
            }
            if (transition.action !== undefined) {
                runHomeAction(rt, transition.action);
            }
            return;
        }
    }
    if (
        isJsonlViewClient(rt.client)
        && !rt.jsonlCommandMode
        && !rt.commandPaletteView.surface.visible
        && !anyOverlayOpen(rt)
        && parseRawInputEvent(key)?.type !== "interrupt"
    ) {
        const jsonlAction = jsonlViewKeyAction(key, {
            conversationBinding: tuiBindingId("conversation", key),
            globalBinding: tuiBindingId("global", key),
            workspaceBinding: tuiBindingId("workspace", key),
            sidebarFocused: rt.workspaceSidebarFocused
                && rt.workspaceSidebar !== undefined,
            sidebarVisible: rt.workspaceSidebar !== undefined,
        });
        if (jsonlAction === "scroll") {
            key.preventDefault();
            key.stopPropagation();
            applyTranscriptScroll(rt, tuiBindingId("conversation", key));
            return;
        }
        if (jsonlAction === "resume") {
            key.preventDefault();
            key.stopPropagation();
            resumeJsonlView(rt);
            return;
        }
        if (jsonlAction === "resume_picker") {
            key.preventDefault();
            key.stopPropagation();
            rt.workspaceSidebarFocused = false;
            openResumePicker(rt);
            return;
        }
        if (jsonlAction === "new_session") {
            key.preventDefault();
            key.stopPropagation();
            beginCreateSession(rt, "keep_running");
            return;
        }
        if (jsonlAction === "type") {
            key.preventDefault();
            key.stopPropagation();
            rt.composer.setComposerText(
                key.name === "space" ? " " : (key.sequence ?? key.name),
            );
            resumeJsonlView(rt);
            return;
        }
        if (jsonlAction === "focus_sidebar") {
            key.preventDefault();
            key.stopPropagation();
            focusWorkspaceSidebar(rt);
            return;
        }
        if (jsonlAction === "home") {
            key.preventDefault();
            key.stopPropagation();
            returnToHome(rt);
            return;
        }
        if (jsonlAction === "command") {
            key.preventDefault();
            key.stopPropagation();
            rt.jsonlCommandMode = true;
            rt.workspaceSidebarFocused = false;
            rt.composer.setComposerText("/");
            renderCommandSuggestions(rt);
            renderState(rt);
            focusActiveSurface(rt);
            return;
        }
        if (
            jsonlAction === "toggle_sidebar"
            || jsonlAction === "cycle_session"
            || jsonlAction === "palette"
            || jsonlAction === "search"
        ) {
        } else if (
            jsonlAction === "sidebar"
            && rt.workspaceSidebar !== undefined
            && rt.workspaceSidebarFocused
        ) {
            const open = rt.workspaceSidebar;
            const transition = handleWorkspaceSidebarKey(
                open,
                key,
                new Date(),
                rt.renderer.width,
                rt.workspaceSidebarView.visibleRows(),
            );
            key.preventDefault();
            key.stopPropagation();
            if (transition.handled) {
                rt.workspaceSidebar = transition.state ?? open;
                if (transition.action !== undefined) {
                    runWorkspaceSidebarAction(rt, transition.action);
                } else {
                    renderState(rt);
                    focusActiveSurface(rt);
                }
            }
            return;
        } else if (jsonlAction === "block") {
            key.preventDefault();
            key.stopPropagation();
            return;
        }
    }
    if (parseRawInputEvent(key)?.type === "open_palette") {
        key.preventDefault();
        key.stopPropagation();
        if (rt.commandPalette !== undefined) {
            rt.commandPalette = undefined;
            rt.commandPaletteView.surface.visible = false;
            rt.composer.focus();
            renderState(rt);
            return;
        }
        if (!rt.sessionSwitchPending && !anyOverlayOpen(rt)) {
            openCommandPalette(rt);
        }
        return;
    }
    if (
        isTuiComposerClearKey(key)
        && rt.composer.focused
        && rt.composer.plainText.length > 0
        && !anyOverlayOpen(rt)
    ) {
        key.preventDefault();
        key.stopPropagation();
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        renderState(rt);
        return;
    }
    const wordDeleteDirection = tuiComposerWordDeleteDirection(key);
    if (
        wordDeleteDirection !== undefined
        && rt.composer.focused
        && rt.composer.plainText.length > 0
        && !anyOverlayOpen(rt)
    ) {
        key.preventDefault();
        key.stopPropagation();
        if (wordDeleteDirection === "backward") {
            rt.composer.deleteWordBackward();
        } else {
            rt.composer.deleteWordForward();
        }
        renderCommandSuggestions(rt);
        renderState(rt);
        return;
    }
    if (parseRawInputEvent(key)?.type === "interrupt") {
        if (rt.sessionTrashPending) {
            key.preventDefault();
            key.stopPropagation();
            return;
        }
        if (
            !focusedAgentCanAbort(rt)
            && rt.composer.focused
            && rt.composer.plainText.length > 0
            && !anyOverlayOpen(rt)
        ) {
            key.preventDefault();
            key.stopPropagation();
            rt.composer.clearComposer();
            renderCommandSuggestions(rt);
            renderState(rt);
            return;
        }
        const action = tuiInterruptAction(
            key,
            focusedAgentState(rt).working,
            focusedAbortRequested(rt),
            focusedAgentState(rt).compactingSince !== undefined,
        );
        key.preventDefault();
        key.stopPropagation();
        if (action === "quit") {
            rt.renderer.destroy();
        } else if (action === "abort") {
            abortFocusedAgent(rt);
            renderStatus(rt);
        }
        return;
    }

    if (rt.jumpMenu !== undefined) {
        key.preventDefault();
        key.stopPropagation();
        const action = handleJumpMenuKey(rt.jumpMenu, key.name);
        if (action.kind === "cancel") {
            closeJumpMenu(rt);
        } else if (action.kind === "jump") {
            runJumpTo(rt, action.row);
        } else {
            rt.jumpMenu = action.state;
            renderJumpMenu(rt);
        }
        return;
    }

    if (rt.dialStrip !== undefined) {
        key.preventDefault();
        key.stopPropagation();
        const action = handleDialStripKey(
            rt.dialStrip,
            key as {
                name: string;
                ctrl?: boolean;
                shift?: boolean;
                sequence?: string;
            },
            tuiBindingId("dials", key),
        );
        if (action.kind === "state") {
            const previousPermission =
                rt.dialStrip.permissionModes[rt.dialStrip.permissionIndex];
            const nextPermission = action.state.permissionModes[
                action.state.permissionIndex
            ];
            rt.dialStrip = action.state;
            if (
                nextPermission === "auto"
                && previousPermission !== "auto"
            ) {
                startAutoModeAnimation(rt);
            } else if (nextPermission !== "auto") {
                stopAutoModeAnimation(rt);
            }
            renderState(rt);
        } else if (action.kind === "cancel") {
            closeDials(rt);
        } else if (action.kind === "commit") {
            commitDials(rt, action.pair, action.agent, action.permission);
        }
        return;
    }

    if (rt.sessionCloseConfirm) {
        const result = handleTuiSessionCloseConfirmKey(key);
        key.preventDefault();
        key.stopPropagation();
        if (result === "confirm") {
            beginParkToJsonl(rt);
        } else if (result === "cancel") {
            rt.sessionCloseConfirm = false;
            rt.state = appendTuiNotice(rt.state, "conversation kept running");
            focusActiveSurface(rt);
            renderState(rt);
        }
        return;
    }

    const uiRequest = focusedUiRequest(rt);
    if (
        uiRequest !== undefined
        && isUserQuestionUiRequestUpdate(uiRequest)
    ) {
        const result = rt.questionView.handleKey(uiRequest, key);
        if (result.handled) {
            key.preventDefault();
            key.stopPropagation();
            if (result.response !== undefined) {
                void focusedAgentClient(rt).send(result.response)
                    .catch(((error: unknown) => reportConnectionError(rt, error)));
                if (rt.sidebar.isFocused() && rt.hostedSidebar.pane !== undefined) {
                    rt.hostedSidebar.pane.state.activity = "thinking";
                } else {
                    rt.activity = "thinking";
                }
                focusActiveSurface(rt);
            }
            renderState(rt);
            return;
        }
    } else if (
        uiRequest !== undefined
        && isToolApprovalUiRequestUpdate(uiRequest)
    ) {
        const result = rt.approvalView.handleKey(uiRequest, key);
        if (result.handled) {
            key.preventDefault();
            key.stopPropagation();
            if (result.response !== undefined) {
                void focusedAgentClient(rt).send(result.response)
                    .catch(((error: unknown) => reportConnectionError(rt, error)));
                if (rt.sidebar.isFocused() && rt.hostedSidebar.pane !== undefined) {
                    rt.hostedSidebar.pane.state.activity = "thinking";
                } else {
                    rt.activity = "thinking";
                }
                focusActiveSurface(rt);
            }
            renderState(rt);
            return;
        }
    }

    if (uiRequest === undefined && rt.experimentalTuiHost.hasModal()) {
        key.preventDefault();
        key.stopPropagation();
        rt.experimentalTuiHost.handleKey(key);
        return;
    }
    if (uiRequest === undefined
        && rt.experimentalTuiHost.hasFocus()
        && rt.experimentalTuiHost.handleKey(key)) {
        key.preventDefault();
        key.stopPropagation();
        return;
    }

    if (
        !rt.composer.focused
        && activeOverlayFocus(rt) === undefined
        && tuiBindingId("unfocused", key) === "focus_composer"
    ) {
        key.preventDefault();
        key.stopPropagation();
        rt.composer.focus();
        renderState(rt);
        return;
    }

    if (rt.sessionTrashCandidate !== undefined) {
        if (rt.sessionTrashPending) {
            key.preventDefault();
            key.stopPropagation();
            return;
        }
        const result = handleTuiSessionTrashConfirmKey(key);
        key.preventDefault();
        key.stopPropagation();
        if (result !== undefined) {
            if (result === "confirm") {
                beginSessionTrash(rt, rt.sessionTrashCandidate);
            } else {
                rt.sessionTrashCandidate = undefined;
                rt.state = appendTuiNotice(rt.state, "conversation kept");
                focusActiveSurface(rt);
                renderState(rt);
            }
        }
        return;
    }

    if (rt.providerForgetCandidate !== undefined) {
        const result = handleTuiProviderForgetConfirmKey(key);
        key.preventDefault();
        key.stopPropagation();
        if (result === "confirm") {
            forgetProviderCredential(rt, rt.providerForgetCandidate);
        } else if (result === "cancel") {
            const kept = rt.providerForgetCandidate;
            rt.providerForgetCandidate = undefined;
            rt.state = appendTuiNotice(
                rt.state,
                `kept the stored ${kept.label} credential`,
            );
            focusActiveSurface(rt);
            renderState(rt);
        }
        return;
    }

    if (rt.timelinePicker !== undefined) {
        const editorTransition = rt.timelinePickerView.handleEditorKey(
            rt.timelinePicker,
            key,
        );
        const transition = editorTransition.handled
            ? editorTransition
            : handleTuiTimelineKey(rt.timelinePicker, key, randomUUID);
        if (transition.handled) {
            key.preventDefault();
            key.stopPropagation();
            applyTimelineTransition(rt, transition);
            return;
        }
    }

    if (rt.confirmingFullAccess) {
        const result = handleTuiPermissionsConfirmKey(key);
        if (result !== undefined) {
            key.preventDefault();
            key.stopPropagation();
            rt.confirmingFullAccess = false;
            if (result === "confirm") {
                requestPermissionsChange(rt, 
                    "full_access",
                    rt.confirmingFullAccessAgent,
                );
            } else {
                rt.state = appendTuiNotice(rt.state, "full access unchanged");
            }
            rt.confirmingFullAccessAgent = undefined;
            focusActiveSurface(rt);
            renderState(rt);
            return;
        }
    }

    if (rt.admissionDialog !== undefined) {
        key.preventDefault();
        key.stopPropagation();
        const action = handleTuiAdmissionDialogKey(
            rt.admissionDialog,
            dialogAdmission(rt),
            key,
        );
        if (action === undefined) {
            return;
        }
        if (action === "retry") {
            const requestId = requestPoolAdmission(rt, 
                rt.admissionDialog.provider,
                rt.admissionDialog.model,
                true,
            );
            rt.admissionDialog = { ...rt.admissionDialog, requestId };
            renderState(rt);
            return;
        }
        if (action === "hide") {
            closeAdmissionDialog(rt, false);
            return;
        }
        closeAdmissionDialog(rt, dialogAdmission(rt)?.verdict === "added");
        return;
    }

    if (rt.requestOptionsEditor !== undefined) {
        const transition = rt.requestOptionsEditorView.handleKey(
            rt.requestOptionsEditor,
            key,
        );
        if (transition.handled) {
            key.preventDefault();
            key.stopPropagation();
            applyRequestOptionsEditorTransition(rt, transition);
            return;
        }
    }
    if (rt.providerForm !== undefined) {
        const transition = rt.providerFormView.handleKey(rt.providerForm, key);
        if (transition.handled) {
            key.preventDefault();
            key.stopPropagation();
            applyProviderFormTransition(rt, rt.providerForm, transition);
            return;
        }
    }

    if (rt.namePrompt !== undefined) {
        const transition = rt.namePromptView.handleKey(
            rt.namePrompt,
            key,
        );
        if (transition.handled) {
            key.preventDefault();
            key.stopPropagation();
            applySessionRenamePromptTransition(rt, 
                rt.namePrompt,
                transition,
            );
            return;
        }
    }

    if (rt.secretPrompt !== undefined) {
        const transition = handleTuiSecretPromptKey(rt.secretPrompt, key);
        if (transition.handled) {
            key.preventDefault();
            key.stopPropagation();
            applySecretPromptTransition(rt, rt.secretPrompt, transition);
            return;
        }
    }

    if (rt.standingNudges !== undefined) {
        const editorTransition = rt.standingNudgesView.handleEditorKey(
            rt.standingNudges,
            key,
        );
        if (editorTransition.handled) {
            key.preventDefault();
            key.stopPropagation();
            adoptStandingNudgesState(rt, editorTransition.state);
            renderState(rt);
            focusActiveSurface(rt);
            return;
        }
        if (rt.standingNudgesView.handleViewportKey(key.name)) {
            key.preventDefault();
            key.stopPropagation();
            return;
        }
        const transition = handleTuiStandingNudgesKey(
            rt.standingNudges,
            key,
        );
        if (transition.handled) {
            key.preventDefault();
            key.stopPropagation();
            adoptStandingNudgesState(rt, transition.state);
            if (rt.standingNudges === undefined) {
                rt.standingNudgesView.surface.visible = false;
                rt.composer.focus();
            }
            renderState(rt);
            if (rt.standingNudges !== undefined) focusActiveSurface(rt);
            return;
        }
    }

    if (rt.extensionsList !== undefined) {
        if (applyExtensionsListKey(rt, key)) {
            key.preventDefault();
            key.stopPropagation();
            return;
        }
    }

    if (rt.settingsPicker !== undefined) {
        const viewportRows = tuiPickerViewportRows(
            rt.renderer,
            rt.settingsPicker,
            verificationConsoleRows(rt),
        );
        let transition:
            | TuiSettingsPickerTransition
            | TuiExtensionPickerTransition;
        if (rt.settingsPicker.kind === "extension") {
            transition = handleTuiSettingsPickerKey(
                rt.settingsPicker,
                key,
                viewportRows,
            );
        } else {
            const edited = rt.settingsPickerView.handleEditorKey(
                rt.settingsPicker,
                key,
            );
            transition = edited.handled
                ? edited
                : handleTuiSettingsPickerKey(
                    rt.settingsPicker,
                    key,
                    viewportRows,
                );
        }
        if (transition.handled) {
            key.preventDefault();
            key.stopPropagation();
            applySettingsPickerTransition(rt, transition);
            return;
        }
    }

    if (rt.preferencesList !== undefined) {
        const transition = handleTuiPreferencesListKey(rt.preferencesList, key);
        if (transition.handled) {
            key.preventDefault();
            key.stopPropagation();
            rt.preferencesList = transition.state;
            if (transition.remove !== undefined) {
                sendCommand(rt, {
                    type: transition.remove.kind === "grant"
                        ? "remove_permission_grant"
                        : "remove_permission_preference",
                    requestId: randomUUID(),
                    id: transition.remove.id,
                });
            }
            if (rt.preferencesList === undefined) {
                rt.preferencesListView.surface.visible = false;
                rt.settingsPicker = rt.preferencesListParent;
                rt.preferencesListParent = undefined;
                if (rt.settingsPicker === undefined) {
                    rt.composer.focus();
                } else {
                    rt.settingsPickerView.update(rt.settingsPicker);
                    rt.settingsPickerView.focus();
                }
            }
            renderState(rt);
            return;
        }
    }

    if (rt.workspaceSidebar !== undefined && rt.workspaceSidebarFocused) {
        const open = rt.workspaceSidebar;
        const transition = handleWorkspaceSidebarKey(
            open,
            key,
            new Date(),
            rt.renderer.width,
            rt.workspaceSidebarView.visibleRows(),
        );
        if (transition.handled) {
            key.preventDefault();
            key.stopPropagation();
            rt.workspaceSidebar = transition.state ?? open;
            if (transition.action !== undefined) {
                runWorkspaceSidebarAction(rt, transition.action);
            } else {
                renderState(rt);
                focusActiveSurface(rt);
            }
            return;
        }
    }

    if (rt.workTab !== undefined) {
        const open = rt.workTab;
        const transition = handleWorkTabKey(open, key);
        if (transition.handled) {
            key.preventDefault();
            key.stopPropagation();
            rt.workTab = transition.state;
            if (transition.action !== undefined) {
                runWorkTabAction(rt, open, transition.action);
            } else {
                renderState(rt);
                focusActiveSurface(rt);
            }
            return;
        }
    }

    if (rt.searchOverlay !== undefined) {
        const structural = handleSearchOverlayKey(rt.searchOverlay, key);
        const transition = structural.handled
            ? structural
            : rt.searchOverlayView.handleInputKey(key)
            ? updateSearchOverlayText(
                rt.searchOverlay,
                rt.searchOverlayView.inputText(),
                rt.searchOverlayView.inputCursor(),
            )
            : structural;
        if (transition.handled) {
            key.preventDefault();
            key.stopPropagation();
            rt.searchOverlay = transition.state;
            if (transition.action !== undefined) {
                runSearchOverlayAction(rt, transition.action);
            } else {
                renderState(rt);
                focusActiveSurface(rt);
            }
            return;
        }
    }

    if (rt.commandPalette !== undefined) {
        const editorTransition = rt.commandPaletteView.handleEditorKey(
            rt.commandPalette,
            key,
        );
        const transition = editorTransition.handled
            ? editorTransition
            : handleTuiCommandPaletteKey(rt.commandPalette, key);
        if (transition.handled) {
            key.preventDefault();
            key.stopPropagation();
            rt.commandPalette = transition.state;
            if (transition.selection !== undefined) {
                const selected = transition.selection;
                rt.commandPalette = undefined;
                runPaletteAction(rt, selected);
                focusActiveSurface(rt);
            } else {
                renderState(rt);
                focusActiveSurface(rt);
            }
            return;
        }
    }

    if (rt.help !== undefined) {
        const editorTransition = rt.helpView.handleEditorKey(rt.help, key);
        const transition = editorTransition.handled
            ? editorTransition
            : handleTuiHelpKey(rt.help, key);
        if (transition.handled) {
            key.preventDefault();
            key.stopPropagation();
            rt.help = transition.state;
            renderState(rt);
            focusActiveSurface(rt);
            return;
        }
    }

    if (rt.doctorDialog !== undefined) {
        const action = handleTuiDiagnosticsDialogKey(key);
        if (action !== undefined) {
            key.preventDefault();
            key.stopPropagation();
            if (action === "dismiss") {
                rt.doctorInspectionGeneration += 1;
                rt.doctorDialog = undefined;
                focusActiveSurface(rt);
                renderState(rt);
                return;
            }
            if (rt.doctorDialog.copyReady === false) {
                return;
            }
            const text = rt.doctorDialog.text;
            void rt.copyText(text).then(() => {
                if (rt.doctorDialog?.text !== text) return;
                rt.doctorDialog = { text, copyStatus: "copied" };
                renderState(rt);
            }).catch(() => {
                if (rt.doctorDialog?.text !== text) return;
                rt.doctorDialog = { text, copyStatus: "failed" };
                renderState(rt);
            });
            return;
        }
    }

    if (rt.extensionsDialog !== undefined) {
        const action = handleTuiDiagnosticsDialogKey(key);
        if (action !== undefined) {
            key.preventDefault();
            key.stopPropagation();
            if (action === "dismiss") {
                rt.extensionsDialog = undefined;
                focusActiveSurface(rt);
                renderState(rt);
                return;
            }
            if (rt.extensionsDialog.copyReady === false) return;
            const text = rt.extensionsDialog.text;
            void rt.copyText(text).then(() => {
                if (rt.extensionsDialog?.text !== text) return;
                rt.extensionsDialog = { ...rt.extensionsDialog, copyStatus: "copied" };
                renderState(rt);
            }).catch(() => {
                if (rt.extensionsDialog?.text !== text) return;
                rt.extensionsDialog = { ...rt.extensionsDialog, copyStatus: "failed" };
                renderState(rt);
            });
            return;
        }
    }

    if (rt.documentDialog !== undefined) {
        const action = handleTuiDiagnosticsDialogKey(key);
        if (action !== undefined) {
            key.preventDefault();
            key.stopPropagation();
            if (action === "dismiss") {
                rt.documentDialog = undefined;
                focusActiveSurface(rt);
                renderState(rt);
                return;
            }
            if (rt.documentDialog.copyReady === false) return;
            const text = rt.documentDialog.text;
            void rt.copyText(text).then(() => {
                if (rt.documentDialog?.text !== text) return;
                rt.documentDialog = { ...rt.documentDialog, copyStatus: "copied" };
                renderState(rt);
            }).catch(() => {
                if (rt.documentDialog?.text !== text) return;
                rt.documentDialog = { ...rt.documentDialog, copyStatus: "failed" };
                renderState(rt);
            });
            return;
        }
    }

    if (rt.diagnosticsDialog !== undefined) {
        const action = handleTuiDiagnosticsDialogKey(key, true, true);
        if (action !== undefined) {
            key.preventDefault();
            key.stopPropagation();
            if (action === "dismiss") {
                abortProviderHealthCheck(rt);
                rt.providerHealthGeneration += 1;
                rt.diagnosticsGeneration += 1;
                rt.diagnosticsDialog = undefined;
                rt.diagnosticsSessionPath = undefined;
                rt.diagnosticsSessionIdentity = undefined;
                rt.diagnosticsSessionPathResolved = false;
                focusActiveSurface(rt);
                renderState(rt);
                return;
            }
            if (action === "switch_scope") {
                rt.diagnosticsScope = rt.diagnosticsScope === "session"
                    ? "vera"
                    : "session";
                rt.diagnosticsDialog = {
                    text: renderDiagnostics(rt, {
                        ...diagnosticsSnapshot(rt),
                        sessionPath: rt.diagnosticsSessionPath,
                    }),
                    scope: rt.diagnosticsScope,
                    copyReady: rt.diagnosticsScope === "vera"
                        || rt.diagnosticsSessionPathResolved,
                };
                renderState(rt);
                return;
            }
            if (action === "check_health") {
                void startProviderHealthCheck(rt);
                return;
            }
            if (rt.diagnosticsDialog.copyReady === false) {
                return;
            }
            const text = rt.diagnosticsDialog.text;
            void rt.copyText(text).then(() => {
                if (rt.diagnosticsDialog?.text !== text) return;
                rt.diagnosticsDialog = {
                    ...rt.diagnosticsDialog,
                    copyStatus: "copied",
                };
                renderState(rt);
            }).catch(() => {
                if (rt.diagnosticsDialog?.text !== text) return;
                rt.diagnosticsDialog = {
                    ...rt.diagnosticsDialog,
                    copyStatus: "failed",
                };
                renderState(rt);
            });
            return;
        }
    }

    if (
        rt.argumentSuggestions.length > 0
        && rt.commandSuggestionsBox.visible
        && !key.ctrl
        && !key.meta
        && !key.super
        && !key.hyper
        && !key.shift
    ) {
        if (key.name === "up" || key.name === "down") {
            key.preventDefault();
            key.stopPropagation();
            rt.commandSuggestionIndex = key.name === "up"
                ? Math.max(0, rt.commandSuggestionIndex - 1)
                : Math.min(
                    rt.argumentSuggestions.length - 1,
                    rt.commandSuggestionIndex + 1,
                );
            renderCommandSuggestions(rt);
            return;
        }
        if (key.name === "return" || key.name === "enter") {
            const typed = activeCompletion(rt)?.prefix;
            const selected = rt.argumentSuggestions[rt.commandSuggestionIndex];
            if (
                selected !== undefined
                && selected.toLowerCase() !== typed?.toLowerCase()
            ) {
                key.preventDefault();
                key.stopPropagation();
                rt.composer.setComposerText(
                    tuiWithArgument(rt.composer.plainText, selected),
                );
                renderCommandSuggestions(rt);
                return;
            }
        }
    }

    if (
        rt.composer.plainText === "/"
        && rt.commandSuggestionsBox.visible
        && !key.ctrl
        && !key.meta
        && !key.super
        && !key.hyper
        && !key.shift
    ) {
        const suggestions = availableCommandSuggestions(rt, "/");
        if (key.name === "up" || key.name === "k") {
            key.preventDefault();
            key.stopPropagation();
            rt.commandSuggestionIndex = Math.max(0, rt.commandSuggestionIndex - 1);
            rt.commandSuggestionMoved = true;
            renderCommandSuggestions(rt);
            return;
        }
        if (key.name === "down" || key.name === "j") {
            key.preventDefault();
            key.stopPropagation();
            rt.commandSuggestionIndex = Math.min(
                suggestions.length - 1,
                rt.commandSuggestionIndex + 1,
            );
            rt.commandSuggestionMoved = true;
            renderCommandSuggestions(rt);
            return;
        }
        const runs = key.name === "return" || key.name === "enter";
        const completes =
            tuiBindingId("composer", key) === "complete_command";
        if (runs || (completes && rt.commandSuggestionMoved)) {
            const selected = suggestions[rt.commandSuggestionIndex];
            if (selected !== undefined) {
                key.preventDefault();
                key.stopPropagation();
                rt.composer.setComposerText(`/${selected.name}`);
                if (runs) submitPrompt(rt);
                return;
            }
        }
    }

    const composeSuggester = activeComposeSuggester(rt);
    if (
        (key.name === "return" || key.name === "enter")
        && !key.ctrl
        && !key.shift
        && !key.meta
        && composeSuggester !== undefined
    ) {
        key.preventDefault();
        key.stopPropagation();
        rt.dismissedComposeSuggesters.add(
            composeSuggesterDismissalKey(composeSuggester),
        );
        selectAgent(rt, composeSuggester.agent);
        renderCommandSuggestions(rt);
        renderState(rt);
        rt.composer.focus();
        return;
    }

    if (
        key.name === "escape"
        && !key.ctrl
        && !key.shift
        && !key.meta
        && activeComposeSuggester(rt) !== undefined
    ) {
        key.preventDefault();
        key.stopPropagation();
        const suggester = activeComposeSuggester(rt);
        if (suggester !== undefined) {
            rt.dismissedComposeSuggesters.add(
                composeSuggesterDismissalKey(suggester),
            );
        }
        renderCommandSuggestions(rt);
        renderState(rt);
        rt.composer.focus();
        return;
    }

    if (
        key.name === "escape"
        && !key.ctrl
        && !key.shift
        && !key.meta
        && rt.pendingQuote !== undefined
    ) {
        key.preventDefault();
        key.stopPropagation();
        rt.pendingQuote = undefined;
        renderState(rt);
        rt.composer.focus();
        return;
    }

    if (
        key.name === "escape"
        && !key.ctrl
        && !key.shift
        && !key.meta
        && rt.composer.plainText.length > 0
    ) {
        key.preventDefault();
        key.stopPropagation();
        rt.composer.clearComposer();
        renderCommandSuggestions(rt);
        renderState(rt);
        rt.composer.focus();
        return;
    }

    if (
        key.name === "escape"
        && !key.ctrl
        && !key.shift
        && !key.meta
        && !anyOverlayOpen(rt)
        && !rt.sessionSwitchPending
        && rt.pendingImages.length === 0
        && focusedAgentState(rt).queuedPrompts.length > 0
    ) {
        key.preventDefault();
        key.stopPropagation();
        releaseFocusedQueuedPrompts(rt, "one");
        return;
    }

    if (
        key.name === "escape"
        && !key.ctrl
        && !key.shift
        && !key.meta
        && !isHomeClient(rt.client)
        && !anyOverlayOpen(rt)
        && !rt.sessionSwitchPending
        && !focusedAgentState(rt).working
        && focusedAgentState(rt).queuedPrompts.length === 0
    ) {
        key.preventDefault();
        key.stopPropagation();
        const now = performance.now();
        const doubled = previousIdleEscapeAt !== undefined
            && now - previousIdleEscapeAt <= DOUBLE_ESCAPE_REWIND_WINDOW_MS;
        rt.lastIdleEscapeAt = now;
        if (!doubled) return;
        rt.lastIdleEscapeAt = undefined;
        if (rt.sidebar.isFocused() && rt.hostedSidebar.pane !== undefined) {
            showStatusNotice(rt, 
                "Switch to Vera with Ctrl+G to manage its conversation",
            );
            return;
        }
        applyTimelineTransition(rt, startTuiTimelinePicker(randomUUID()));
        return;
    }

    if (tuiBindingId("composer", key) === "close_session"
        && rt.composer.focused
        && !anyOverlayOpen(rt)
    ) {
        key.preventDefault();
        key.stopPropagation();
        requestCloseSession(rt);
        return;
    }

    if (
        key.name === "left"
        && !key.ctrl
        && !key.shift
        && !key.meta
        && !key.super
        && !key.hyper
        && (
            (rt.composer.focused && composerIsAtLeftBoundary(rt))
            || (isHomeClient(rt.client) && rt.homeView.box.focused)
        )
        && rt.workspaceSidebar !== undefined
        && !rt.workspaceSidebarFocused
        && !anyOverlayOpen(rt)
        && !rt.commandPaletteView.surface.visible
    ) {
        key.preventDefault();
        key.stopPropagation();
        focusWorkspaceSidebar(rt);
        return;
    }

    if (tuiBindingId("composer", key) === "complete_command") {
        const completing = activeCompletion(rt);
        if (completing !== undefined) {
            key.preventDefault();
            key.stopPropagation();
            const highlighted = rt.argumentSuggestions[rt.commandSuggestionIndex];
            if (
                highlighted !== undefined
                && highlighted.toLowerCase()
                    !== completing.prefix.toLowerCase()
            ) {
                rt.composer.setComposerText(
                    tuiWithArgument(rt.composer.plainText, highlighted),
                );
                renderCommandSuggestions(rt);
                return;
            }
            const completed = tuiArgumentCompletion(
                completing.values,
                completing.prefix,
            );
            if (completed !== undefined) {
                rt.composer.setComposerText(
                    tuiWithArgument(rt.composer.plainText, completed),
                );
                renderCommandSuggestions(rt);
            }
            return;
        }
        const completion = availableCommandCompletion(rt, rt.composer.plainText);
        if (completion !== undefined) {
            key.preventDefault();
            key.stopPropagation();
            rt.composer.setComposerText(completion);
            renderCommandSuggestions(rt);
            return;
        }
        if (availableCommandSuggestions(rt, rt.composer.plainText).length > 0) {
            key.preventDefault();
            key.stopPropagation();
            return;
        }
        key.preventDefault();
        key.stopPropagation();
        return;
    }

    if (tuiBindingId("global", key) === "toggle_workspace_sidebar") {
        if (rt.workspaceSidebar !== undefined) {
            key.preventDefault();
            key.stopPropagation();
            closeWorkspaceSidebar(rt);
            return;
        }
        if (!anyOverlayOpen(rt)) {
            key.preventDefault();
            key.stopPropagation();
            openWorkspaceSidebar(rt);
            return;
        }
    }

    const liveCycle = tuiBindingId("global", key);
    if (
        (liveCycle === "cycle_live_session_next"
            || liveCycle === "cycle_live_session_prev")
        && !anyOverlayOpen(rt)
    ) {
        key.preventDefault();
        key.stopPropagation();
        cycleLiveSession(rt, liveCycle === "cycle_live_session_next" ? 1 : -1);
        return;
    }

    if (
        tuiBindingId("global", key) === "toggle_thinking"
        && !anyOverlayOpen(rt)
    ) {
        key.preventDefault();
        key.stopPropagation();
        const side = rt.sidebar.isFocused() ? rt.hostedSidebar.pane : undefined;
        const wasFollowing = side === undefined
            ? rt.transcript.scrollTop
                >= rt.transcript.scrollHeight - rt.transcript.viewport.height
            : rt.sidebar.isFollowing();
        if (side === undefined) {
            rt.state = toggleTuiThinking(rt.state);
        } else {
            side.state.state = toggleTuiThinking(side.state.state);
            renderSidebarAgent(rt, side);
        }
        renderState(rt);
        if (wasFollowing) {
            if (side === undefined) {
                rt.transcript.scrollTo(rt.transcript.scrollHeight);
            } else {
                rt.sidebar.scrollToBottom();
            }
        }
        return;
    }

    if (
        tuiBindingId("global", key) === "toggle_session_header"
        && !anyOverlayOpen(rt)
    ) {
        key.preventDefault();
        key.stopPropagation();
        if (rt.sidebar.isFocused() && rt.hostedSidebar.pane !== undefined) {
            toggleSidebarHeader(rt);
        } else {
            toggleMainHeader(rt);
        }
        return;
    }

    if (
        tuiBindingId("global", key) === "dials.open"
        && !anyOverlayOpen(rt)
    ) {
        key.preventDefault();
        key.stopPropagation();
        openDials(rt);
        return;
    }

    if (
        tuiBindingId("global", key) === "search_conversation"
        && !anyOverlayOpen(rt)
    ) {
        key.preventDefault();
        key.stopPropagation();
        openSearchOverlay(rt, "conversation");
        return;
    }

    if (
        tuiBindingId("global", key) === "search_sessions"
        && !anyOverlayOpen(rt)
    ) {
        key.preventDefault();
        key.stopPropagation();
        openSearchOverlay(rt, "workspace");
        return;
    }

    if (
        tuiBindingId("global", key) === "open_model_picker"
        && !anyOverlayOpen(rt)
    ) {
        key.preventDefault();
        key.stopPropagation();
        openModelPicker(rt);
        return;
    }

    if (
        tuiBindingId("global", key) === "jump.open"
        && !anyOverlayOpen(rt)
    ) {
        key.preventDefault();
        key.stopPropagation();
        openJumpMenuOverlay(rt);
        return;
    }

    if (
        tuiBindingId("conversation", key) === "toggle_tool_details"
        && !anyOverlayOpen(rt)
    ) {
        key.preventDefault();
        key.stopPropagation();
        const side = rt.sidebar.isFocused() ? rt.hostedSidebar.pane : undefined;
        const wasFollowing = side === undefined
            ? rt.transcript.scrollTop
                >= rt.transcript.scrollHeight - rt.transcript.viewport.height
            : rt.sidebar.isFollowing();
        if (side === undefined) {
            rt.state = toggleTuiToolDetails(rt.state);
        } else {
            side.state.state = toggleTuiToolDetails(side.state.state);
            renderSidebarAgent(rt, side);
        }
        renderState(rt);
        if (wasFollowing) {
            if (side === undefined) {
                rt.transcript.scrollTo(rt.transcript.scrollHeight);
            } else {
                rt.sidebar.scrollToBottom();
            }
        } else {
            const activeState = side?.state.state ?? rt.state;
            const lastToolGroup = activeState.entries.findLastIndex((entry) =>
                entry.kind === "tool_header"
                && entry.detailLines !== undefined
            );
            if (side === undefined && lastToolGroup >= 0) {
                rt.transcript.scrollChildIntoView(`entry-${lastToolGroup}`);
            }
        }
        return;
    }

    const scrollBinding = anyOverlayOpen(rt)
        ? undefined
        : tuiBindingId("conversation", key);
    if (applyTranscriptScroll(rt, scrollBinding)) {
        key.preventDefault();
        key.stopPropagation();
        return;
    }

    const extensionKey = tuiChord(key);
    const bound = extensionKey === undefined
        ? undefined
        : activeTuiKeymap().find((binding) =>
            binding.keys.includes(extensionKey)
        );
    const boundId = bound?.extensionId ?? bound?.id;
    const extensionBinding = boundId === undefined
        ? undefined
        : rt.clientExtensionRegistry?.keybindings().find((binding) =>
            binding.id === boundId
        );
    if (extensionBinding !== undefined && !anyOverlayOpen(rt)) {
        key.preventDefault();
        key.stopPropagation();
        const target = focusedAgentClient(rt);
        void rt.extensionAgentTarget.run(target, () =>
            rt.clientExtensionRegistry!.invokeKeybinding(
                extensionBinding.id,
                rt.client.workspace ?? process.cwd(),
            )
        ).catch((error) => {
            rt.state = appendTuiNotice(
                rt.state,
                error instanceof Error ? error.message : String(error),
            );
            renderState(rt);
        });
        return;
    }

    const action = tuiInterruptAction(
        key,
        focusedAgentState(rt).working,
        focusedAbortRequested(rt),
        focusedAgentState(rt).compactingSince !== undefined,
    );
    if (action === "pass") {
        return;
    }

    key.preventDefault();
    key.stopPropagation();

    if (action === "quit") {
        rt.renderer.destroy();
        return;
    }
    if (action === "abort") {
        abortFocusedAgent(rt);
        renderStatus(rt);
    }
}
