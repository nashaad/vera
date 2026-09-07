import { isConfigurationRequiredUiRequestUpdate, isToolApprovalUiRequestUpdate, isUserQuestionUiRequestUpdate } from "../../../src/engine/protocol.ts";
import { COMPOSER_PLACEHOLDER } from "../composer.ts";
import { isHomeClient } from "../home-client.ts";
import { isJsonlViewClient, isWorkerFreeClient } from "../jsonl-view-client.ts";
import { activityFrame, applyWorkspaceRail, dialogAdmission, liveVerificationConsole, renderCommandSuggestions, renderHeldAddress, renderPendingQuote, renderStatus } from "../main.ts";
import { focusedAgentState, focusedUiRequest } from "../main/agents-dials.ts";
import { markSearchLanding } from "../main/chrome.ts";
import { renderDiagnostics } from "../main/diagnostics-ops.ts";
import { destroyTranscriptEntryNode, renderTranscriptEntries, setTranscriptWindowAround, takeTip } from "../main/transcript-nodes.ts";
import { searchOverlayViewState } from "../search-overlay.ts";
import { TUI_ACCENT, TUI_MUTED, renderTuiQueuedPrompt, transcriptMessageId, type TuiTranscriptEntry } from "../state.ts";
import { tuiTranscriptAtBottom } from "../transcript-scroll.ts";
import { tuiTranscriptReusableTail } from "../transcript-window.ts";
import { workTabViewState } from "../work-tab.ts";
import { workspaceSidebarViewState } from "../workspace-sidebar.ts";
import type { TuiRuntime } from "./runtime.ts";
import { StyledText, fg, type BoxRenderable, type MarkdownRenderable, type TextRenderable } from "@opentui/core";

