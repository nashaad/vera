import { setTextContent } from "../text-content.ts";
import { isToolApprovalUiRequestUpdate } from "../../../src/engine/protocol.ts";
import { renderTuiActivityBar, tuiActivityBarColumns, tuiActivityKind } from "../activity-bar.ts";
import { fitFooter } from "../footer-fit.ts";
import { tuiKeysCardRows } from "../keys-card.ts";
import { footerItemContents } from "../footer-items.ts";
import { footerRowCount } from "../footer-layout.ts";
import { renderTuiActivityAnimation, renderTuiSpokes, transcriptShimmerFrame } from "../activity-pulse.ts";
import { tuiApprovalHint } from "../approval.ts";
import { AUTO_MODE_ANIMATION_DURATION_MS, mapDialRows, paintDialHud } from "../dial-paint.ts";
import { DIAL_EXIT_SEPARATOR, renderDialStrip } from "../dials.ts";
import { isHomeClient } from "../home-client.ts";
import { isWorkerFreeClient } from "../jsonl-view-client.ts";
import { tuiKeyChordLabel, tuiKeyHint } from "../keymap.ts";
import { IDLE_KEYS_HINT, QUESTION_HINT, READY_HINT, STOPPING_HINT, WORKING_HINT, activityFrame, elapsedWorkingTime, shortConnectionFailure, truncateFooterLine, tuiDevInstancePrefix } from "../main.ts";
import { focusedAbortRequested, focusedAgentClient, focusedAgentState, focusedUiRequest } from "../main/agents-dials.ts";
import { setComposerMargin } from "../main/chrome.ts";
import { paneHeaderText, renderHeldAddress, renderJumpToBottom, renderPendingQuote, renderSidebarJump } from "../main/notices.ts";
import { anyOverlayOpen } from "../main/render-state.ts";
import { animateLiveThinking, animateLiveToolHeaders } from "../main/transcript-nodes.ts";
import { workingLineText } from "../main/watchers.ts";
import { standingNudgeIndicatorRow } from "../standing-nudges.ts";
import { TUI_ACCENT, TUI_ELEMENT, TUI_HUD, TUI_MUTED, TUI_NOTICE, TUI_PANEL, TUI_SUCCESS, TUI_TEXT } from "../state.ts";
import { needsYouChipColumns, statusChunkColor, renderTuiCompactionHint, renderTuiFileViewStatusRows, renderTuiIdleHint, renderTuiStatusDetailsRows, renderTuiStatusSegments, statusToneColor, tuiStatusSnapshot, type TuiStatusChunk } from "../status.ts";
import { VERA_TUI_THEME } from "../theme.ts";
import type { TuiRuntime } from "./runtime.ts";
import { StyledText, bg, fg } from "@opentui/core";

