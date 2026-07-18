import {
    decodePasteBytes,
    stripAnsiSequences,
    TextareaRenderable,
    type PasteEvent,
    type RenderContext,
} from "@opentui/core";

const PASTE_SUMMARY_LINE_THRESHOLD = 3;
const PASTE_SUMMARY_CHAR_THRESHOLD = 240;

interface CollapsedPaste {
    readonly marker: string;
    readonly text: string;
}

export class TuiComposer extends TextareaRenderable {
    private collapsedPastes: CollapsedPaste[] = [];

    override handlePaste(event: PasteEvent): void {
        const text = normalizeLineEndings(
            stripAnsiSequences(decodePasteBytes(event.bytes)),
        );
        if (!shouldCollapsePaste(text)) {
            this.insertText(text);
            return;
        }

        const marker = `[Pasted Content ${text.length} chars]`;
        this.collapsedPastes.push({ marker, text });
        this.insertText(marker);
    }

    expandedText(): string {
        let expanded = this.plainText;
        let searchFrom = 0;
        for (const paste of this.collapsedPastes) {
            const markerIndex = expanded.indexOf(paste.marker, searchFrom);
            if (markerIndex === -1) {
                continue;
            }
            expanded = expanded.slice(0, markerIndex)
                + paste.text
                + expanded.slice(markerIndex + paste.marker.length);
            searchFrom = markerIndex + paste.text.length;
        }
        return expanded;
    }

    clearComposer(): void {
        this.collapsedPastes = [];
        this.setText("");
    }
}

export function createTuiComposer(
    renderer: RenderContext,
    onSubmit: () => void,
): TuiComposer {
    return new TuiComposer(renderer, {
        id: "composer",
        width: "100%",
        height: 3,
        placeholder: "Message Vera…",
        backgroundColor: "#16161E",
        focusedBackgroundColor: "#16161E",
        textColor: "#F0F0F0",
        focusedTextColor: "#FFFFFF",
        cursorColor: "#7AA2F7",
        keyBindings: [
            { name: "return", action: "submit" },
            { name: "kpenter", action: "submit" },
            { name: "return", shift: true, action: "newline" },
            { name: "kpenter", shift: true, action: "newline" },
        ],
        onSubmit,
    });
}

function shouldCollapsePaste(text: string): boolean {
    const lineCount = text.split("\n").length;
    return lineCount >= PASTE_SUMMARY_LINE_THRESHOLD
        || text.length >= PASTE_SUMMARY_CHAR_THRESHOLD;
}

function normalizeLineEndings(text: string): string {
    return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
