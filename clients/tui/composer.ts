import {
    BoxRenderable,
    decodePasteBytes,
    stripAnsiSequences,
    TextareaRenderable,
    type PasteEvent,
    type RenderContext,
} from "@opentui/core";
import { TUI_ACCENT, TUI_PANEL, TUI_TEXT } from "./state.ts";
import { pastedImagePath } from "./image-path.ts";

const PASTE_SUMMARY_LINE_THRESHOLD = 3;
const PASTE_SUMMARY_CHAR_THRESHOLD = 240;

interface CollapsedPaste {
    readonly marker: string;
    readonly text: string;
}

export class TuiComposer extends TextareaRenderable {
    private collapsedPastes: CollapsedPaste[] = [];
    private submittedTexts: string[] = [];
    private submittedTextIndex?: number;
    onImagePathPaste?: (path: string) => void;

    override handleKeyPress(key: Parameters<TextareaRenderable["handleKeyPress"]>[0]): boolean {
        if (
            key.name === "up"
            && !key.shift
            && !key.ctrl
            && !key.meta
            && !key.super
            && !key.hyper
            && (this.plainText.length === 0 || this.submittedTextIndex !== undefined)
            && this.submittedTexts.length > 0
        ) {
            const nextIndex = this.submittedTextIndex === undefined
                ? this.submittedTexts.length - 1
                : (this.submittedTextIndex - 1 + this.submittedTexts.length)
                    % this.submittedTexts.length;
            this.submittedTextIndex = nextIndex;
            this.setText(this.submittedTexts[nextIndex] ?? "");
            this.cursorOffset = this.plainText.length;
            return true;
        }
        if (
            key.name === "enter"
            && !key.shift
            && !key.ctrl
            && !key.meta
            && !key.super
            && !key.hyper
        ) {
            return this.submit();
        }
        return super.handleKeyPress(key);
    }

    override handlePaste(event: PasteEvent): void {
        const text = normalizeLineEndings(
            stripAnsiSequences(decodePasteBytes(event.bytes)),
        );
        const imagePath = pastedImagePath(text);
        if (imagePath !== undefined && this.onImagePathPaste !== undefined) {
            this.onImagePathPaste(imagePath);
            return;
        }
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
        this.setComposerText("");
    }

    rememberSubmittedText(text: string): void {
        if (text.length > 0) {
            this.submittedTexts.push(text);
            this.submittedTextIndex = undefined;
        }
    }

    loadSubmittedTexts(texts: readonly string[]): void {
        this.submittedTexts = texts.filter((text) => text.length > 0);
        this.submittedTextIndex = undefined;
    }

    setComposerText(text: string): void {
        this.collapsedPastes = [];
        this.submittedTextIndex = undefined;
        this.setText(text);
        // OpenTUI resets the editor cursor to offset 0 after setText(). Keep
        // completion and picker-driven text edits natural by placing it at
        // the end of the inserted value.
        this.cursorOffset = text.length;
    }
}

export function createTuiComposer(
    renderer: RenderContext,
    onSubmit: () => void,
    onImagePathPaste?: (path: string) => void,
): TuiComposer {
    const composer = new TuiComposer(renderer, {
        id: "composer",
        width: "100%",
        height: 3,
        placeholder: "Message Vera…",
        backgroundColor: TUI_PANEL,
        focusedBackgroundColor: TUI_PANEL,
        textColor: TUI_TEXT,
        focusedTextColor: TUI_TEXT,
        cursorColor: TUI_ACCENT,
        keyBindings: [
            { name: "return", action: "submit" },
            { name: "enter", action: "submit" },
            { name: "kpenter", action: "submit" },
            { name: "return", shift: true, action: "newline" },
            { name: "enter", shift: true, action: "newline" },
            { name: "kpenter", shift: true, action: "newline" },
        ],
        onSubmit,
    });
    composer.onImagePathPaste = onImagePathPaste;
    return composer;
}

export function createTuiComposerPanel(
    renderer: RenderContext,
    composer: TuiComposer,
): BoxRenderable {
    const panel = new BoxRenderable(renderer, {
        id: "composer-box",
        border: ["left"],
        borderStyle: "heavy",
        borderColor: TUI_ACCENT,
        backgroundColor: TUI_PANEL,
        width: "100%",
        height: 5,
        paddingX: 2,
        paddingY: 1,
        // Reserve the status row and its bottom gutter.
        marginBottom: 2,
        // OpenCode focuses its textarea from mouse-down. Vera extends that
        // mechanic to the padded panel because the whole panel reads as input.
        onMouseDown: () => composer.focus(),
    });
    panel.add(composer);
    return panel;
}

function shouldCollapsePaste(text: string): boolean {
    const lineCount = text.split("\n").length;
    return lineCount >= PASTE_SUMMARY_LINE_THRESHOLD
        || text.length >= PASTE_SUMMARY_CHAR_THRESHOLD;
}

function normalizeLineEndings(text: string): string {
    return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
