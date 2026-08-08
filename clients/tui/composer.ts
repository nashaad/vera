import {
    BoxRenderable,
    decodePasteBytes,
    stripAnsiSequences,
    SyntaxStyle,
    TextareaRenderable,
    type PasteEvent,
    type RenderContext,
} from "@opentui/core";
import { TUI_ACCENT, TUI_PANEL, TUI_TEXT } from "./state.ts";
import { pastedImagePaths } from "./image-path.ts";
import {
    displayOffsetWidth,
    imageChipMarker,
    renumberImageChips,
    stripImageChips,
    type ImageChip,
} from "./image-chips.ts";

const IMAGE_CHIP_STYLE = "image-chip";
const IMAGE_CHIP_TYPE = "image-chip";

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
    private imageChips: ImageChip[] = [];
    private imageChipExtmarks = new Map<string, number>();
    private imageChipStyleId?: number;
    private imageChipTypeId?: number;
    onImagePathPaste?: (path: string) => void;
    /** A chip the user deleted, so its attachment can be dropped too. */
    onImageChipRemoved?: (requestId: string) => void;

    /**
     * Show an attached image as an atomic `[Image N]` chip at the cursor.
     *
     * The chip is a virtual extmark, so the cursor steps over it and one
     * backspace takes the whole marker rather than a character of it.
     */
    attachImageChip(requestId: string): void {
        this.ensureImageChipStyle();
        const marker = imageChipMarker(this.imageChips.length + 1);
        const start = this.cursorOffset;
        this.insertText(`${marker} `);
        const id = this.extmarks.create({
            start,
            end: start + displayOffsetWidth(marker),
            virtual: true,
            styleId: this.imageChipStyleId,
            typeId: this.imageChipTypeId,
        });
        this.imageChips.push({ requestId, marker });
        this.imageChipExtmarks.set(requestId, id);
        this.syncImageChips();
    }

    /** The attach requests still shown in the composer, in document order. */
    imageChipRequestIds(): readonly string[] {
        return this.imageChips.map((chip) => chip.requestId);
    }

    /** Drop a chip the engine refused, without reporting it as user removal. */
    removeImageChip(requestId: string): void {
        const id = this.imageChipExtmarks.get(requestId);
        if (id === undefined) return;
        this.extmarks.delete(id);
        this.imageChipExtmarks.delete(requestId);
        const chip = this.imageChips.find((each) => each.requestId === requestId);
        this.imageChips = this.imageChips.filter(
            (each) => each.requestId !== requestId,
        );
        if (chip !== undefined) {
            this.setText(stripOneMarker(this.plainText, chip.marker));
        }
        this.renumberImageChipText();
    }

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
                : Math.max(0, this.submittedTextIndex - 1);
            this.submittedTextIndex = nextIndex;
            this.setText(this.submittedTexts[nextIndex] ?? "");
            this.cursorOffset = this.plainText.length;
            return true;
        }
        if (
            key.name === "down"
            && !key.shift
            && !key.ctrl
            && !key.meta
            && !key.super
            && !key.hyper
            && this.submittedTextIndex !== undefined
            && this.submittedTexts.length > 0
        ) {
            const nextIndex = this.submittedTextIndex + 1;
            if (nextIndex === this.submittedTexts.length) {
                this.submittedTextIndex = undefined;
                this.setText("");
                this.cursorOffset = 0;
                return true;
            }
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
        const handled = super.handleKeyPress(key);
        this.syncImageChips();
        return handled;
    }

    /**
     * Reconcile the chips with the extmarks that survived the last edit.
     *
     * Deleting inside a virtual extmark removes the whole extmark, so an
     * extmark that is gone is a chip the user deleted.
     */
    private syncImageChips(): void {
        if (this.imageChips.length === 0) return;
        const live = new Set(
            this.extmarks.getAll().map((extmark) => extmark.id),
        );
        const removed = this.imageChips.filter((chip) => {
            const id = this.imageChipExtmarks.get(chip.requestId);
            return id === undefined || !live.has(id);
        });
        if (removed.length === 0) return;
        for (const chip of removed) {
            this.imageChipExtmarks.delete(chip.requestId);
            this.imageChips = this.imageChips.filter(
                (each) => each.requestId !== chip.requestId,
            );
        }
        this.renumberImageChipText();
        for (const chip of removed) {
            this.onImageChipRemoved?.(chip.requestId);
        }
    }

    /** Rewrite the surviving chips so they read 1, 2, 3 again. */
    private renumberImageChipText(): void {
        if (this.imageChips.length === 0) {
            this.extmarks.clear();
            this.imageChipExtmarks.clear();
            return;
        }
        const cursor = this.cursorOffset;
        const renumbered = renumberImageChips(this.plainText, this.imageChips);
        this.extmarks.clear();
        this.imageChipExtmarks.clear();
        this.imageChips = renumbered.chips.map((chip) => ({
            requestId: chip.requestId,
            marker: chip.marker,
        }));
        this.setText(renumbered.text);
        for (const chip of renumbered.chips) {
            const id = this.extmarks.create({
                start: chip.start,
                end: chip.end,
                virtual: true,
                styleId: this.imageChipStyleId,
                typeId: this.imageChipTypeId,
            });
            this.imageChipExtmarks.set(chip.requestId, id);
        }
        this.cursorOffset = Math.min(
            cursor,
            displayOffsetWidth(renumbered.text),
        );
    }

    private ensureImageChipStyle(): void {
        if (this.imageChipStyleId !== undefined) return;
        const style = SyntaxStyle.fromStyles({
            [IMAGE_CHIP_STYLE]: { fg: TUI_PANEL, bg: TUI_ACCENT },
        });
        this.syntaxStyle = style;
        this.imageChipStyleId = style.getStyleId(IMAGE_CHIP_STYLE) ?? undefined;
        this.imageChipTypeId = this.extmarks.registerType(IMAGE_CHIP_TYPE);
    }

    override handlePaste(event: PasteEvent): void {
        const text = normalizeLineEndings(
            stripAnsiSequences(decodePasteBytes(event.bytes)),
        );
        const imagePaths = pastedImagePaths(text);
        if (imagePaths.length > 0 && this.onImagePathPaste !== undefined) {
            for (const path of imagePaths) {
                this.onImagePathPaste(path);
            }
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

    /**
     * The prompt to submit.
     *
     * Image chips are removed: the attachments travel as IDs alongside the
     * prompt, so leaving `[Image 1]` in the text would only label them twice.
     */
    expandedText(): string {
        let expanded = stripImageChips(this.plainText, this.imageChips);
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
        this.imageChips = [];
        this.imageChipExtmarks.clear();
        this.extmarks.clear();
        this.setText(text);
        // OpenTUI resets the editor cursor to offset 0 after setText(). Keep
        // completion and picker-driven text edits natural by placing it at
        // the end of the inserted value.
        this.cursorOffset = text.length;
    }
}

/** What the composer says when the agent is the recipient. */
export const COMPOSER_PLACEHOLDER = "Message Vera\u2026";

export function createTuiComposer(
    renderer: RenderContext,
    onSubmit: () => void,
    onImagePathPaste?: (path: string) => void,
): TuiComposer {
    const composer = new TuiComposer(renderer, {
        id: "composer",
        width: "100%",
        height: 3,
        placeholder: COMPOSER_PLACEHOLDER,
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

function stripOneMarker(text: string, marker: string): string {
    const markerIndex = text.indexOf(marker);
    if (markerIndex === -1) return text;
    const after = markerIndex + marker.length;
    return text.slice(0, markerIndex)
        + text.slice(text[after] === " " ? after + 1 : after);
}

function shouldCollapsePaste(text: string): boolean {
    const lineCount = text.split("\n").length;
    return lineCount >= PASTE_SUMMARY_LINE_THRESHOLD
        || text.length >= PASTE_SUMMARY_CHAR_THRESHOLD;
}

function normalizeLineEndings(text: string): string {
    return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
