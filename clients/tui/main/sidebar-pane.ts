import { noteSidebarHistoryUpdate, renderSidebarTranscript } from "./sidebar-transcript.ts";
import { createTuiWorkedDivider, tuiWorkedDividerView } from "../worked-divider.ts";
import { isConfigurationRequiredUiRequestUpdate, type AgentUpdate } from "../../../src/engine/protocol.ts";
import type { IdentifiedTuiAgentClient } from "../agent-client.ts";
import { resolveTuiHostedAgentAddressing, type TuiHostedAgentAddressing } from "../agent-message-routing.ts";
import type { TuiAgentPane } from "../agent-pane.ts";
import { createTuiDiff } from "../diff.ts";
import { adoptReportedPermission } from "../dials.ts";
import { createTuiGutterEntry, tuiGutterContent, tuiGutterWidth } from "../gutter.ts";
import { defaultModelChangeNotice, isSettingsRetryTrigger, modelPickerActionOptions, notifyExtensionSettings, refreshSessionPicker, refreshWorkspaceSidebarRoster, rejectionNotice, renderSidebarJump, renderState, retryMissingAgentSettings, settleExtensionModelSettings, syncConfigurationRequiredRequest } from "../main.ts";
import { hostOwnsPromptQueue, modelSettingsForOpenPicker, setSidebarFocused } from "../main/agents-dials.ts";
import { settleQueueRecall } from "./queue-recall.ts";
import { isSearchLanding } from "../main/chrome.ts";
import { createTuiMarkdownEntry } from "../markdown-entry.ts";
import { installTuiTextLinkHandler, openTuiLink } from "../markdown-links.ts";
import { syncTuiModelPicker } from "../settings-picker.ts";
import { TUI_MUTED, TUI_TEXT, appendTuiError, appendTuiNotice, beginNextQueuedTuiTurn, renderTuiEntry, tuiDisplayPath, toggleTuiWorkedRow, tuiEntryIsErrorRow, type TuiTranscriptEntry } from "../state.ts";
import { tuiHandleActiveColor, tuiHandleColor } from "../theme.ts";
import { createTuiNoticeCard } from "../notice-card.ts";
import { createTuiErrorRow, tuiErrorRowText } from "../error-row.ts";
import { createTuiReasoningBlock } from "../reasoning-block.ts";
import { createTuiThinkingWindow } from "../thinking-window.ts";
import { createTuiToolHeader, createTuiToolRow } from "../tool-row.ts";
import { createTuiUserEntry } from "../user-entry.ts";
import type { TuiRuntime } from "./runtime.ts";
import { BoxRenderable, MarkdownRenderable, TextRenderable, type Renderable } from "@opentui/core";

export function hostedAgentAddressing(rt: TuiRuntime): TuiHostedAgentAddressing {
    const declared = rt.clientExtensionRegistry
        ?.experimentalHostedAgentAddressing(rt.hostedSidebar.owner);
    return resolveTuiHostedAgentAddressing({
        declared,
        hasSidebar: rt.hostedSidebar.pane !== undefined,
        sidebarMention: rt.hostedSidebar.mention,
        sidebarAgentId: rt.hostedSidebar.pane?.agentId,
    });
}

export function sidebarTranscriptWidth(rt: TuiRuntime): number {
    return Math.max(
        1,
        (rt.sidebar.layout() === "sidebar"
            ? rt.renderer.terminalWidth - 1
            : rt.sidebar.width()) - 2,
    );
}

export function mainTranscriptWidth(rt: TuiRuntime): number {
    if (rt.transcript === rt.sidebar.content) return sidebarTranscriptWidth(rt);
    return Math.max(
        1,
        rt.renderer.terminalWidth
            - (rt.sidebar.isShown() ? rt.sidebar.width() + 1 : 0)
            - 4,
    );
}

export function rememberOpenPaneGroup(rt: TuiRuntime): void {
    rt.hostedPanePersistence.remember({
        mainAgentId: rt.client.agentId,
        sidebarAgentId: rt.hostedSidebar.pane?.agentId,
        owner: rt.hostedSidebar.owner,
        mention: rt.hostedSidebar.mention,
        statusLabel: rt.hostedSidebar.modeLabel,
        attachmentLifetime: rt.hostedSidebar.attachmentLifetime,
    });
}

export function forgetPersistedAgentPane(rt: TuiRuntime, mainAgentId = rt.client.agentId): void {
    rt.hostedPanePersistence.forget(mainAgentId);
}

function toggleWorkedDivider(rt: TuiRuntime, node: BoxRenderable): void {
    const holds = (wrapper: Renderable | undefined): boolean =>
        wrapper !== undefined && tuiGutterContent(wrapper) === node;
    const main = rt.entryNodes.findIndex(holds);
    if (main !== -1) {
        rt.state = toggleTuiWorkedRow(rt.state, main);
        renderState(rt);
        return;
    }
    const pane = rt.hostedSidebar.pane;
    const side = rt.sidebarEntryNodes.findIndex(holds);
    if (pane === undefined || side === -1) return;
    pane.state.state = toggleTuiWorkedRow(pane.state.state, side);
    renderSidebarAgent(rt, pane);
}