export function renderState(rt: TuiRuntime): void {
    if (rt.shuttingDown) {
        return;
    }
    const uiRequest = focusedUiRequest(rt);
    const configurationRequired = uiRequest !== undefined
        && isConfigurationRequiredUiRequestUpdate(uiRequest);
    rt.experimentalTuiHost.render();

    rt.placeholder.visible = rt.state.entries.length === 0
        && !isHomeClient(rt.client);
    if (rt.tipsEnabled && rt.workingLastRender && !rt.state.working) {
        rt.composerTip = takeTip(rt, false);
    }
    rt.workingLastRender = rt.state.working;
    rt.composerTipText.content = rt.composerTip === undefined
        ? new StyledText([])
        : new StyledText([
            fg(TUI_ACCENT)(
                `${" ".repeat(rt.appearance.composerTipIndent)}Tip `,
            ),
            fg(TUI_MUTED)(rt.composerTip),
        ]);
    rt.composerTipText.visible = rt.composerTip !== undefined
        && !anyOverlayOpen(rt);
    renderHeldAddress(rt);
    rt.composer.placeholder = rt.extensionAddressee === undefined
        ? rt.sidebar.isFocused() && rt.hostedSidebar.mention !== undefined
            ? `Message ${rt.hostedSidebar.mention}\u2026`
            : COMPOSER_PLACEHOLDER
        : `Message ${rt.extensionAddressee}\u2026`;
    renderPendingQuote(rt);
    const focusedState = focusedAgentState(rt);
    const queuedPrompt = renderTuiQueuedPrompt(focusedState);
    rt.queuedPromptText.content = queuedPrompt.length === 0
        ? ""
        : `${" ".repeat(rt.appearance.composerMarginHorizontal)}${queuedPrompt}`;
    rt.queuedPromptText.visible = focusedState.queuedPrompts.length > 0;
    rt.approvalView.box.visible = uiRequest?.request.type
        === "tool_approval";
    rt.questionView.box.visible = uiRequest?.request.type
        === "user_question";
    rt.statusText.visible = !(rt.approvalView.box.visible
        || rt.questionView.box.visible);
    rt.statusBand.visible = !(rt.approvalView.box.visible
        || rt.questionView.box.visible);
    rt.timelinePickerView.box.visible = uiRequest === undefined
        && rt.timelinePicker !== undefined;
    rt.requestOptionsEditorView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.requestOptionsEditor !== undefined;
    rt.providerFormView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.requestOptionsEditor === undefined
        && rt.providerForm !== undefined;
    rt.namePromptView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.requestOptionsEditor === undefined
        && rt.providerForm === undefined
        && rt.namePrompt !== undefined;
    rt.secretPromptView.box.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.namePrompt === undefined
        && rt.requestOptionsEditor === undefined
        && rt.providerForm === undefined
        && rt.secretPrompt !== undefined;
    rt.settingsPickerView.surface.visible = (uiRequest === undefined
            || configurationRequired)
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.overridesResetCandidate === undefined
        && rt.secretPrompt === undefined
        && rt.namePrompt === undefined
        && rt.requestOptionsEditor === undefined
        && rt.providerForm === undefined
        && rt.settingsPicker !== undefined;
    rt.preferencesListView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.preferencesList !== undefined;
    rt.standingNudgesView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.preferencesList === undefined
        && rt.standingNudges !== undefined;
    rt.extensionsListView.box.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.preferencesList === undefined
        && rt.standingNudges === undefined
        && rt.extensionsList !== undefined;
    rt.commandPaletteView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.secretPrompt === undefined
        && rt.preferencesList === undefined
        && rt.standingNudges === undefined
        && rt.extensionsList === undefined
        && rt.commandPalette !== undefined;
    rt.workTabView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.settingsPicker === undefined
        && rt.standingNudges === undefined
        && rt.extensionsList === undefined
        && rt.commandPalette === undefined
        && rt.workTab !== undefined;
    applyWorkspaceRail(rt);
    const sessionRequestVisible = rt.approvalView.box.visible
        || rt.questionView.box.visible;
    const workspaceSidebarAllowed = uiRequest === undefined
        || (sessionRequestVisible && rt.workspaceRail !== undefined);
    rt.workspaceSidebarView.surface.visible = workspaceSidebarAllowed
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.settingsPicker === undefined
        && rt.standingNudges === undefined
        && rt.extensionsList === undefined
        && rt.commandPalette === undefined
        && rt.workTab === undefined
        && rt.workspaceSidebar !== undefined
        && (rt.workspaceRail !== undefined || rt.workspaceSidebarFocused);
    rt.searchOverlayView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.settingsPicker === undefined
        && rt.standingNudges === undefined
        && rt.extensionsList === undefined
        && rt.commandPalette === undefined
        && rt.workTab === undefined
        && rt.searchOverlay !== undefined;
    rt.helpView.box.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.extensionsList === undefined
        && rt.commandPalette === undefined
        && rt.workTab === undefined
        && rt.searchOverlay === undefined
        && rt.help !== undefined;
    rt.doctorDialogView.box.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.extensionsList === undefined
        && rt.commandPalette === undefined
        && rt.help === undefined
        && rt.diagnosticsDialog === undefined
        && rt.extensionsDialog === undefined
        && rt.documentDialog === undefined
        && rt.doctorDialog !== undefined;
    rt.diagnosticsDialogView.box.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.extensionsList === undefined
        && rt.commandPalette === undefined
        && rt.help === undefined
        && rt.doctorDialog === undefined
        && rt.extensionsDialog === undefined
        && rt.documentDialog === undefined
        && rt.diagnosticsDialog !== undefined;
    rt.extensionsDialogView.box.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.extensionsList === undefined
        && rt.commandPalette === undefined
        && rt.help === undefined
        && rt.doctorDialog === undefined
        && rt.diagnosticsDialog === undefined
        && rt.documentDialog === undefined
        && rt.extensionsDialog !== undefined;
    rt.documentDialogView.box.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && !rt.confirmingFullAccess
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.settingsPicker === undefined
        && rt.extensionsList === undefined
        && rt.commandPalette === undefined
        && rt.help === undefined
        && rt.doctorDialog === undefined
        && rt.diagnosticsDialog === undefined
        && rt.extensionsDialog === undefined
        && rt.documentDialog !== undefined;
    rt.permissionsConfirmView.box.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.confirmingFullAccess;
    rt.admissionDialogView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && !rt.confirmingFullAccess
        && rt.admissionDialog !== undefined;
    rt.sessionTrashConfirmView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && rt.sessionTrashCandidate !== undefined
        && !rt.sessionCloseConfirm;
    rt.sessionCloseConfirmView.surface.visible = rt.timelinePicker === undefined
        && rt.sessionCloseConfirm;
    rt.providerForgetConfirmView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate !== undefined;
    rt.overridesResetConfirmView.surface.visible = uiRequest === undefined
        && rt.timelinePicker === undefined
        && rt.sessionTrashCandidate === undefined && !rt.sessionCloseConfirm
        && rt.providerForgetCandidate === undefined
        && rt.overridesResetCandidate !== undefined;
    const overlayVisible = rt.dialStrip !== undefined
        || rt.jumpMenuBox.visible
        || rt.approvalView.box.visible
        || rt.questionView.box.visible
        || rt.timelinePickerView.box.visible
        || rt.settingsPickerView.surface.visible
        || rt.preferencesListView.surface.visible
        || rt.standingNudgesView.surface.visible
        || rt.extensionsListView.box.visible
        || rt.commandPaletteView.surface.visible
        || rt.workTabView.surface.visible
        || (rt.workspaceSidebarView.surface.visible && rt.workspaceRail === undefined)
        || rt.searchOverlayView.surface.visible
        || rt.helpView.box.visible
        || rt.doctorDialogView.box.visible
        || rt.diagnosticsDialogView.box.visible
        || rt.extensionsDialogView.box.visible
        || rt.documentDialogView.box.visible
        || rt.permissionsConfirmView.box.visible
        || rt.admissionDialogView.surface.visible
        || rt.sessionTrashConfirmView.surface.visible
        || rt.sessionCloseConfirmView.surface.visible
        || rt.providerForgetConfirmView.surface.visible
        || rt.overridesResetConfirmView.surface.visible
        || rt.namePromptView.surface.visible
        || rt.providerFormView.surface.visible
        || rt.requestOptionsEditorView.surface.visible
        || rt.secretPromptView.box.visible
        || rt.experimentalTuiHost.hasModal();
    rt.overlayScrim.visible = overlayVisible;
    const requestUsesRail = sessionRequestVisible
        && rt.workspaceSidebarView.surface.visible;
    const requestRailColumns = requestUsesRail
        ? rt.workspaceSidebarView.railColumns() ?? 0
        : 0;
    rt.overlayScrim.left = requestRailColumns;
    rt.overlayScrim.width = Math.max(1, rt.renderer.width - requestRailColumns);
    rt.composerBox.visible = uiRequest === undefined
        && (!isWorkerFreeClient(rt.client) || rt.jsonlCommandMode);
    rt.resumeOverlay.surface.visible = uiRequest === undefined
        && isJsonlViewClient(rt.client)
        && !rt.jsonlCommandMode;
    rt.homeView.surface.visible = isHomeClient(rt.client)
        && rt.onboardingWizard === undefined && !overlayVisible;
    rt.onboardingWizardView.surface.visible = rt.onboardingWizard !== undefined;
    renderCommandSuggestions(rt);
    if (
        uiRequest !== undefined
        && isToolApprovalUiRequestUpdate(uiRequest)
    ) {
        rt.approvalView.update(uiRequest);
    }
    if (
        uiRequest !== undefined
        && isUserQuestionUiRequestUpdate(uiRequest)
    ) {
        rt.questionView.update(uiRequest);
    }
    rt.approvalView.box.left = requestRailColumns;
    rt.questionView.box.left = requestRailColumns;
    if (rt.timelinePicker !== undefined) {
        rt.timelinePickerView.update(rt.timelinePicker);
    }
    if (rt.settingsPicker === undefined) {
        rt.pickerTipKind = undefined;
        rt.settingsPickerView.tip = undefined;
        rt.settingsPickerView.verification = undefined;
        rt.verificationConsole = undefined;
    } else if (rt.tipsEnabled && rt.pickerTipKind !== rt.settingsPicker.kind) {
        rt.pickerTipKind = rt.settingsPicker.kind;
        rt.settingsPickerView.tip = takeTip(rt, rt.settingsPicker.kind === "model");
    }
    if (rt.settingsPicker !== undefined) {
        rt.settingsPickerView.verification = rt.settingsPicker.kind === "model"
            ? liveVerificationConsole(rt)
            : undefined;
        rt.settingsPickerView.update(rt.settingsPicker);
    }
    if (rt.secretPrompt !== undefined) {
        rt.secretPromptView.update(rt.secretPrompt);
    }
    if (rt.namePrompt !== undefined) {
        rt.namePromptView.update(rt.namePrompt);
    }
    if (rt.providerForm !== undefined) {
        rt.providerFormView.update(rt.providerForm);
    }
    if (rt.requestOptionsEditor !== undefined) {
        rt.requestOptionsEditorView.update(rt.requestOptionsEditor);
    }
    if (rt.preferencesList !== undefined) {
        rt.preferencesListView.update(rt.preferencesList);
    }
    if (rt.standingNudges !== undefined) {
        rt.standingNudgesView.update(rt.standingNudges);
    }
    if (rt.extensionsList !== undefined) {
        rt.extensionsListView.update(rt.extensionsList);
    }
    if (rt.commandPalette !== undefined) {
        rt.commandPaletteView.update(rt.commandPalette);
    }
    if (rt.workTab !== undefined) {
        rt.workTabView.update(
            workTabViewState(rt.workTab, rt.workTabView.contentWidth()),
        );
    }
    drawWorkspaceSidebar(rt);
    if (rt.searchOverlay !== undefined) {
        rt.searchOverlayView.update(searchOverlayViewState(
            rt.searchOverlay,
            rt.searchOverlayView.contentWidth(),
        ));
    }
    if (rt.help !== undefined) {
        rt.helpView.update(rt.help);
    }
    if (rt.doctorDialog !== undefined) {
        rt.doctorDialogView.update(rt.doctorDialog);
    }
    if (rt.diagnosticsDialog !== undefined) {
        if (rt.diagnosticsDialogView.contentWidth() !== rt.diagnosticsReportWidth) {
            rt.diagnosticsDialog = {
                ...rt.diagnosticsDialog,
                text: renderDiagnostics(rt),
            };
        }
        rt.diagnosticsDialogView.update(rt.diagnosticsDialog);
    }
    if (rt.extensionsDialog !== undefined) {
        rt.extensionsDialogView.update(rt.extensionsDialog);
    }
    if (rt.documentDialog !== undefined) {
        const text = rt.documentDialog.renderMarkdown?.(
            rt.documentDialogView.contentWidth(),
        ) ?? rt.documentDialog.text;
        if (text !== rt.documentDialog.text) {
            rt.documentDialog = { ...rt.documentDialog, text };
        }
        rt.documentDialogView.update(rt.documentDialog);
    }
    if (rt.sessionTrashCandidate !== undefined) {
        rt.sessionTrashConfirmView.update(rt.sessionTrashCandidate.label);
    }
    if (rt.sessionCloseConfirm) {
        rt.sessionCloseConfirmView.update(rt.sessionTitle ?? "untitled");
    }
    if (rt.providerForgetCandidate !== undefined) {
        rt.providerForgetConfirmView.update(rt.providerForgetCandidate.label, (rt.state.modelSettings?.pooled ?? []).filter((row) => row.provider === rt.providerForgetCandidate?.providerId).length);
    }
    if (rt.overridesResetCandidate !== undefined) {
        rt.overridesResetConfirmView.update(rt.overridesResetCandidate);
    }
    if (rt.admissionDialog !== undefined) {
        rt.admissionDialogView.update(rt.admissionDialog, dialogAdmission(rt));
    }

    renderTranscriptEntries(rt, rt.state.entries);

    showSearchTarget(rt);
    renderStatus(rt);
}

