import {
    BoxRenderable,
    decodePasteBytes,
    stripAnsiSequences,
    SyntaxStyle,
    TextareaRenderable,
    TextRenderable,
    type PasteEvent,
    type RenderContext,
} from "@opentui/core";
import {
    TUI_ACCENT,
    TUI_ELEMENT,
    TUI_INPUT,
    TUI_MUTED,
    TUI_PANEL,
    TUI_TEXT,
} from "./state.ts";
import { pastedImagePaths } from "./image-path.ts";
import {
    displayOffsetWidth,
    imageChipMarker,
    stringIndexAtDisplayOffset,
    type ImageChip,
} from "./image-chips.ts";
import {
    isTuiComposerClearKey,
    tuiComposerWordDeleteDirection,
} from "./keymap.ts";

const IMAGE_CHIP_STYLE = "image-chip";
const IMAGE_CHIP_TYPE = "image-chip";
const COLLAPSED_PASTE_TYPE = "collapsed-paste";

const PASTE_SUMMARY_LINE_THRESHOLD = 3;
const PASTE_SUMMARY_CHAR_THRESHOLD = 240;
export const TUI_COMPOSER_MIN_TEXT_ROWS = 3;
export const TUI_COMPOSER_MAX_TEXT_ROWS = 8;

interface CollapsedPaste {
    readonly id: number;
    readonly marker: string;
    readonly text: string;
}

interface TrackedMarker {
    readonly kind: "image" | "paste";
    readonly id: string | number;
    readonly marker: string;
    readonly start: number;
    readonly end: number;
}

export class TuiComposer extends TextareaRenderable {
    private collapsedPastes: CollapsedPaste[] = [];
    private collapsedPasteExtmarks = new Map<number, number>();
    private collapsedPasteTypeId?: number;
    private nextCollapsedPasteId = 1;
    private submittedTexts: string[] = [];
    private submittedTextIndex?: number;
    private imageChips: ImageChip[] = [];
    private imageChipExtmarks = new Map<string, number>();
    private imageChipStyleId?: number;
    private imageChipTypeId?: number;
    onImagePathPaste?: (path: string) => void;
    /** Typed edits may grow the shared composer; paste deliberately may not. */
    onTypedRowsChange?: (rows: number) => void;
    /** A chip the user deleted, so its attachment can be dropped too. */
    onImageChipRemoved?: (requestId: string) => void;
    /** Called before OpenTUI's word-delete binding handles Command-Delete. */
    onCommandDelete?: () => boolean;

    /**
     * Show an attached image as an atomic `[Image N]` chip at the cursor.
     *
     * The chip is a virtual extmark, so the cursor steps over it and one
     * backspace takes the whole marker rather than a character of it.
     */
    attachImageChip(requestId: string): void {
        this.ensureImageChipStyle();
        const marker = imageChipMarker(this.imageChips.length + 1);
        const start = this.getSelection()?.start ?? this.cursorOffset;
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
        if (!this.imageChipExtmarks.has(requestId)) return;
        this.rebuildTrackedMarkers(requestId);
    }

    override handleKeyPress(key: Parameters<TextareaRenderable["handleKeyPress"]>[0]): boolean {
        if (isTuiComposerClearKey(key) && this.onCommandDelete?.() === true) {
            return true;
        }
        if (tuiComposerWordDeleteDirection(key) === "backward") {
            const handled = this.deleteWordBackward();
            this.syncImageChips();
            if (handled) this.publishTypedRows();
            return handled;
        }
        if (tuiComposerWordDeleteDirection(key) === "forward") {
            const handled = this.deleteWordForward();
            this.syncImageChips();
            if (handled) this.publishTypedRows();
            return handled;
        }
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
        if (handled) this.publishTypedRows();
        return handled;
    }

    private publishTypedRows(): void {
        const explicitLines = this.plainText.split("\n").length;
        this.onTypedRowsChange?.(Math.max(
            TUI_COMPOSER_MIN_TEXT_ROWS,
            explicitLines,
            this.virtualLineCount,
        ));
    }

