import { modelSelectionCleared } from "../../../src/host/model-catalog-settings.ts";
import { setTextContent } from "../text-content.ts";
import { renderTuiHeldAddress } from "../addressing.ts";
import { COPY_NOTICE_DURATION_MS, renderStatus } from "../main.ts";
import { DIALOG_SHORT_TERMINAL_HEIGHT, TOAST_Z_INDEX } from "../dialog-chrome.ts";
import { setComposerMargin } from "../main/chrome.ts";
import { focusedAgentCanAbort } from "../main/agents-dials.ts";
import { anyOverlayOpen } from "../main/render-state.ts";
import { renderTuiQuote, tuiQuoteMarker } from "../quote.ts";
import { clippedToWidth, verificationConsoleLines } from "../settings-picker.ts";
import { TUI_ACCENT, TUI_MUTED, type TuiState } from "../state.ts";
import { resumeTuiTranscriptFollow, tuiTranscriptAtBottom } from "../transcript-scroll.ts";
import { clearTranscriptAnchorPadding, transcriptFollowsBottom } from "./transcript-nodes.ts";
import type { TuiRuntime } from "./runtime.ts";
import { StyledText, bg, fg } from "@opentui/core";

export const MODE_TOAST_DURATION_MS = 5_000;
export const MODE_TOAST_HANDOFF_MS = 400;
export const MODE_TOAST_FILL_ROLE = "element" as const;
export const MODE_TOAST_TYPE_MS = 10;
export const MODE_TOAST_TICK = " ✓";
export const MODE_TOAST_FAIL_TICK = " !";
export const MODE_TOAST_INFO_TICK = " i";

// Matches the tone on `client.ui.notice`; a toast without a tone keeps the
// legacy "Could not refresh" text heuristic below.
export type ModeToastTone = "primary" | "soft" | "error";

export interface ModeToastItem {
    readonly text: string;
    readonly tone?: ModeToastTone;
}

export function typedToastText(message: string, revealed: number): string {
    return Array.from(message).slice(0, Math.max(0, revealed)).join("");
}

export function modeToastTypes(animationLevel: number): boolean {
    return animationLevel > 0;
}

export function modeToastLineComplete(message: string, revealed: number): boolean {
    return revealed >= Array.from(message).length;
}

export function modeToastFailureLine(message: string): boolean {
    return message.includes("Could not refresh");
}

// A soft toast reports something; it did not just finish an action, so it
// earns a neutral mark instead of the success tick.
export function modeToastDoneMark(message: string, tone?: ModeToastTone): string {
    if (tone === "error" || modeToastFailureLine(message)) return MODE_TOAST_FAIL_TICK;
    if (tone === "soft") return MODE_TOAST_INFO_TICK;
    return MODE_TOAST_TICK;
}

export function modeToastDoneTone(
    message: string,
    tone?: ModeToastTone,
): "success" | "danger" | "notice" {
    if (tone === "error" || modeToastFailureLine(message)) return "danger";
    if (tone === "soft") return "notice";
    return "success";
}

export interface ModeToastLane {
    readonly shown: ModeToastItem | undefined;
    readonly waiting: readonly ModeToastItem[];
}

export function enqueueModeToast(
    lane: ModeToastLane,
    message: string,
    tone?: ModeToastTone,
): ModeToastLane {
    const item: ModeToastItem = tone === undefined ? { text: message } : { text: message, tone };
    if (lane.shown === undefined) {
        return { shown: item, waiting: lane.waiting };
    }
    return { shown: lane.shown, waiting: [...lane.waiting, item] };
}

export function dismissModeToast(lane: ModeToastLane): ModeToastLane {
    const [shown, ...waiting] = lane.waiting;
    return { shown, waiting };
}

export function clipToastMessage(message: string, width: number): string {
    return clippedToWidth(message, width);
}

export function layoutModeToast(
    message: string,
    terminalWidth: number,
    terminalHeight: number,
): {
    readonly text: string;
    readonly top: number;
    readonly width: number;
    readonly height: number;
    readonly paddingTop: number;
    readonly paddingBottom: number;
    readonly paddingLeft: number;
    readonly paddingRight: number;
} {
    const compact = terminalHeight <= DIALOG_SHORT_TERMINAL_HEIGHT;
    const paddingX = compact ? 1 : 2;
    const paddingY = compact ? 0 : 1;
    const width = Math.max(1, terminalWidth);
    const tickWidth = Math.max(
        Bun.stringWidth(MODE_TOAST_TICK),
        Bun.stringWidth(MODE_TOAST_FAIL_TICK),
        Bun.stringWidth(MODE_TOAST_INFO_TICK),
    );
    const maxText = Math.max(1, width - paddingX * 2 - tickWidth);
    const text = clipToastMessage(message, maxText);
    return {
        text,
        top: 0,
        width,
        height: compact ? 1 : 3,
        paddingTop: paddingY,
        paddingBottom: paddingY,
        paddingLeft: paddingX,
        paddingRight: paddingX,
    };
}

