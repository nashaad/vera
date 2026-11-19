import { DIALOG_HEADER_HEIGHT } from "./dialog-header.ts";
import { DIALOG_SHORT_TERMINAL_HEIGHT } from "./dialog-chrome.ts";

export interface ApprovalLayoutInput {
    readonly width: number;
    readonly height: number;
    readonly rows: number;
    // Rows the card holds beyond the details and the answers, such as the auto-approval suggestion.
    readonly extraRows?: number;
    readonly title: string;
    // The line under the title, when there is one.
    readonly folderLine?: string;
}

export interface ApprovalLayout {
    readonly folder: boolean;
    readonly hints: boolean;
    // Blank rows between the details and the answers.
    readonly gap: number;
}

// The details keep two rows so the command is not scrolled out behind the reason.
const DETAILS_ROWS = 2;
const HINT_ROWS = 2;
const HINTS_MIN_WIDTH = 60;
const CARD_PADDING = 4;
const TALL_CARD_SHARE = 0.9;

export function approvalHeaderVisible(screen: { readonly height: number }): boolean {
    return screen.height > 6;
}

export function approvalChromeVisible(screen: { readonly height: number }): boolean {
    return screen.height > DIALOG_SHORT_TERMINAL_HEIGHT;
}

export function approvalBottomPadding(screen: { readonly height: number }): number {
    return approvalChromeVisible(screen) ? 1 : 0;
}

/** Keeps every answer on screen: the folder line, then the key hints, then the gap above the answers give way before an answer is clipped. */
export function approvalLayout(input: ApprovalLayoutInput): ApprovalLayout {
    const compact = !approvalChromeVisible(input);
    const limit = Math.round(input.height * (compact ? 1 : TALL_CARD_SHARE));
    const titleWidth = Math.max(
        1,
        input.width - (compact ? 0 : 1) - CARD_PADDING,
    );
    const titleLines = wrappedLineCount(input.title, titleWidth);
    const folderLines = input.folderLine === undefined
        ? 0
        : wrappedLineCount(input.folderLine, titleWidth);
    const wantsFolder = folderLines > 0 && !compact;
    const hintsFit = input.width >= HINTS_MIN_WIDTH;
    const needed = (folder: boolean, hints: boolean, gap: number): number => {
        const lines = titleLines + (folder ? folderLines : 0);
        const header = !approvalHeaderVisible(input)
            ? 0
            : compact ? lines : Math.max(DIALOG_HEADER_HEIGHT, lines + 2);
        return header + DETAILS_ROWS + gap + input.rows
            + (input.extraRows ?? 0)
            + approvalBottomPadding(input)
            + (hints ? HINT_ROWS : 0);
    };
    const steps: readonly ApprovalLayout[] = [
        { folder: wantsFolder, hints: hintsFit, gap: 1 },
        { folder: wantsFolder, hints: false, gap: 1 },
        { folder: false, hints: false, gap: 1 },
        { folder: false, hints: false, gap: 0 },
    ];
    return steps.find((step) => needed(step.folder, step.hints, step.gap) <= limit)
        ?? steps[steps.length - 1]!;
}

function wrappedLineCount(text: string, width: number): number {
    let lines = 1;
    let used = 0;
    for (const word of text.split(" ")) {
        const size = Bun.stringWidth(word);
        if (used === 0) {
            used = size;
        } else if (used + 1 + size <= width) {
            used += 1 + size;
        } else {
            lines += 1;
            used = size;
        }
        if (used > width) {
            lines += Math.ceil(used / width) - 1;
            used = used % width;
        }
    }
    return lines;
}