    /**
     * Reconcile the chips with the extmarks that survived the last edit.
     *
     * Deleting inside a virtual extmark removes the whole extmark, so an
     * extmark that is gone is a chip the user deleted.
     */
    private syncImageChips(): void {
        this.syncCollapsedPastes();
        if (this.imageChips.length === 0) return;
        const removed = this.imageChips.filter((chip) => {
            const id = this.imageChipExtmarks.get(chip.requestId);
            return id === undefined
                || this.trackedMarker(id, chip.marker, "image", chip.requestId)
                    === undefined;
        });
        if (removed.length === 0) return;
        for (const chip of removed) {
            this.imageChipExtmarks.delete(chip.requestId);
            this.imageChips = this.imageChips.filter(
                (each) => each.requestId !== chip.requestId,
            );
        }
        this.rebuildTrackedMarkers();
        for (const chip of removed) {
            this.onImageChipRemoved?.(chip.requestId);
        }
    }

    private syncCollapsedPastes(): void {
        this.collapsedPastes = this.collapsedPastes.filter((paste) => {
            const id = this.collapsedPasteExtmarks.get(paste.id);
            const live = id !== undefined
                && this.trackedMarker(id, paste.marker, "paste", paste.id)
                    !== undefined;
            if (!live) this.collapsedPasteExtmarks.delete(paste.id);
            return live;
        });
    }

    private trackedMarker(
        extmarkId: number,
        marker: string,
        kind: TrackedMarker["kind"],
        id: TrackedMarker["id"],
    ): TrackedMarker | undefined {
        const extmark = this.extmarks.get(extmarkId);
        if (extmark === null) return undefined;
        const startIndex = stringIndexAtDisplayOffset(
            this.plainText,
            extmark.start,
        );
        const endIndex = stringIndexAtDisplayOffset(
            this.plainText,
            extmark.end,
        );
        if (this.plainText.slice(startIndex, endIndex) !== marker) {
            return undefined;
        }
        return { kind, id, marker, start: extmark.start, end: extmark.end };
    }

    private trackedMarkers(): readonly TrackedMarker[] {
        return [
            ...this.imageChips.flatMap((chip) => {
                const extmarkId = this.imageChipExtmarks.get(chip.requestId);
                const marker = extmarkId === undefined
                    ? undefined
                    : this.trackedMarker(
                        extmarkId,
                        chip.marker,
                        "image",
                        chip.requestId,
                    );
                return marker === undefined ? [] : [marker];
            }),
            ...this.collapsedPastes.flatMap((paste) => {
                const extmarkId = this.collapsedPasteExtmarks.get(paste.id);
                const marker = extmarkId === undefined
                    ? undefined
                    : this.trackedMarker(
                        extmarkId,
                        paste.marker,
                        "paste",
                        paste.id,
                    );
                return marker === undefined ? [] : [marker];
            }),
        ].toSorted((left, right) => left.start - right.start);
    }

