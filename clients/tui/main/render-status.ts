import { verificationNudge } from "../model-verification.ts";
import { setTextContent } from "../text-content.ts";
import { isToolApprovalUiRequestUpdate } from "../../../src/engine/protocol.ts";
import { renderTuiActivityAnimation, renderTuiSpokes, transcriptShimmerFrame } from "../activity-pulse.ts";
import { tuiApprovalHint } from "../approval.ts";
import { AUTO_MODE_ANIMATION_DURATION_MS, paintDialHud } from "../dial-paint.ts";
import { DIAL_EXIT_SEPARATOR, DIAL_HUD_CAP, dialEffortPending, renderDialStrip } from "../dials.ts";
import { isHomeClient } from "../home-client.ts";
import { isWorkerFreeClient } from "../jsonl-view-client.ts";
import { tuiKeyChord, tuiKeyHint } from "../keymap.ts";
import { HUD_HINT, MODEL_PICKER_HINT, QUESTION_HINT, READY_HINT, SIDEBAR_HINT, STOPPING_HINT, WORKING_HINT, activityFrame, elapsedWorkingTime, quietHintColumns, shortConnectionFailure, truncateFooterLine, tuiDevInstancePrefix } from "../main.ts";
import { focusedAbortRequested, focusedAgentClient, focusedAgentState, focusedUiRequest } from "../main/agents-dials.ts";
import { setComposerMargin } from "../main/chrome.ts";
import { paneHeaderText, renderHeldAddress, renderJumpToBottom, renderPendingQuote, renderSidebarJump } from "../main/notices.ts";
import { anyOverlayOpen } from "../main/render-state.ts";
import { standingNudgeIndicatorRow } from "../standing-nudges.ts";
import { TUI_ACCENT, TUI_ELEMENT, TUI_HUD, TUI_MUTED, TUI_NOTICE, TUI_PANEL, TUI_SUCCESS, TUI_TEXT } from "../state.ts";
import { needsYouChipColumns, renderTuiCompactionHint, renderTuiFileViewStatusRows, renderTuiIdleHint, renderTuiStatusDetailsRows, renderTuiStatusSegments, statusToneColor, tuiPlaceRowModeLine, tuiStatusSnapshot, type TuiStatusChunk } from "../status.ts";
import { VERA_TUI_THEME } from "../theme.ts";
import type { TuiRuntime } from "./runtime.ts";
import { StyledText, bg, fg } from "@opentui/core";

