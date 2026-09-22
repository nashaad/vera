import { createTuiWorkedDivider, updateTuiWorkedDivider } from "../worked-divider.ts";
import { isConfigurationRequiredUiRequestUpdate, type AgentUpdate } from "../../../src/engine/protocol.ts";
import type { IdentifiedTuiAgentClient } from "../agent-client.ts";
import { resolveTuiHostedAgentAddressing, type TuiHostedAgentAddressing } from "../agent-message-routing.ts";
import type { TuiAgentPane } from "../agent-pane.ts";
import { createTuiDiff, repaintTuiDiff } from "../diff.ts";
import { createTuiGutterEntry, repaintTuiGutterEntry, tuiGutterContent, tuiGutterWidth } from "../gutter.ts";
import { assistantFollowsTools, defaultModelChangeNotice, isSettingsRetryTrigger, modelPickerActionOptions, notifyExtensionSettings, refreshSessionPicker, refreshWorkspaceSidebarRoster, rejectionNotice, renderSidebarJump, renderState, retryMissingAgentSettings, settleExtensionModelSettings, syncConfigurationRequiredRequest } from "../main.ts";
import { hostOwnsPromptQueue, modelSettingsForOpenPicker, setSidebarFocused } from "../main/agents-dials.ts";
import { isSearchLanding } from "../main/chrome.ts";
import { createTuiMarkdownEntry, tuiMarkdownEntryContent } from "../markdown-entry.ts";
import { syncTuiModelPicker } from "../settings-picker.ts";
import { TUI_MUTED, TUI_TEXT, appendTuiError, appendTuiNotice, beginNextQueuedTuiTurn, renderTuiEntry, tuiDisplayPath, tuiEntryMarginTop, type TuiTranscriptEntry } from "../state.ts";
import { tuiHandleActiveColor, tuiHandleColor } from "../theme.ts";
import { createTuiNoticeCard, repaintTuiNoticeCard, updateTuiNoticeCard } from "../notice-card.ts";
import { createTuiThinkingWindow, updateTuiThinkingWindow } from "../thinking-window.ts";
import { createTuiToolHeader, createTuiToolRow, updateTuiToolHeader, updateTuiToolRow } from "../tool-row.ts";
import { tuiTranscriptEntryIsVisible, tuiTranscriptEntryStreams } from "../transcript-window.ts";
import { createTuiUserEntry, repaintTuiUserEntry } from "../user-entry.ts";
import type { TuiRuntime } from "./runtime.ts";
import { BoxRenderable, MarkdownRenderable, TextRenderable } from "@opentui/core";

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
        ? createTuiWorkedDivider(rt.renderer, id, entry.text)
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
        ? createTuiThinkingWindow(rt.renderer, id, entry, inner)
        : entry.kind === "notice" && entry.card === true
        ? createTuiNoticeCard(rt.renderer, id, entry, inner)
        : markdownNode ?? new TextRenderable(rt.renderer, {
            id,
            content: renderTuiEntry(entry),
            width: "100%",
            wrapMode: "word",
            selectable: true,
            marginTop: inner,
        });
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

export function renderSidebarAgent(rt: TuiRuntime, 
    pane: TuiAgentPane<IdentifiedTuiAgentClient>,
    requestPaint = true,
    repaintTheme = false,
): void {
    if (pane !== rt.hostedSidebar.pane) return;
    const entries = pane.state.state.entries;
    const changedKindAt = entries.findIndex((entry, index) =>
        rt.sidebarEntryNodes[index] !== undefined
        && rt.sidebarEntryNodeKinds[index] !== entry.kind
    );
    const retained = changedKindAt === -1
        ? Math.min(entries.length, rt.sidebarEntryNodes.length)
        : changedKindAt;
    const discarded = rt.sidebarEntryNodes.splice(retained);
    rt.sidebarEntryNodeKinds.splice(retained);

    entries.forEach((entry, index) => {
        const wrapper = rt.sidebarEntryNodes[index];
        if (wrapper !== undefined) {
            wrapper.visible = tuiTranscriptEntryIsVisible(entry);
            if (repaintTheme) {
                repaintTuiGutterEntry(wrapper, {
                    separatorColor: rt.appearance.transcriptSeparatorColor
                        ?? rt.theme.element,
                });
            }
            const existing = tuiGutterContent(wrapper);
            if (existing instanceof MarkdownRenderable) {
                if (repaintTheme) {
                    existing.syntaxStyle = rt.markdownStyle;
                    existing.fg = entry.kind === "assistant"
                        || entry.kind === "notification"
                        ? TUI_MUTED
                        : TUI_TEXT;
                }
                if (existing.content !== tuiMarkdownEntryContent(entry)) {
                    existing.content = tuiMarkdownEntryContent(entry);
                }
            } else if (
                entry.kind === "user"
                && existing instanceof BoxRenderable
            ) {
                if (repaintTheme) repaintTuiUserEntry(existing);
            } else if (
                entry.kind === "notice" && entry.card === true
                && existing instanceof BoxRenderable
            ) {
                if (repaintTheme) repaintTuiNoticeCard(existing);
                updateTuiNoticeCard(existing, entry);
            } else if (
                entry.kind === "diff"
                && existing instanceof BoxRenderable
            ) {
                if (repaintTheme) repaintTuiDiff(existing, rt.markdownStyle);
            } else if (
                entry.kind === "tool"
                && existing instanceof BoxRenderable
            ) {
                updateTuiToolRow(existing, entry);
            } else if (
                entry.kind === "tool_header"
                && existing instanceof BoxRenderable
            ) {
                updateTuiToolHeader(existing, entry);
            } else if (
                entry.kind === "thinking"
                && existing instanceof BoxRenderable
            ) {
                updateTuiThinkingWindow(existing, entry);
            } else if (entry.kind === "worked" && existing instanceof BoxRenderable) {
                updateTuiWorkedDivider(existing, entry.text);
            } else if (existing instanceof TextRenderable) {
                existing.content = renderTuiEntry(entry);
            }
            return;
        }

        const id = `sidebar-entry-${++rt.sidebarEntryGeneration}`;
        const node = createTuiEntryNode(rt, 
            id,
            entry,
            tuiEntryMarginTop(entries, index, rt.entrySpacing),
            assistantFollowsTools(entries, index),
            tuiTranscriptEntryStreams(
                entries,
                index,
                pane.state.state.working,
            ),
        );
        node.visible = entry.kind !== "tool" || entry.hidden !== true;
        rt.sidebarEntryNodes.push(node);
        rt.sidebarEntryNodeKinds.push(entry.kind);
    });
    rt.sidebar.replaceRendered(rt.sidebarEntryNodes.map((node, index) => ({
        node,
        speaker: entries[index]?.kind === "user" ? "you" : "agent",
    })));
    for (const node of discarded) node.destroyRecursively();
    renderSidebarJump(rt);
    if (requestPaint) {
        renderState(rt);
    }
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
            pane.state.activity = "thinking";
        } else {
            pane.state.workingSince = undefined;
            pane.state.phaseSince = undefined;
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
