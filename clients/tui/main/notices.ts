import { setTextContent } from "../text-content.ts";
import { renderTuiHeldAddress } from "../addressing.ts";
import { COPY_NOTICE_DURATION_MS, MODE_TOAST_DURATION_MS, renderStatus } from "../main.ts";
import { setComposerMargin } from "../main/chrome.ts";
import { anyOverlayOpen } from "../main/render-state.ts";
import { renderTuiQuote, tuiQuoteMarker } from "../quote.ts";
import { verificationConsoleLines } from "../settings-picker.ts";
import { TUI_ACCENT, TUI_MUTED, type TuiState } from "../state.ts";
import { tuiTranscriptAtBottom } from "../transcript-scroll.ts";
import type { TuiRuntime } from "./runtime.ts";
import { StyledText, fg } from "@opentui/core";

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
    setTextContent(rt.modeToastText, message);
    rt.modeToast.width = message.length + 4;
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
): string {
    const left = `${name} · ${approvalMode ?? "loading"}`;
    const model = settings?.model;
    const right = model === undefined
        ? "model loading"
        : settings?.provider === undefined
        ? model
        : `${settings.provider}/${model}`;
    const contentWidth = Math.max(1, width - rt.composerHorizontalInset);
    const indent = " ".repeat(rt.composerContentIndent);
    if (left.length + right.length + 3 <= contentWidth) {
        return `${indent}${left}${" ".repeat(contentWidth - left.length - right.length)}${right}`;
    }
    const rightRoom = Math.max(0, contentWidth - left.length - 3);
    return rightRoom < 4
        ? `${indent}${left.slice(0, contentWidth)}`
        : `${indent}${left} · ${right.slice(0, rightRoom)}`;
}