export function renderStatus(rt: TuiRuntime): void {
    if (rt.shuttingDown) {
        return;
    }
    const statusState = focusedAgentState(rt);
    if (rt.settingsPicker?.kind === "model" && rt.settingsPicker.journeyFeedback?.status === "working") {
        rt.settingsPickerView.animateFeedback(transcriptShimmerFrame(Date.now()), rt.activityAnimation !== "off");
    }
    rt.transcriptWorking.visible = rt.state.working && !isWorkerFreeClient(rt.client);
    if (rt.transcriptWorking.visible) {
        setTextContent(rt.transcriptWorking, renderTuiActivityAnimation(
            rt.activityAnimation === "off" ? "off" : "shimmer",
            transcriptShimmerFrame(Date.now()),
            `Working (${elapsedWorkingTime(rt)} · esc to interrupt)`,
            { active: TUI_ACCENT, trail: TUI_ELEMENT, inactive: TUI_MUTED, text: TUI_ACCENT },
        ));
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
        )
        : !isHomeClient(rt.client)
        ? paneHeaderText(rt, rt.sessionTitle ?? "Vera", rt.state.approvalMode, rt.state.modelSettings, rt.renderer.width)
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
        )
        : undefined);
    const workingHint = focusedSide === undefined
        ? WORKING_HINT
        : `esc stop ${rt.hostedSidebar.mention ?? focusedSide.agentId}`
            + ` · ${tuiKeyHint("interrupt")}`;
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
        } · /reconnect · ctrl+c quit`;
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
        );
    } else if (statusState.working) {
        const modelActivity = statusState.modelActivity;
        const waitingToRetry = modelActivity !== undefined
            && Date.parse(modelActivity.retryAt) > Date.now();
        lifecycleHint = waitingToRetry
            ? `retrying · attempt ${modelActivity.nextAttempt}/${modelActivity.maxAttempts}`
                + ` · ${focusedElapsed}`
            : `${modelActivity === undefined ? focusedActivity : "thinking"}`
                + ` · ${focusedElapsed}`;
    } else if (rt.pendingImages.some((image) => image.id === undefined)) {
        lifecycleHint = "attaching image…";
    } else if (rt.promptSubmitting) {
        lifecycleHint = rt.pendingSkillInvocations.size > 0
            ? "invoking skill…"
            : "sending prompt with image…";
    } else if (rt.extensionCommandPending) {
        lifecycleHint =
            `${rt.extensionCommandActivity ?? "running extension command"} · ctrl+c quit`;
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

    rt.statusText.fg = statusState.approvalMode === "full_access"
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
            "ctrl+\\ layout",
            ...(rt.sidebar.layout() === "split"
                ? [rt.sidebar.isFocused()
                    ? "ctrl+g vera"
                    : `ctrl+g ${rt.hostedSidebar.mention ?? rt.hostedSidebar.pane.agentId}`]
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
    const hostedModeStatus = tuiPlaceRowModeLine(
        READY_HINT,
        placeIdle,
        hostedControls,
    );
    setTextContent(rt.hostedModeText, hostedModeStatus);
    rt.hostedModeText.visible = hostedModeStatus.length > 0;
    const statusLine = [
        tuiDevInstancePrefix(),
        rt.statusNotice ?? lifecycleHint,
    ].filter((part) => part.length > 0).join(" ");
    rt.statusText.visible = !(rt.approvalView.box.visible
        || rt.questionView.box.visible);
    const quietActivity = rt.statusNotice === undefined
        && !statusState.working
        && uiRequest === undefined
        && lifecycleHint === READY_HINT;
    const activityHint = statusState.working
            && uiRequest === undefined
            && !focusedAbort
        ? workingHint
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
                `${tuiKeyChord("dials.pair.prev")}/${
                    tuiKeyChord("dials.pair.next")
                } change`,
                "⏎ apply",
                "/permissions for more",
            ].join(" · "),
            dialWidth,
            Math.max(3, Math.min(DIAL_HUD_CAP, rt.renderer.height - 22)),
        );
    rt.dialCard.visible = stripLines !== undefined;
    rt.dialCard.backgroundColor = TUI_HUD?.background ?? TUI_PANEL;
    const hudRows = stripLines?.slice(0, -1) ?? [];
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
            effortPending: rt.dialStrip === undefined
                ? false
                : dialEffortPending(rt.dialStrip),
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
    setTextContent(rt.activityHintText, activityHint);
    rt.activityHintText.visible = rt.statusText.visible
        && activityHint.length > 0;
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
                    pairOverridden:
                        statusState.modelSettingsOrigin === "user",
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
    const detailsRows = statusDetailsRows;
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
    const rule = (glyph: string) =>
        fg(TUI_ELEMENT)(`${glyph.repeat(cardWidth)}\n`);
    const insideRow = detailsRows[0] ?? [];
    const outsideRows = detailsRows.slice(1);
    setTextContent(rt.composerStatusText, new StyledText(
        insideRow.map((chunk) => fg(statusToneColor(chunk.tone))(chunk.text)),
    ));
    rt.needsYouChipWidth = needsYouChipColumns(
        insideRow,
        rt.workIndex?.needs_you ?? 0,
    );
    const detailChunks = outsideRows.flatMap((row, index) => [
        ...row.map((chunk) => fg(statusToneColor(chunk.tone))(chunk.text)),
        ...(index === outsideRows.length - 1
            ? []
            : [fg(TUI_MUTED)("\n"), rule("─")]),
    ]);
    setTextContent(rt.backgroundStatusText, new StyledText(detailChunks));
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
    const verifyNudge = isWorkerFreeClient(rt.client) || anyOverlayOpen(rt) ? undefined : verificationNudge(
        statusState.modelSettings?.pooled ?? [], rt.verificationNudgeDismissed === true);
    if (verifyNudge !== undefined) {
        noticeChunks.push(fg(TUI_MUTED)(`${rt.agentNoticeRows > 0 ? "\n" : ""}${noticeIndent}${verifyNudge}`));
        rt.agentNoticeRows += 1;
    }
    setTextContent(rt.agentNoticeText, new StyledText(noticeChunks));
    rt.agentNoticeText.height = Math.max(1, rt.agentNoticeRows);
    rt.agentNoticeText.visible = rt.agentNoticeRows > 0;
    const cardRows = Math.max(1, outsideRows.length * 2 - 1);
    rt.backgroundStatusText.height = cardRows;
    setComposerMargin(rt, 
        cardRows + 1,
    );
    const quietHint = [
        fg(TUI_MUTED)(HUD_HINT.slice(0, -3)),
        fg(TUI_ACCENT)("HUD"),
        fg(TUI_MUTED)(` · ${MODEL_PICKER_HINT}`),
    ];
    if (
        rt.workspaceSidebar === undefined
        && quietHintColumns() <= rt.renderer.width - rt.composerHorizontalInset
    ) {
        quietHint.push(fg(TUI_MUTED)(` · ${SIDEBAR_HINT}`));
    }
    setTextContent(rt.statusText, quietActivity
        ? new StyledText(quietHint)
        : statusState.working
            && rt.statusNotice === undefined
            && uiRequest === undefined
            && !focusedAbort
        ? renderTuiActivityAnimation(
            rt.activityAnimation === "off" ? "off" : "braille",
            activityFrame(rt),
            statusLine,
            {
                active: TUI_ACCENT,
                trail: rt.activityAnimation === "shimmer"
                    ? TUI_ELEMENT
                    : rt.theme.activityTrail,
                inactive: TUI_MUTED,
                text: rt.state.approvalMode === "full_access"
                    ? rt.theme.critical
                    : TUI_ACCENT,
            },
            rt.activityAnimationWidth,
        )
        : statusLine);
}