export function showSearchTarget(rt: TuiRuntime): void {
    const target = rt.pendingSearchTarget;
    if (target === undefined || rt.client.agentId !== target.sessionId) {
        return;
    }
    const index = rt.state.entries.findIndex((entry) =>
        entry.kind !== "diff"
        && transcriptMessageId(entry.entryId) === target.entryId
    );
    if (index === -1) {
        if (rt.state.entries.length > 0) rt.pendingSearchTarget = undefined;
        return;
    }
    const node = rt.entryNodes[index];
    if (node === undefined) {
        setTranscriptWindowAround(rt, rt.state.entries, index);
        return;
    }
    if (rt.measuredEntryRows[index] === undefined) return;
    rt.pendingSearchTarget = undefined;
    rt.searchLanding = {
        sessionId: target.sessionId,
        entryId: target.entryId,
    };
    const landed = rt.state.entries[index];
    if (landed !== undefined) markSearchLanding(rt, landed, node);
    rt.transcript.scrollTo(
        rt.transcript.scrollTop + node.screenY - rt.transcript.viewport.screenY,
    );
}

export function drawWorkspaceSidebar(rt: TuiRuntime): void {
    if (rt.workspaceSidebar === undefined) {
        rt.workspaceSidebarDrawn = undefined;
        return;
    }
    const next = workspaceSidebarViewState(
        rt.workspaceSidebar,
        rt.renderer.width,
        new Date(),
        rt.workspaceRail,
        rt.workspaceSidebarFocused,
        activityFrame(rt),
    );
    const drawn = JSON.stringify(next);
    if (drawn === rt.workspaceSidebarDrawn) return;
    rt.workspaceSidebarDrawn = drawn;
    rt.workspaceSidebarView.update(next);
}