export function createTuiEntryNode(rt: TuiRuntime, 
    id: string,
    entry: TuiTranscriptEntry,
    marginTop: number,
    separated: boolean,
    streaming = false,
): TextRenderable | MarkdownRenderable | BoxRenderable {
    const inner = entry.kind === "user" ? marginTop : 0;
    const marked = isSearchLanding(rt, entry);
    const markdownNode = entry.kind === "diff"
        ? undefined
        : createTuiMarkdownEntry(
            rt.renderer,
            id,
            entry,
            rt.markdownStyle,
            entry.kind === "assistant" || entry.kind === "notification"
                ? TUI_MUTED
                : TUI_TEXT,
            inner,
            streaming,
        );
    const node = entry.kind === "worked"
        ? createTuiWorkedDivider(rt.renderer, id, tuiWorkedDividerView(entry), (node) => toggleWorkedDivider(rt, node))
        : entry.kind === "tool"
        ? createTuiToolRow(rt.renderer, id, entry, inner)
        : entry.kind === "tool_header"
        ? createTuiToolHeader(rt.renderer, id, entry, inner)
        : entry.kind === "user"
        ? createTuiUserEntry(rt.renderer, id, entry, inner, marked)
        : entry.kind === "diff"
        ? createTuiDiff(
            rt.renderer,
            id,
            tuiDisplayPath(entry.path),
            entry.patch,
            rt.markdownStyle,
            inner,
        )
        : entry.kind === "thinking"
        ? createTuiThinkingWindow(rt.renderer, id, entry, inner, rt.liveReasoningRows)
        : entry.kind === "thought"
        ? createTuiReasoningBlock(rt.renderer, id, entry, inner)
        : entry.kind === "notice" && entry.card === true
        ? createTuiNoticeCard(rt.renderer, id, entry, inner)
        : tuiEntryIsErrorRow(entry)
        ? createTuiErrorEntry(rt, id, entry, inner)
        : markdownNode ?? createTuiTextEntry(rt, id, entry, inner);
    return entry.kind === "user"
        ? node
        : createTuiGutterEntry(
            rt.renderer,
            id,
            entry,
            node,
            marginTop,
            separated,
            {
                assistantMarker: rt.appearance.assistantMarker,
                width: tuiGutterWidth(entry, rt.appearance.activityIndent),
                separatorVisible: rt.appearance.separatorVisible,
                separatorColor: rt.appearance.transcriptSeparatorColor
                    ?? rt.theme.element,
                separatorSpacingBefore:
                    rt.appearance.separatorSpacingBefore,
                separatorSpacingAfter: rt.appearance.separatorSpacingAfter,
                ...(marked ? { marked: true } : {}),
            },
        );
}

function createTuiErrorEntry(rt: TuiRuntime,
    id: string,
    entry: TuiTranscriptEntry,
    marginTop: number,
): BoxRenderable {
    const row = createTuiErrorRow(rt.renderer, id, entry, marginTop);
    const text = tuiErrorRowText(row);
    if (text !== undefined) installTuiTextLinkHandler(text, openTuiLink);
    return row;
}

function createTuiTextEntry(rt: TuiRuntime,
    id: string,
    entry: TuiTranscriptEntry,
    marginTop: number,
): TextRenderable {
    const text = new TextRenderable(rt.renderer, {
        id,
        content: renderTuiEntry(entry),
        width: "100%",
        wrapMode: "word",
        selectable: true,
        marginTop,
    });
    // The TUI owns the mouse, so the terminal's own URL click never fires.
    if (entry.kind === "notice") installTuiTextLinkHandler(text, openTuiLink);
    return text;
}

export function renderSidebarAgent(rt: TuiRuntime, 
    pane: TuiAgentPane<IdentifiedTuiAgentClient>,
    requestPaint = true,
    repaintTheme = false,
): void {
    renderSidebarTranscript(rt, pane, false, repaintTheme);
    renderSidebarJump(rt);
    if (requestPaint) renderState(rt);
}

export function repaintSidebarForTheme(rt: TuiRuntime): void {
    rt.sidebar.setTheme(sidebarTheme(rt), rt.markdownStyle);
    const pane = rt.hostedSidebar.pane;
    if (pane === undefined) return;
    renderSidebarAgent(rt, pane, false, true);
}

