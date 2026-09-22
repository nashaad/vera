import { modelSelectionCleared } from "../../../src/host/model-catalog-settings.ts";
import { setTextContent } from "../text-content.ts";
import { renderTuiHeldAddress } from "../addressing.ts";
import { COPY_NOTICE_DURATION_MS, MODE_TOAST_DURATION_MS, renderStatus } from "../main.ts";
import { DIALOG_SHORT_TERMINAL_HEIGHT, TOAST_Z_INDEX } from "../dialog-chrome.ts";
import { setComposerMargin } from "../main/chrome.ts";
import { anyOverlayOpen } from "../main/render-state.ts";
import { renderTuiQuote, tuiQuoteMarker } from "../quote.ts";
import { clippedToWidth, verificationConsoleLines } from "../settings-picker.ts";
import { TUI_ACCENT, TUI_MUTED, type TuiState } from "../state.ts";
import { tuiTranscriptAtBottom } from "../transcript-scroll.ts";
import type { TuiRuntime } from "./runtime.ts";
import { StyledText, fg } from "@opentui/core";

export const TOAST_RIGHT_GUTTER = 2;

export function clipToastMessage(message: string, width: number): string {
    if (Bun.stringWidth(message) <= width) return message;
    const failure = message.match(/Could not refresh.*$/);
    if (failure !== null) return clippedToWidth(failure[0], width);
    return clippedToWidth(message, width);
}

export function layoutModeToast(
    message: string,
    terminalWidth: number,
    terminalHeight: number,
): {
    readonly text: string;
    readonly width: number;
    readonly height: number;
    readonly paddingTop: number;
    readonly paddingBottom: number;
    readonly paddingLeft: number;
    readonly paddingRight: number;
} {
    const compact = terminalHeight <= DIALOG_SHORT_TERMINAL_HEIGHT;
    const paddingX = compact ? 0 : 2;
    const paddingY = compact ? 0 : 1;
    const maxWidth = Math.max(1, terminalWidth - TOAST_RIGHT_GUTTER);
    const maxText = Math.max(1, maxWidth - paddingX * 2);
    const text = clipToastMessage(message, maxText);
    return {
        text,
        width: Math.min(maxWidth, Math.max(1, Bun.stringWidth(text) + paddingX * 2)),
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

export function showModeToast(rt: TuiRuntime, message: string): void {
    rt.modeToastVersion += 1;
    const version = rt.modeToastVersion;
    const layout = layoutModeToast(message, rt.renderer.width, rt.renderer.height);
    setTextContent(rt.modeToastText, layout.text);
    rt.modeToast.width = layout.width;
    rt.modeToast.height = layout.height;
    rt.modeToast.paddingTop = layout.paddingTop;
    rt.modeToast.paddingBottom = layout.paddingBottom;
    rt.modeToast.paddingLeft = layout.paddingLeft;
    rt.modeToast.paddingRight = layout.paddingRight;
    rt.modeToast.zIndex = TOAST_Z_INDEX;
    rt.modeToast.visible = true;
    setTimeout(() => {
        if (rt.modeToastVersion !== version) return;
        rt.modeToast.visible = false;
    }, MODE_TOAST_DURATION_MS);
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

export function renderJumpToBottom(rt: TuiRuntime, resumeFollow = true): void {
    const following = tuiTranscriptAtBottom(
        rt.transcript.scrollTop,
        rt.transcript.scrollHeight,
        rt.transcript.viewport.height,
    );
    // OpenTUI's wheel handler marks every wheel event as manual after it updates scrollTop, including the event that reaches the bottom.
    if (following && resumeFollow) {
        rt.transcript.scrollTo(rt.transcript.scrollHeight);
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