export function refreshTimedSurfaces(rt: TuiRuntime): void {
    if (rt.resumeOverlay.surface.visible) {
        rt.resumeOverlay.blink(Date.now());
    }
    if (rt.workTab !== undefined) {
        rt.workTabView.update(
            workTabViewState(rt.workTab, rt.workTabView.contentWidth()),
        );
    }
    applyWorkspaceRail(rt);
    drawWorkspaceSidebar(rt);
    if (rt.searchOverlay !== undefined) {
        rt.searchOverlayView.update(searchOverlayViewState(
            rt.searchOverlay,
            rt.searchOverlayView.contentWidth(),
        ));
    }
}

export function anyOverlayOpen(rt: TuiRuntime): boolean {
    return rt.onboardingWizard !== undefined
        || rt.dialStrip !== undefined
        || rt.experimentalTuiHost.hasModal()
        || focusedUiRequest(rt) !== undefined
        || rt.timelinePicker !== undefined
        || rt.secretPrompt !== undefined
        || rt.namePrompt !== undefined
        || rt.providerForm !== undefined
        || rt.requestOptionsEditor !== undefined
        || rt.settingsPicker !== undefined
        || rt.preferencesList !== undefined
        || rt.standingNudges !== undefined
        || rt.extensionsList !== undefined
        || rt.commandPalette !== undefined
        || rt.workTab !== undefined
        || rt.searchOverlay !== undefined
        || rt.help !== undefined
        || rt.doctorDialog !== undefined
        || rt.diagnosticsDialog !== undefined
        || rt.extensionsDialog !== undefined
        || rt.documentDialog !== undefined
        || rt.confirmingFullAccess
        || rt.admissionDialog !== undefined
        || rt.sessionTrashCandidate !== undefined
        || rt.sessionCloseConfirm
        || rt.providerForgetCandidate !== undefined
        || rt.jumpMenu !== undefined;
}