    /** Rebuild marker text from extmark identity, never from a text search. */
    private rebuildTrackedMarkers(omitImageRequestId?: string): void {
        const cursor = this.cursorOffset;
        const original = this.plainText;
        const markers = this.trackedMarkers();
        const images: {
            readonly requestId: string;
            readonly marker: string;
            readonly start: number;
            readonly end: number;
        }[] = [];
        const pastes: {
            readonly paste: CollapsedPaste;
            readonly start: number;
            readonly end: number;
        }[] = [];
        let rewritten = "";
        let restIndex = 0;
        let imagePosition = 0;

        for (const tracked of markers) {
            const startIndex = stringIndexAtDisplayOffset(original, tracked.start);
            let endIndex = stringIndexAtDisplayOffset(original, tracked.end);
            if (startIndex < restIndex) continue;
            rewritten += original.slice(restIndex, startIndex);
            if (
                tracked.kind === "image"
                && tracked.id === omitImageRequestId
            ) {
                if (original[endIndex] === " ") endIndex += 1;
            } else if (tracked.kind === "image") {
                const marker = imageChipMarker(++imagePosition);
                const start = displayOffsetWidth(rewritten);
                rewritten += marker;
                images.push({
                    requestId: tracked.id as string,
                    marker,
                    start,
                    end: displayOffsetWidth(rewritten),
                });
            } else {
                const paste = this.collapsedPastes.find(
                    (candidate) => candidate.id === tracked.id,
                );
                if (paste !== undefined) {
                    const start = displayOffsetWidth(rewritten);
                    rewritten += paste.marker;
                    pastes.push({
                        paste,
                        start,
                        end: displayOffsetWidth(rewritten),
                    });
                }
            }
            restIndex = endIndex;
        }
        rewritten += original.slice(restIndex);

        this.extmarks.clear();
        this.imageChipExtmarks.clear();
        this.collapsedPasteExtmarks.clear();
        this.imageChips = images.map((chip) => ({
            requestId: chip.requestId,
            marker: chip.marker,
        }));
        this.collapsedPastes = pastes.map(({ paste }) => paste);
        this.setText(rewritten);
        if (images.length > 0) this.ensureImageChipStyle();
        for (const chip of images) {
            const id = this.extmarks.create({
                start: chip.start,
                end: chip.end,
                virtual: true,
                styleId: this.imageChipStyleId,
                typeId: this.imageChipTypeId,
            });
            this.imageChipExtmarks.set(chip.requestId, id);
        }
        if (pastes.length > 0) this.ensureCollapsedPasteType();
        for (const { paste, start, end } of pastes) {
            const id = this.extmarks.create({
                start,
                end,
                typeId: this.collapsedPasteTypeId,
            });
            this.collapsedPasteExtmarks.set(paste.id, id);
        }
        this.cursorOffset = Math.min(
            cursor,
            displayOffsetWidth(rewritten),
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

    private ensureCollapsedPasteType(): void {
        this.collapsedPasteTypeId ??=
            this.extmarks.registerType(COLLAPSED_PASTE_TYPE);
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
        const id = this.nextCollapsedPasteId++;
        const start = this.getSelection()?.start ?? this.cursorOffset;
        this.ensureCollapsedPasteType();
        this.insertText(marker);
        const extmarkId = this.extmarks.create({
            start,
            end: start + displayOffsetWidth(marker),
            typeId: this.collapsedPasteTypeId,
        });
        this.collapsedPastes.push({ id, marker, text });
        this.collapsedPasteExtmarks.set(id, extmarkId);
    }

    /**
     * The prompt to submit.
     *
     * Image chips are removed: the attachments travel as IDs alongside the
     * prompt, so leaving `[Image 1]` in the text would only label them twice.
     */
    expandedText(): string {
        this.syncImageChips();
        let expanded = this.plainText;
        const replacements = this.trackedMarkers().map((tracked) => {
            const start = stringIndexAtDisplayOffset(this.plainText, tracked.start);
            let end = stringIndexAtDisplayOffset(this.plainText, tracked.end);
            if (tracked.kind === "image" && this.plainText[end] === " ") {
                end += 1;
            }
            const paste = tracked.kind === "paste"
                ? this.collapsedPastes.find(
                    (candidate) => candidate.id === tracked.id,
                )
                : undefined;
            return {
                start,
                end,
                text: paste?.text ?? "",
            };
        }).toSorted((left, right) => right.start - left.start);
        for (const replacement of replacements) {
            expanded = expanded.slice(0, replacement.start)
                + replacement.text
                + expanded.slice(replacement.end);
        }
        return expanded.trim();
    }

    clearComposer(): void {
        this.setComposerText("");
    }

    /**
     * Insert extension-produced text as an ordinary edit. Unlike setComposerText,
     * this respects the cursor or selection and keeps image chips and collapsed
     * paste state intact.
     */
    insertComposerText(text: string): void {
        this.submittedTextIndex = undefined;
        this.insertText(normalizeLineEndings(text));
        this.syncImageChips();
        this.publishTypedRows();
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
        this.collapsedPasteExtmarks.clear();
        this.nextCollapsedPasteId = 1;
        this.submittedTextIndex = undefined;
        this.imageChips = [];
        this.imageChipExtmarks.clear();
        this.extmarks.clear();
        this.setText(text);
        // OpenTUI resets the editor cursor to offset 0 after setText(). Keep
        // completion and picker-driven text edits natural by placing it at
        // the end of the inserted value.
        this.cursorOffset = text.length;
        this.onTypedRowsChange?.(TUI_COMPOSER_MIN_TEXT_ROWS);
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
        height: TUI_COMPOSER_MIN_TEXT_ROWS,
        placeholder: COMPOSER_PLACEHOLDER,
        backgroundColor: TUI_INPUT,
        focusedBackgroundColor: TUI_INPUT,
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
            // Terminals outside the kitty protocol cannot encode shift+enter
            // and send ESC CR instead (option+enter, or a shift+enter remap).
            { name: "return", meta: true, action: "newline" },
            { name: "enter", meta: true, action: "newline" },
            { name: "kpenter", meta: true, action: "newline" },
        ],
        onSubmit,
    });
    composer.onImagePathPaste = onImagePathPaste;
    return composer;
}

