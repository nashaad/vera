import type { VeraTuiConfig } from "../../src/config.ts";

export interface TuiAppearance {
    readonly transcriptPaddingLeft: number;
    readonly transcriptPaddingRight: number;
    readonly activityIndent: number;
    readonly messageSpacing: number;
    readonly toolGroupSpacing: number;
    readonly separatorVisible: boolean;
    readonly separatorSpacingBefore: number;
    readonly separatorSpacingAfter: number;
    readonly transcriptSeparatorColor?: string;
    readonly composerMarginHorizontal: number;
    readonly composerPaddingHorizontal: number;
    readonly composerTipIndent: number;
    readonly composerBoundaryColor?: string;
}

export const DEFAULT_TUI_APPEARANCE: TuiAppearance = {
    transcriptPaddingLeft: 0,
    transcriptPaddingRight: 1,
    activityIndent: 2,
    messageSpacing: 1,
    toolGroupSpacing: 0,
    separatorVisible: true,
    separatorSpacingBefore: 1,
    separatorSpacingAfter: 1,
    composerMarginHorizontal: 2,
    composerPaddingHorizontal: 1,
    composerTipIndent: 3,
};

const TUI_COMPOSER_MIN_CONTENT_COLUMNS = 12;
const TUI_TRANSCRIPT_MIN_CONTENT_COLUMNS = 12;

export function resolveTuiAppearance(
    config?: VeraTuiConfig,
): TuiAppearance {
    const margin = config?.composer?.margin_horizontal
        ?? DEFAULT_TUI_APPEARANCE.composerMarginHorizontal;
    return {
        transcriptPaddingLeft: config?.transcript?.padding_left
            ?? DEFAULT_TUI_APPEARANCE.transcriptPaddingLeft,
        transcriptPaddingRight: config?.transcript?.padding_right
            ?? DEFAULT_TUI_APPEARANCE.transcriptPaddingRight,
        activityIndent: config?.transcript?.activity_indent
            ?? DEFAULT_TUI_APPEARANCE.activityIndent,
        messageSpacing: config?.transcript?.message_spacing
            ?? DEFAULT_TUI_APPEARANCE.messageSpacing,
        toolGroupSpacing: config?.transcript?.tool_group_spacing
            ?? DEFAULT_TUI_APPEARANCE.toolGroupSpacing,
        separatorVisible: config?.transcript?.separator_visible
            ?? DEFAULT_TUI_APPEARANCE.separatorVisible,
        separatorSpacingBefore: config?.transcript?.separator_spacing_before
            ?? DEFAULT_TUI_APPEARANCE.separatorSpacingBefore,
        separatorSpacingAfter: config?.transcript?.separator_spacing_after
            ?? DEFAULT_TUI_APPEARANCE.separatorSpacingAfter,
        ...(config?.transcript?.separator_color === undefined
            ? {}
            : {
                transcriptSeparatorColor:
                    config.transcript.separator_color,
            }),
        composerMarginHorizontal: margin,
        composerPaddingHorizontal: config?.composer?.padding_horizontal
            ?? DEFAULT_TUI_APPEARANCE.composerPaddingHorizontal,
        composerTipIndent: config?.composer?.tip_indent ?? margin + 1,
        ...(config?.composer?.boundary_color === undefined
            ? {}
            : { composerBoundaryColor: config.composer.boundary_color }),
    };
}

export function fitTuiAppearance(
    appearance: TuiAppearance,
    terminalWidth: number,
): TuiAppearance {
    const transcriptBudget = Math.max(
        0,
        terminalWidth - TUI_TRANSCRIPT_MIN_CONTENT_COLUMNS,
    );
    const requestedTranscriptPadding = appearance.transcriptPaddingLeft
        + appearance.transcriptPaddingRight;
    const transcriptPaddingLeft = requestedTranscriptPadding
            <= transcriptBudget
        ? appearance.transcriptPaddingLeft
        : Math.floor(
            transcriptBudget
                * appearance.transcriptPaddingLeft
                / requestedTranscriptPadding,
        );
    const transcriptPaddingRight = requestedTranscriptPadding
            <= transcriptBudget
        ? appearance.transcriptPaddingRight
        : transcriptBudget - transcriptPaddingLeft;
    const insetBudget = Math.max(
        0,
        Math.floor(
            (terminalWidth - 2 - TUI_COMPOSER_MIN_CONTENT_COLUMNS) / 2,
        ),
    );
    const margin = Math.min(
        appearance.composerMarginHorizontal,
        insetBudget,
    );
    const padding = Math.min(
        appearance.composerPaddingHorizontal,
        insetBudget - margin,
    );
    const tipTracksMargin = appearance.composerTipIndent
        === appearance.composerMarginHorizontal + 1;
    return {
        ...appearance,
        transcriptPaddingLeft,
        transcriptPaddingRight,
        composerMarginHorizontal: margin,
        composerPaddingHorizontal: padding,
        composerTipIndent: tipTracksMargin
            ? margin + 1
            : Math.min(
                appearance.composerTipIndent,
                Math.max(0, terminalWidth - 4),
            ),
    };
}

export function tuiComposerContentIndent(appearance: TuiAppearance): number {
    return appearance.composerMarginHorizontal
        + 1
        + appearance.composerPaddingHorizontal;
}

export function tuiComposerOverlayInset(appearance: TuiAppearance): {
    readonly left: 0;
    readonly right: 0;
    readonly paddingLeft: number;
    readonly paddingRight: number;
} {
    const indent = tuiComposerContentIndent(appearance);
    return {
        left: 0,
        right: 0,
        paddingLeft: indent,
        paddingRight: indent,
    };
}