export function shiftTranscriptEntrySlots(rt: TuiRuntime, 
    from: number,
    to: number,
    delta: number,
): void {
    if (delta === 0) return;
    const moved: {
        node: TextRenderable | MarkdownRenderable | BoxRenderable;
        kind: TuiTranscriptEntry["kind"];
        rows: number | undefined;
    }[] = [];
    for (let index = from; index < to; index += 1) {
        const node = rt.entryNodes[index];
        const kind = rt.entryNodeKinds[index];
        if (node === undefined || kind === undefined) continue;
        moved.push({
            node,
            kind,
            rows: rt.measuredEntryRows[index],
        });
        delete rt.entryNodes[index];
        delete rt.entryNodeKinds[index];
        delete rt.measuredEntryRows[index];
    }
    moved.forEach((slot, offset) => {
        const target = from + delta + offset;
        slot.node.id = `entry-${target}`;
        rt.entryNodes[target] = slot.node;
        rt.entryNodeKinds[target] = slot.kind;
        if (slot.rows === undefined) delete rt.measuredEntryRows[target];
        else rt.measuredEntryRows[target] = slot.rows;
    });
}

export function reseedTranscriptNodes(rt: TuiRuntime, 
    entries: readonly TuiTranscriptEntry[],
): void {
    const previous: (TuiTranscriptEntry | undefined)[] = [];
    for (
        let index = rt.materializedEntryStart;
        index < rt.materializedEntryEnd;
        index += 1
    ) {
        const node = rt.entryNodes[index];
        previous[index] = node === undefined
            ? undefined
            : rt.entryNodeSources.get(node);
    }
    const kept = tuiTranscriptReusableTail({
        previous,
        next: entries,
        previousStart: rt.materializedEntryStart,
        previousEnd: rt.materializedEntryEnd,
    });
    if (kept === 0) {
        clearTranscriptNodes(rt);
        return;
    }
    const oldEnd = rt.materializedEntryEnd;
    const newEnd = entries.length;
    const dropTo = oldEnd - kept;
    for (let index = rt.materializedEntryStart; index < dropTo; index += 1) {
        destroyTranscriptEntryNode(rt, index);
    }
    shiftTranscriptEntrySlots(rt, dropTo, oldEnd, newEnd - oldEnd);
    rt.materializedEntryStart = newEnd - kept;
    rt.materializedEntryEnd = newEnd;
    rt.pendingTranscriptScrollAnchor = undefined;
    rt.pendingTranscriptScrollRestore = {
        scrollTop: rt.transcript.scrollTop,
        atBottom: tuiTranscriptAtBottom(
            rt.transcript.scrollTop,
            rt.transcript.scrollHeight,
            rt.transcript.viewport.height,
        ),
    };
}

export function clearTranscriptNodes(rt: TuiRuntime): void {
    if (rt.state.entries.length > 0) {
        rt.pendingTranscriptScrollRestore = {
            scrollTop: rt.transcript.scrollTop,
            atBottom: tuiTranscriptAtBottom(
                rt.transcript.scrollTop,
                rt.transcript.scrollHeight,
                rt.transcript.viewport.height,
            ),
        };
    } else {
        rt.pendingTranscriptScrollRestore = undefined;
    }
    rt.experimentalTuiHost.clearTranscriptRenderables();
    for (const node of rt.entryNodes) {
        node?.destroyRecursively();
    }
    rt.entryNodes.length = 0;
    rt.entryNodeKinds.length = 0;
    rt.measuredEntryRows.length = 0;
    rt.materializedEntryStart = 0;
    rt.materializedEntryEnd = 0;
    rt.pendingTranscriptScrollAnchor = undefined;
    rt.transcriptWindowTopSpacer.height = 0;
    rt.transcriptWindowTopSpacer.visible = false;
    rt.transcriptWindowBottomSpacer.height = 0;
    rt.transcriptWindowBottomSpacer.visible = false;
}