export function showStatusNotice(rt: TuiRuntime, message: string): void {
    rt.statusNotice = message;
    rt.statusNoticeVersion += 1;
    const version = rt.statusNoticeVersion;
    renderStatus(rt);

    setTimeout(() => {
        if (rt.statusNoticeVersion !== version) {
            return;
        }
        rt.statusNotice = undefined;
        renderStatus(rt);
    }, COPY_NOTICE_DURATION_MS);
}

export function armQuit(rt: TuiRuntime): void {
    rt.quitArmed = true;
    renderStatus(rt);
}

export function disarmQuit(rt: TuiRuntime): void {
    rt.quitArmed = false;
}

// Ctrl+C clears an idle draft before it can quit; the key handler and the footer hint share this test.
export function interruptClearsDraft(rt: TuiRuntime): boolean {
    return !focusedAgentCanAbort(rt)
        && rt.composer.focused
        && rt.composer.plainText.length > 0
        && !anyOverlayOpen(rt);
}

// The quit stays armed with no time limit, but only counts when the next Ctrl+C would quit.
export function quitArmedNow(rt: TuiRuntime): boolean {
    return rt.quitArmed === true
        && !rt.sessionTrashPending
        && !focusedAgentCanAbort(rt)
        && !interruptClearsDraft(rt);
}

export function modeToastTakesEscape(
    visible: boolean,
    overlayOpen: boolean,
): boolean {
    return visible && !overlayOpen;
}

function readModeToastLane(rt: TuiRuntime): ModeToastLane {
    return {
        shown: rt.modeToast.visible ? rt.modeToastCurrent : undefined,
        waiting: rt.modeToastQueue,
    };
}

function clearModeToastTyping(rt: TuiRuntime): void {
    if (rt.modeToastTypeTimer === undefined) return;
    clearInterval(rt.modeToastTypeTimer);
    rt.modeToastTypeTimer = undefined;
}

function clearModeToastExpiry(rt: TuiRuntime): void {
    if (rt.modeToastExpireTimer === undefined) return;
    clearTimeout(rt.modeToastExpireTimer);
    rt.modeToastExpireTimer = undefined;
}

export function stopModeToastTimers(rt: TuiRuntime): void {
    clearModeToastTyping(rt);
    clearModeToastExpiry(rt);
}

function armModeToastExpiry(rt: TuiRuntime, version: number): void {
    clearModeToastExpiry(rt);
    const hold = rt.modeToastQueue.length > 0
        ? MODE_TOAST_HANDOFF_MS
        : MODE_TOAST_DURATION_MS;
    rt.modeToastExpireTimer = setTimeout(() => {
        if (rt.modeToastVersion !== version) return;
        hideModeToast(rt);
    }, hold);
}

function applyModeToastGeometry(
    rt: TuiRuntime,
    layout: ReturnType<typeof layoutModeToast>,
): void {
    rt.modeToast.top = layout.top;
    rt.modeToast.left = 0;
    rt.modeToast.width = layout.width;
    rt.modeToast.height = layout.height;
    rt.modeToast.paddingTop = layout.paddingTop;
    rt.modeToast.paddingBottom = layout.paddingBottom;
    rt.modeToast.paddingLeft = layout.paddingLeft;
    rt.modeToast.paddingRight = layout.paddingRight;
}

function paintModeToastText(rt: TuiRuntime, message: string, tone?: ModeToastTone): void {
    const typed = typedToastText(message, rt.modeToastRevealed);
    if (!modeToastLineComplete(message, rt.modeToastRevealed)) {
        setTextContent(rt.modeToastText, typed);
        return;
    }
    const fill = rt.theme.element;
    const doneTone = modeToastDoneTone(message, tone);
    const mark = modeToastDoneMark(message, tone);
    setTextContent(rt.modeToastText, new StyledText([
        fg(rt.theme.text)(bg(fill)(typed)),
        fg(rt.theme[doneTone])(bg(fill)(mark)),
    ]));
}