export function handleSidebarAgentUpdate(rt: TuiRuntime, 
    update: AgentUpdate,
    pane: TuiAgentPane<IdentifiedTuiAgentClient>,
): void {
    if (pane !== rt.hostedSidebar.pane) return;
    if (update.type === "history") noteSidebarHistoryUpdate(rt, pane);
    settleQueueRecall(rt, update);
    if (
        update.type === "ui_request"
        && !(
            isConfigurationRequiredUiRequestUpdate(update)
            && rt.activeConfigurationRequest !== undefined
            && rt.activeConfigurationRequest.requestId !== update.requestId
        )
    ) {
        setSidebarFocused(rt, true);
    }
    if (
        update.type === "ui_request"
        || update.type === "ui_request_closed"
    ) {
        syncConfigurationRequiredRequest(rt, 
            pane.state.pendingUiRequest,
            pane.client,
        );
    }
    if (
        (update.type === "session_name"
            || update.type === "session_name_rejected")
        && update.requestId === rt.pendingSidebarSessionRename?.requestId
    ) {
        const pending = rt.pendingSidebarSessionRename;
        rt.pendingSidebarSessionRename = undefined;
        if (update.type === "session_name") {
            rt.sidebarSessionTitle = update.name ?? undefined;
            pane.state.state = appendTuiNotice(
                pane.state.state,
                update.name === null
                    ? "session name cleared"
                    : `session renamed: ${update.name}`,
            );
            if (rt.workspaceSidebar !== undefined) {
                refreshWorkspaceSidebarRoster(rt);
            }
            if (rt.settingsPicker?.kind === "session") {
                void refreshSessionPicker(rt);
            }
        } else {
            if (
                pending.commandText !== undefined
                && rt.composer.expandedText().length === 0
            ) {
                rt.composer.setComposerText(pending.commandText);
            }
            pane.state.state = appendTuiError(
                pane.state.state,
                update.reason === "invalid"
                    ? "Session name must be 1 to 200 UTF-8 bytes"
                    : "Could not rename this conversation",
            );
        }
    }
    if (update.type === "turn_finished") {
        if (!hostOwnsPromptQueue(rt, pane.client)) {
            pane.state.state = beginNextQueuedTuiTurn(pane.state.state);
        }
        if (pane.state.state.working) {
            pane.state.workingSince = Date.now();
            pane.state.phaseSince = pane.state.workingSince;
            pane.state.quietSince = pane.state.workingSince;
            pane.state.activity = "thinking";
        } else {
            pane.state.workingSince = undefined;
            pane.state.phaseSince = undefined;
            pane.state.quietSince = undefined;
            pane.state.activity = "ready";
        }
    }
    if (update.type === "model_settings") {
        settleExtensionModelSettings(rt, update, pane.client);
        const change = rt.requestedModelChanges.get(update.requestId);
        if (change?.target === pane.client) {
            rt.requestedModelChanges.delete(update.requestId);
        }
        if (
            change?.target === pane.client
            && update.updatedDefaults === true
        ) {
            pane.state.state = appendTuiNotice(
                pane.state.state,
                defaultModelChangeNotice(change.patch, update.settings),
                "soft",
            );
        }
        if (
            rt.sidebar.isFocused()
            && pane.state.state.modelSettings !== undefined
        ) {
            notifyExtensionSettings(rt, pane.state.state.modelSettings);
        }
        if (
            rt.settingsPicker?.kind === "model"
            && rt.settingsPickerAgent === pane.client
        ) {
            const pickerSettings = modelSettingsForOpenPicker(rt, 
                pane.state.state.modelSettings,
            );
            rt.settingsPicker = syncTuiModelPicker(rt.settingsPicker, {
                ...(pickerSettings ?? {}),
                actionOptions: modelPickerActionOptions(rt, pickerSettings),
            });
        }
    } else if (update.type === "model_settings_rejected") {
        settleExtensionModelSettings(rt, update, pane.client);
        const change = rt.requestedModelChanges.get(update.requestId);
        if (change?.target === pane.client) {
            rt.requestedModelChanges.delete(update.requestId);
            pane.state.state = appendTuiError(
                pane.state.state,
                rejectionNotice(change.subject, update.reason),
            );
        }
    } else if (update.type === "permissions") {
        rt.requestedPermissionChanges.delete(update.requestId);
        if (rt.dialStrip !== undefined && rt.sidebar.isFocused() && rt.hostedSidebar.pane === pane) {
            rt.dialStrip = adoptReportedPermission(rt.dialStrip, update.mode);
        }
    } else if (update.type === "permissions_rejected") {
        const subject = rt.requestedPermissionChanges.get(update.requestId);
        rt.requestedPermissionChanges.delete(update.requestId);
        if (subject !== undefined) {
            pane.state.state = appendTuiError(
                pane.state.state,
                rejectionNotice(subject, update.reason),
            );
        }
    }
    if (isSettingsRetryTrigger(rt, update)) {
        retryMissingAgentSettings(rt, pane.client, pane.state.state);
    }
}

export function sidebarTheme(rt: TuiRuntime) {
    return {
        handle: tuiHandleColor(rt.theme),
        handleActive: tuiHandleActiveColor(rt.theme),
        muted: rt.theme.muted,
        text: rt.theme.text,
        focus: rt.theme.focus,
        inactive: rt.theme.inactive,
    };
}