/**
 * How tall the composer panel is: three rows of text, a rule, and the row of
 * session state that sits inside the frame. Anything that reserves room for
 * the composer measures from this rather than from a number of its own, which
 * is free to disagree with it.
 */
export const TUI_COMPOSER_PANEL_ROWS = tuiComposerPanelRows(
    TUI_COMPOSER_MIN_TEXT_ROWS,
);

export function tuiComposerPanelRows(textRows: number): number {
    return textRows + 4;
}

export interface TuiComposerPanel {
    readonly panel: BoxRenderable;
    /** The row inside the frame, written by whoever owns the status line. */
    readonly status: TextRenderable;
    /** The line between the text and that row, repainted with the theme. */
    readonly rule: BoxRenderable;
}

export interface TuiComposerPanelAppearance {
    readonly marginHorizontal?: number;
    readonly paddingHorizontal?: number;
    readonly boundaryColor?: string;
}

export function createTuiComposerPanel(
    renderer: RenderContext,
    composer: TuiComposer,
    appearance: TuiComposerPanelAppearance = {},
): TuiComposerPanel {
    const boundaryColor = appearance.boundaryColor ?? TUI_ELEMENT;
    const panel = new BoxRenderable(renderer, {
        id: "composer-box",
        border: true,
        borderStyle: "rounded",
        borderColor: boundaryColor,
        focusedBorderColor: boundaryColor,
        // The same ground the theme change paints, so the frame looks the
        // same at startup as after the first theme apply.
        backgroundColor: TUI_INPUT,
        height: TUI_COMPOSER_PANEL_ROWS,
        paddingLeft: appearance.paddingHorizontal ?? 1,
        paddingRight: appearance.paddingHorizontal ?? 1,
        // Indented to where the lines under it start, so the frame and what it
        // says about the session read as one column.
        marginLeft: appearance.marginHorizontal ?? 2,
        marginRight: appearance.marginHorizontal ?? 2,
        // Reserve the rows under the frame; whoever draws them sizes this to
        // what they actually take.
        marginBottom: 2,
        flexDirection: "column",
        // OpenCode focuses its textarea from mouse-down. Vera extends that
        // mechanic to the padded panel because the whole panel reads as input.
        onMouseDown: () => composer.focus(),
    });
    // A bordered box rather than a row of glyphs: the rule then spans the
    // panel at whatever width it is drawn, with nothing to recompute.
    const rule = new BoxRenderable(renderer, {
        id: "composer-rule",
        border: ["top"],
        borderColor: boundaryColor,
        focusedBorderColor: boundaryColor,
        width: "100%",
        height: 1,
        flexShrink: 0,
    });
    const status = new TextRenderable(renderer, {
        id: "composer-status",
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        flexShrink: 0,
    });
    panel.add(composer);
    panel.add(rule);
    panel.add(status);
    return { panel, status, rule };
}

function shouldCollapsePaste(text: string): boolean {
    const lineCount = text.split("\n").length;
    return lineCount >= PASTE_SUMMARY_LINE_THRESHOLD
        || text.length >= PASTE_SUMMARY_CHAR_THRESHOLD;
}

function normalizeLineEndings(text: string): string {
    return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}