function presentModeToast(rt: TuiRuntime, item: ModeToastItem): void {
    rt.modeToastVersion += 1;
    const version = rt.modeToastVersion;
    clearModeToastTyping(rt);
    clearModeToastExpiry(rt);
    rt.modeToastCurrent = item;
    const layout = layoutModeToast(item.text, rt.renderer.width, rt.renderer.height);
    applyModeToastGeometry(rt, layout);
    rt.modeToast.zIndex = TOAST_Z_INDEX;
    rt.modeToast.visible = true;
    const units = Array.from(layout.text);
    if (!modeToastTypes(rt.animationLevel) || units.length === 0) {
        rt.modeToastRevealed = units.length;
        paintModeToastText(rt, layout.text, item.tone);
        armModeToastExpiry(rt, version);
    } else {
        rt.modeToastRevealed = 1;
        paintModeToastText(rt, layout.text, item.tone);
        rt.modeToastTypeTimer = setInterval(() => {
            if (rt.modeToastVersion !== version || rt.modeToastCurrent === undefined) {
                return;
            }
            const next = layoutModeToast(
                rt.modeToastCurrent.text,
                rt.renderer.width,
                rt.renderer.height,
            );
            rt.modeToastRevealed += 1;
            paintModeToastText(rt, next.text, rt.modeToastCurrent.tone);
            if (rt.modeToastRevealed >= Array.from(next.text).length) {
                clearModeToastTyping(rt);
                armModeToastExpiry(rt, version);
            }
        }, MODE_TOAST_TYPE_MS);
    }
}

function applyModeToastLane(rt: TuiRuntime, lane: ModeToastLane): void {
    rt.modeToastQueue = [...lane.waiting];
    if (lane.shown === undefined) {
        rt.modeToastVersion += 1;
        clearModeToastTyping(rt);
        clearModeToastExpiry(rt);
        rt.modeToastCurrent = undefined;
        rt.modeToastRevealed = 0;
        rt.modeToast.visible = false;
        return;
    }
    if (rt.modeToast.visible && rt.modeToastCurrent === lane.shown) {
        if (lane.waiting.length > 0 && rt.modeToastTypeTimer === undefined) {
            armModeToastExpiry(rt, rt.modeToastVersion);
        }
        return;
    }
    presentModeToast(rt, lane.shown);
}

export function hideModeToast(rt: TuiRuntime): void {
    applyModeToastLane(rt, dismissModeToast(readModeToastLane(rt)));
}

export function showModeToast(rt: TuiRuntime, message: string, tone?: ModeToastTone): void {
    applyModeToastLane(rt, enqueueModeToast(readModeToastLane(rt), message, tone));
}

export function layoutModeToastBand(rt: TuiRuntime): void {
    if (!rt.modeToast.visible || rt.modeToastCurrent === undefined) return;
    const layout = layoutModeToast(
        rt.modeToastCurrent.text,
        rt.renderer.width,
        rt.renderer.height,
    );
    applyModeToastGeometry(rt, layout);
    const units = Array.from(layout.text).length;
    if (rt.modeToastTypeTimer === undefined) {
        rt.modeToastRevealed = units;
    } else {
        rt.modeToastRevealed = Math.min(rt.modeToastRevealed, units);
    }
    paintModeToastText(rt, layout.text, rt.modeToastCurrent.tone);
}

export function showVerificationConsole(rt: TuiRuntime, 
    requestId: string,
    subject: string,
): void {
    rt.verificationConsole = { requestId, subject };
}

export function verificationConsoleRows(rt: TuiRuntime): number {
    if (rt.settingsPicker?.kind !== "model") return 0;
    const shown = liveVerificationConsole(rt);
    return shown === undefined ? 0 : verificationConsoleLines(shown);
}

export function hideVerificationConsole(rt: TuiRuntime, requestId: string): void {
    if (rt.verificationConsole?.requestId !== requestId) return;
    rt.verificationConsole = undefined;
}

export function dropSettledVerificationConsole(rt: TuiRuntime): void {
    if (rt.verificationConsole === undefined) return;
    const admission = rt.state.admission;
    if (
        admission?.requestId === rt.verificationConsole.requestId
        && admission.settled === true
    ) {
        rt.verificationConsole = undefined;
    }
}

export function liveVerificationConsole(rt: TuiRuntime) {
    const shown = rt.verificationConsole;
    if (shown === undefined) return undefined;
    const admission = rt.state.admission?.requestId === shown.requestId
        ? rt.state.admission
        : undefined;
    if (admission?.settled === true) return undefined;
    return {
        subject: shown.subject,
        steps: (admission?.steps ?? []).map((step) => ({
            label: step.label,
            status: step.status,
        })),
    };
}

export function updateTranscriptScrollFollow(
    rt: TuiRuntime,
    previousTop: number,
    direction: "up" | "down",
): void {
    const transcript = rt.transcript;
    if (direction === "up" && transcript.scrollTop < previousTop) {
        transcript.stickyScroll = false;
        if (rt.pendingTranscriptScrollRestore?.atBottom) {
            rt.pendingTranscriptScrollRestore = undefined;
        }
    } else if (direction === "down" && tuiTranscriptAtBottom(
        transcript.scrollTop, transcript.scrollHeight, transcript.viewport.height,
    )) {
        clearTranscriptAnchorPadding(rt);
        resumeTuiTranscriptFollow(transcript);
    }
    renderJumpToBottom(rt, false);
}