export function renderStatus(rt: TuiRuntime): void {
    if (rt.shuttingDown) {
        return;
    }
    const statusState = focusedAgentState(rt);
    if (anyOverlayOpen(rt) || rt.sessionSwitchPending) rt.modelPrefixPending = false;
    if (rt.settingsPicker?.kind === "model" && rt.settingsPicker.browseFeedback?.status === "working") {
        rt.settingsPickerView.animateFeedback(transcriptShimmerFrame(Date.now()), rt.activityAnimation !== "off");
    }
    if (rt.settingsPicker?.kind === "session") {
        rt.settingsPickerView.animateSessionTitles(transcriptShimmerFrame(Date.now()), rt.activityAnimation !== "off");
    }
    if (rt.animationsPreviewOpen) {
        rt.animationsPreviewView.update(rt.animationLevel, Date.now());
    }
    rt.transcriptWorking.visible = rt.state.working && !isWorkerFreeClient(rt.client);
    if (rt.transcriptWorking.visible) {
        setTextContent(rt.transcriptWorking, renderTuiActivityAnimation(
            rt.activityAnimation === "off" ? "off" : "shimmer",
            transcriptShimmerFrame(Date.now()),
            workingLineText(rt, rt.transcriptWorking.width),
            { active: TUI_ACCENT, trail: TUI_ELEMENT, inactive: TUI_MUTED, text: TUI_ACCENT },
        ));
        if (rt.activityAnimation !== "off") {
            animateLiveToolHeaders(rt, transcriptShimmerFrame(Date.now()));
            animateLiveThinking(rt, Math.floor(Date.now() / 80));
        }
    }
    const uiRequest = focusedUiRequest(rt);
    const focusedSide = rt.sidebar.isFocused() ? rt.hostedSidebar.pane : undefined;
    const focusedAbort = focusedAbortRequested(rt);
    const focusedActivity = focusedSide?.state.activity ?? rt.activity;
    const focusedElapsed = focusedSide?.state.elapsedWorkingTime()
        ?? elapsedWorkingTime(rt);
    const layout = rt.sidebar.layout();
    const sideState = rt.hostedSidebar.pane?.state.state;
    const paneHeadersVisible = !anyOverlayOpen(rt);
    const sideWidth = rt.sidebar.width();
    const railInset = rt.workspaceSidebarView.railColumns() ?? 0;
    const mainWidth = Math.max(1, rt.renderer.width - sideWidth - 1);
    rt.sidebar.setMainHeader(!paneHeadersVisible || !rt.mainHeaderVisible
        ? undefined
        : rt.hostedSidebar.pane !== undefined
        ? paneHeaderText(rt, 
            "Vera",
            rt.state.approvalMode,
            rt.state.modelSettings,
            layout === "split" ? mainWidth : rt.renderer.width,
            layout === "split",
        )
        : undefined);
    rt.sidebar.setHeader(
        paneHeadersVisible
            && rt.sidebarHeaderVisible
            && rt.hostedSidebar.pane !== undefined
            && sideState !== undefined
        ? paneHeaderText(rt, 
            rt.sidebarSessionTitle
                ?? rt.hostedSidebar.mention
                ?? rt.hostedSidebar.pane!.agentId,
            sideState.approvalMode,
            sideState.modelSettings,
            layout === "split" ? sideWidth : rt.renderer.width,
            layout === "split",
        )
        : undefined);
    renderPendingQuote(rt);
    renderHeldAddress(rt);
    renderJumpToBottom(rt);
    renderSidebarJump(rt);

    let lifecycleHint = renderTuiIdleHint(
        READY_HINT,
        rt.runningBackgroundAgents,
    );
    if (rt.sessionSwitchPending) {
        lifecycleHint = rt.sessionSwitchActivity;
    } else if (rt.connectionFailed) {
        lifecycleHint = `disconnected${
            rt.connectionFailure === undefined
                ? ""
                : `: ${shortConnectionFailure(rt.connectionFailure)}`
        } · Ctrl+P reconnect · Ctrl+C quit`;
    } else if (focusedAbort) {
        lifecycleHint = `${STOPPING_HINT} · ${focusedElapsed}`;
    } else if (
        uiRequest !== undefined
        && isToolApprovalUiRequestUpdate(uiRequest)
    ) {
        lifecycleHint = tuiApprovalHint(uiRequest);
    } else if (uiRequest?.request.type === "user_question") {
        lifecycleHint = `${QUESTION_HINT} · ${focusedElapsed}`;
    } else if (statusState.compactingSince !== undefined) {
        lifecycleHint = renderTuiCompactionHint(
            Date.now() - statusState.compactingSince,
            {
                strategy: statusState.compactionStrategy,
                provider: statusState.compactionProvider,
                model: statusState.compactionModel,
            },
            rt.animationLevel > 0,
        );
    } else if (statusState.working) {
        const modelActivity = statusState.modelActivity;
        const waitingToRetry = modelActivity !== undefined
            && Date.parse(modelActivity.retryAt) > Date.now();
        lifecycleHint = waitingToRetry
            ? `retrying · attempt ${modelActivity.nextAttempt}/${modelActivity.maxAttempts}`
                + ` · ${focusedElapsed}`
            : `${modelActivity === undefined ? focusedActivity : "thinking"}`
                + ` · ${focusedElapsed}`
                + (statusState.autoApprovals === undefined
                    ? ""
                    : ` · ${statusState.autoApprovals.length} auto-approved`);
    } else if (rt.pendingImages.some((image) => image.id === undefined)) {
        lifecycleHint = "attaching image…";
    } else if (rt.promptSubmitting) {
        lifecycleHint = rt.pendingSkillInvocations.size > 0
            ? "invoking skill…"
            : "sending prompt with image…";
    } else if (rt.extensionCommandPending) {
        lifecycleHint =
            `${rt.extensionCommandActivity ?? "running extension command"} · Ctrl+C quit`;
    } else if (rt.pendingImages.length > 0) {
        lifecycleHint = `${rt.pendingImages.length} image${rt.pendingImages.length === 1 ? "" : "s"} attached · enter send`;
    }

    if (
        isWorkerFreeClient(rt.client)
        && !rt.sessionSwitchPending
        && !rt.connectionFailed
    ) {
        lifecycleHint = "";
    }

    const statusColor = statusState.approvalMode === "full_access"
        ? rt.theme.critical
        : rt.statusNotice !== undefined
        ? TUI_NOTICE
        : statusState.working
                || statusState.compactingSince !== undefined
                || uiRequest !== undefined
                || rt.extensionCommandPending
            ? TUI_ACCENT
            : TUI_MUTED;
    const hostedControls = rt.hostedSidebar.pane === undefined
        ? []
        : [
            `${rt.hostedSidebar.modeLabel ?? rt.hostedSidebar.mention ?? "agent"} mode`,
            rt.sidebar.layout() === "split"
                ? "split"
                : rt.sidebar.layout() === "sidebar"
                ? `${rt.hostedSidebar.modeLabel ?? rt.hostedSidebar.mention ?? "agent"} only`
                : "vera only",
            "Ctrl+\\ layout",
            ...(rt.sidebar.layout() === "split"
                ? [rt.sidebar.isFocused()
                    ? "Ctrl+G vera"
                    : `Ctrl+G ${rt.hostedSidebar.mention ?? rt.hostedSidebar.pane.agentId}`]
                : []),
        ];
    const placeIdle = !focusedAbort
        && !statusState.working
        && statusState.compactingSince === undefined
        && uiRequest === undefined
        && !rt.sessionSwitchPending
        && !rt.connectionFailed
        && !rt.promptSubmitting
        && !rt.extensionCommandPending
        && rt.pendingImages.length === 0
        && !isWorkerFreeClient(rt.client);
    const statusLine = [
        tuiDevInstancePrefix(),
        rt.statusNotice ?? lifecycleHint,
    ].filter((part) => part.length > 0).join(" ");
    const keysHint = statusState.working && uiRequest === undefined && !focusedAbort
        ? WORKING_HINT
        : placeIdle
        ? IDLE_KEYS_HINT
        : "";
    const dialWidth = Math.max(
        1,
        rt.renderer.width - rt.composerHorizontalInset - railInset,
    );
    const stripLines = rt.dialStrip === undefined
        ? undefined
        : renderDialStrip(
            rt.dialStrip,
            [
                "↑/↓ lane",
                `${tuiKeyChordLabel("dials.pair.prev")}/${
                    tuiKeyChordLabel("dials.pair.next")
                } change`,
                "⏎ apply",
            ].join(" · "),
            dialWidth,
        );
    rt.dialCard.visible = stripLines !== undefined;
    rt.keysCardView.box.visible = rt.keysCardOpen && !anyOverlayOpen(rt) && !rt.sessionSwitchPending;
    if (rt.keysCardView.box.visible) {
        rt.keysCardView.update(tuiKeysCardRows(turnRunningNow(statusState)), dialWidth);
    }
    rt.dialCard.backgroundColor = TUI_HUD?.background ?? TUI_PANEL;
    const hudRows = stripLines?.slice(0, -1) ?? [];
    rt.dialCardTitle.selectable = false;
    rt.dialCardTitle.onMouseDown = (event) => {
        if (event.button !== 0 || rt.dialStrip === undefined) return;
        const rows = mapDialRows(hudRows);
        const row = event.y - rt.dialCardTitle.screenY;
        const lane = row === rows.agent ? "agent" : row === rows.access ? "access" : undefined;
        if (lane === undefined) return;
        event.preventDefault(); event.stopPropagation(); rt.renderer.clearSelection();
        rt.dialStrip = { ...rt.dialStrip, lane };
        renderStatus(rt);
    };
    rt.dialCardTitle.height = Math.max(1, hudRows.length);
    rt.dialCard.height = hudRows.length + 3;
    const hudBg = TUI_HUD?.background ?? TUI_PANEL;
    const hudText = TUI_HUD?.text ?? TUI_TEXT;
    const hudMuted = TUI_HUD?.muted ?? TUI_MUTED;
    const hudAccent = TUI_HUD?.accent ?? TUI_ACCENT;
    const hudNotice = TUI_HUD?.notice ?? TUI_NOTICE;
    const hudSuccess = TUI_HUD?.success ?? VERA_TUI_THEME.success;
    setTextContent(rt.dialCardTitle, new StyledText(
        paintDialHud(hudRows, rt.dialStrip?.lane, {
            text: hudText,
            muted: hudMuted,
            accent: hudAccent,
            notice: hudNotice,
            background: hudBg,
            success: TUI_HUD?.success ?? TUI_SUCCESS,
            secondary: rt.theme.secondary,
            accessAsk: VERA_TUI_THEME.accent,
            accessAuto: VERA_TUI_THEME.hud?.auto
                ?? VERA_TUI_THEME.success,
        }, {
            autoAnimation: rt.autoModeAnimationStartedAt === undefined
                ? undefined
                : {
                    progress: Math.min(
                        1,
                        (Date.now() - rt.autoModeAnimationStartedAt)
                        / AUTO_MODE_ANIMATION_DURATION_MS,
                    ),
                    width: dialWidth,
                },
        }).flatMap((spans, index) => [
            ...spans.map((span) =>
                fg(span.color)(
                    span.background === undefined
                        ? span.text
                        : bg(span.background)(span.text)
                )
            ),
            ...(index === hudRows.length - 1 ? [] : [fg(hudText)("\n")]),
        ]),
    ));
    const dialHintParts = (stripLines?.at(-1) ?? "")
        .split(DIAL_EXIT_SEPARATOR);
    setTextContent(rt.dialCardHint, stripLines === undefined
        ? ""
        : new StyledText([
            fg(hudMuted)(dialHintParts[0] ?? ""),
            fg(hudNotice)(dialHintParts[1] ?? ""),
        ]));
    const extensionSegments = rt.clientExtensionRegistry?.renderStatusLine(
        tuiStatusSnapshot(
            statusState.modelSettings,
            statusState.approvalMode,
            statusState.context,
            process.cwd(),
            rt.runningBackgroundAgents,
            rt.state.working
                ? "working"
                : uiRequest === undefined
                    ? "idle"
                    : "waiting",
        ),
    );
    const turnRunning = turnRunningNow(statusState);
    const statusDetailsRows: TuiStatusChunk[][] = isWorkerFreeClient(rt.client)
        ? renderTuiFileViewStatusRows(
            rt.client.workspace ?? process.cwd(),
            rt.workspaceBranch.current(),
        )
        : extensionSegments === undefined
        ? renderTuiStatusDetailsRows(
                statusState.modelSettings,
                statusState.approvalMode,
                statusState.context,
                process.cwd(),
                0,
                statusState.effortSubstitution,
                rt.hostedSidebar.pane === undefined,
                rt.workspaceBranch.current(),
                {
                    ...(statusState.agent === undefined
                        ? {}
                        : { agent: statusState.agent.name }),
                    postureOverridden:
                        statusState.approvalModeOrigin === "user"
                        && statusState.approvalMode
                            !== statusState.agent?.posture,
                    ...(statusState.modelFallback === undefined
                        ? {}
                        : { fallbackTo: statusState.modelFallback.to }),
                },
                rt.workIndex?.needs_you ?? 0,
                Math.max(1, rt.renderer.width - rt.composerHorizontalInset - railInset),
            )
        : [[{
                tone: "muted",
                text: renderTuiStatusSegments(
                    rt.hostedSidebar.pane === undefined
                        ? extensionSegments
                        : extensionSegments.filter((segment) =>
                            segment.kind !== "permissions"
                        ),
                ),
            }]];
    const runningNames = rt.runningBackgroundAgentNames.map((name) =>
        truncateFooterLine(
            `* ${name}`,
            Math.min(72, rt.renderer.width - rt.composerHorizontalInset - railInset),
        )
    );
    const cardWidth = Math.max(
        1,
        rt.renderer.width - rt.composerHorizontalInset - railInset,
    );
    const nudgeIndicator = isHomeClient(rt.client) || isWorkerFreeClient(rt.client)
        ? undefined
        : standingNudgeIndicatorRow(rt.standingNudgeRules, {
            agent: statusState.agent?.name ?? "default",
            workspace: focusedAgentClient(rt).workspace ?? "",
        }, cardWidth);
    const agentSection = rt.currentAgentHasParent
        ? ["/parent to return"]
        : runningNames.length === 0
            ? []
            : [
                `${runningNames.length} subagent${
                    runningNames.length === 1 ? "" : "s"
                } running · /subagents to attach`,
                ...runningNames,
            ];
    const agentHeader = agentSection[0] ?? "";
    const animatedAgentHeader = runningNames.length === 0
        ? new StyledText([fg(TUI_MUTED)(agentHeader)])
        : rt.activityAnimation === "off"
        ? new StyledText([fg(TUI_MUTED)(agentHeader)])
        : renderTuiSpokes(
            activityFrame(rt),
            agentHeader,
            {
                active: TUI_ACCENT,
                trail: rt.theme.activityTrail,
                inactive: TUI_ELEMENT,
                text: TUI_MUTED,
            },
        );
    rt.subscriptionLimits.selectProvider(isWorkerFreeClient(rt.client)
        ? undefined : statusState.modelSettings?.provider);
    const insideRow = statusDetailsRows[0] ?? [];
    setTextContent(rt.composerStatusText, new StyledText(
        insideRow.map((chunk) => fg(statusChunkColor(chunk))(chunk.text)),
    ));
    rt.needsYouChipWidth = needsYouChipColumns(
        insideRow,
        rt.workIndex?.needs_you ?? 0,
    );
    const noticeIndent = " ".repeat(rt.composerContentIndent);
    const noticeChunks = nudgeIndicator === undefined &&
            agentSection.length === 0
        ? []
        : [
            ...(nudgeIndicator === undefined
                ? []
                : [
                    fg(TUI_MUTED)(noticeIndent),
                    fg(TUI_ACCENT)("● "),
                    fg(TUI_MUTED)(
                        `${nudgeIndicator.status}${nudgeIndicator.gap}${nudgeIndicator.detail}`,
                    ),
                ]),
            ...(agentSection.length === 0
                ? []
                : [
                    fg(TUI_MUTED)(
                        `${nudgeIndicator === undefined ? "" : "\n"}${noticeIndent}`,
                    ),
                    ...animatedAgentHeader.chunks,
                    fg(TUI_MUTED)(
                        agentSection.length === 1
                            ? ""
                            : `\n${
                                agentSection.slice(1)
                                    .map((row) => `${noticeIndent}${row}`)
                                    .join("\n")
                            }`,
                    ),
                ]),
        ];
    rt.agentNoticeRows = agentSection.length +
        (nudgeIndicator === undefined ? 0 : 1);
    setTextContent(rt.agentNoticeText, new StyledText(noticeChunks));
    rt.agentNoticeText.height = Math.max(1, rt.agentNoticeRows);
    rt.agentNoticeText.visible = rt.agentNoticeRows > 0;
    const modelPrefixHint = `${tuiKeyHint("model_prefix_open")} · ${tuiKeyHint("model_prefix_keys")} · esc cancel`;
    const workerFree = isWorkerFreeClient(rt.client);
    const showStrip = !workerFree;
    const footer = fitFooter(rt.footerLayout, footerItemContents({
        status: rt.modelPrefixPending
            ? { text: modelPrefixHint, color: TUI_ACCENT }
            : { text: statusLine, color: statusColor },
        keys: keysHint,
        limits: rt.subscriptionLimits.forms(),
        ...(workerFree
            ? { place: { workspace: rt.client.workspace ?? process.cwd(), branch: rt.workspaceBranch.current() } }
            : extensionSegments === undefined
            ? { place: { workspace: process.cwd(), branch: rt.workspaceBranch.current() } }
            : {}),
        activity: showStrip
            ? activityBarChunks(rt, turnRunning, focusedAbort, focusedActivity,
                focusedSide?.state.reasoning ?? rt.reasoning,
                focusedSide === undefined ? rt.quietSince : focusedSide.state.quietSince)
            : [],
        activityColumns: showStrip ? tuiActivityBarColumns(rt.animationLevel) : 0,
        panes: hostedControls,
    }), turnRunning, cardWidth);
    rt.footerRows.forEach((row, index) => {
        const chunks = footer.rows[index];
        row.visible = chunks !== undefined;
        setTextContent(row, new StyledText((chunks ?? []).map((chunk) =>
            fg(statusChunkColor(chunk))(chunk.text)
        )));
    });
    setComposerMargin(rt, footerRowCount(rt.footerLayout));
}

function turnRunningNow(state: { readonly working: boolean; readonly compactingSince?: number }): boolean {
    return state.working || state.compactingSince !== undefined;
}

function activityBarChunks(
    rt: TuiRuntime,
    working: boolean,
    stopping: boolean,
    activity: string,
    reasoning: boolean,
    quietSince: number | undefined,
): TuiStatusChunk[] {
    if (stopping || !working || isWorkerFreeClient(rt.client)) return [];
    const now = Date.now();
    const quietMs = quietSince === undefined ? 0 : Math.max(0, now - quietSince);
    const kind = tuiActivityKind(activity, reasoning, quietMs);
    const cells = renderTuiActivityBar(kind, rt.animationLevel, now, { active: TUI_ACCENT, dim: TUI_ELEMENT });
    return cells.map((cell): TuiStatusChunk => ({ text: cell.glyph, tone: "accent", color: cell.color }));
}