export function trackTranscriptScroll(rt: TuiRuntime, direction?: "up" | "down"): void {
    const previousTop = rt.transcript.scrollTop;
    queueMicrotask(() => {
        if (rt.shuttingDown) return;
        const actualDirection = direction ?? (rt.transcript.scrollTop > previousTop
            ? "down"
            : rt.transcript.scrollTop < previousTop ? "up" : undefined);
        if (actualDirection !== undefined) updateTranscriptScrollFollow(rt, previousTop, actualDirection);
    });
}

export function renderJumpToBottom(rt: TuiRuntime, resumeFollow = true): void {
    const following = transcriptFollowsBottom(rt);
    // OpenTUI's wheel handler marks every wheel event as manual after it updates scrollTop, including the event that reaches the bottom.
    if (following && resumeFollow) {
        clearTranscriptAnchorPadding(rt);
        resumeTuiTranscriptFollow(rt.transcript);
    }
    const visible = !following && !anyOverlayOpen(rt);
    rt.jumpToBottom.visible = visible;
    if (!visible) {
        return;
    }
    rt.jumpToBottom.top = rt.commandSuggestionsBox.visible
        ? Math.min(
            rt.transcript.y + rt.transcript.height - 1,
            rt.commandSuggestionsBox.y - 1,
        )
        : rt.transcript.y + rt.transcript.height - 1;
    rt.jumpToBottom.left = Math.max(
        0,
        rt.transcript.x + rt.transcript.width - rt.JUMP_TO_BOTTOM_LABEL.length - 2,
    );
}

export function renderSidebarJump(rt: TuiRuntime): void {
    const visible = rt.sidebar.isShown() && !rt.sidebar.isFollowing()
        && !anyOverlayOpen(rt);
    rt.sidebarJump.visible = visible;
    if (!visible) {
        return;
    }
    const region = rt.sidebar.bounds();
    rt.sidebarJump.top = region.y + region.height - 1;
    rt.sidebarJump.left = Math.max(
        0,
        region.x + region.width - rt.SIDEBAR_JUMP_LABEL.length - 1,
    );
}

export function renderPendingQuote(rt: TuiRuntime): void {
    const quote = rt.pendingQuote;
    rt.quoteText.visible = quote !== undefined && !anyOverlayOpen(rt);
    setComposerMargin(rt, rt.quoteText.visible ? 3 : 2);
    if (quote === undefined) {
        setTextContent(rt.quoteText, "");
        return;
    }
    const { facts, keys } = renderTuiQuote(quote);
    setTextContent(rt.quoteText, new StyledText([
        fg(TUI_ACCENT)(`${tuiQuoteMarker(Date.now())} `),
        fg(TUI_MUTED)(`${facts} · `),
        fg(TUI_ACCENT)(keys),
    ]));
}

export function renderHeldAddress(rt: TuiRuntime): void {
    const { facts, keys } = renderTuiHeldAddress(rt.extensionAddressee);
    rt.heldAddressText.visible = facts.length > 0 && !anyOverlayOpen(rt);
    if (facts.length === 0) {
        setTextContent(rt.heldAddressText, "");
        return;
    }
    setTextContent(rt.heldAddressText, new StyledText([
        fg(TUI_MUTED)(
            `${" ".repeat(rt.appearance.composerMarginHorizontal)}${facts} · `,
        ),
        fg(TUI_ACCENT)(keys),
    ]));
}

export function paneHeaderText(rt: TuiRuntime, 
    name: string,
    approvalMode: string | undefined,
    settings: TuiState["modelSettings"],
    width: number,
    showModel: boolean,
): string {
    const left = `${name} · ${approvalMode ?? "loading"}`;
    const contentWidth = Math.max(1, width - rt.composerHorizontalInset);
    const indent = " ".repeat(rt.composerContentIndent);
    if (!showModel) return `${indent}${left.slice(0, contentWidth)}`;
    const model = settings?.model;
    const selected = modelSelectionCleared(settings) ? "no model selected" : model === undefined
        ? "model loading"
        : settings?.provider === undefined
        ? model
        : `${settings.provider}/${model}`;
    const right = `${selected} · ${modelSelectionCleared(settings) ? "default" : settings?.reasoningEffort ?? "default"}`;
    if (left.length + right.length + 3 <= contentWidth) {
        return `${indent}${left}${" ".repeat(contentWidth - left.length - right.length)}${right}`;
    }
    const rightRoom = Math.max(0, contentWidth - left.length - 3);
    return rightRoom < 4
        ? `${indent}${left.slice(0, contentWidth)}`
        : `${indent}${left} · ${right.slice(0, rightRoom)}`;
}
