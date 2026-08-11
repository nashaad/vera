import {
    BoxRenderable,
    MarkdownRenderable,
    ScrollBoxRenderable,
    TextAttributes,
    TextRenderable,
    type CliRenderer,
    type MouseEvent,
    type Renderable,
    type SyntaxStyle,
} from "@opentui/core";

/** Below this the sidebar has no room to say anything. */
export const MIN_SIDEBAR_WIDTH = 20;
/** The transcript keeps at least this much, whatever the divider is dragged to. */
export const MIN_TRANSCRIPT_WIDTH = 30;
export const DEFAULT_SIDEBAR_WIDTH = 44;
/** Pane focus is navigation chrome, so it stays recognizable across themes. */
export const SIDEBAR_FOCUS_GREEN = "#22c55e";
/** The grab strip: one column, so it reads as an edge and not as a bar. */
const DIVIDER_WIDTH = 1;

/**
 * Under this the split has no room for both halves, so the sidebar steps
 * aside until the terminal is wide again. It stays open the whole time: this
 * is layout, not a close.
 */
export const MIN_SPLIT_WIDTH = MIN_SIDEBAR_WIDTH + MIN_TRANSCRIPT_WIDTH
    + DIVIDER_WIDTH;

export interface TuiSidebarTheme {
    /** The strip between the two, the only part that says it can be dragged. */
    readonly handle: string;
    /** The same strip while it is held. */
    readonly handleActive: string;
    readonly muted: string;
    readonly text: string;
}

export interface TuiSidebarOptions {
    readonly renderer: CliRenderer;
    readonly transcript: Renderable;
    /** Called when the column itself is clicked, not the strip beside it. */
    readonly onPanelClick?: () => void;
    /** Called after any click or selection gesture ends in the column. */
    readonly onPanelRelease?: () => void;
    readonly theme: TuiSidebarTheme;
    readonly syntaxStyle: SyntaxStyle;
    /** The width to open at, when one was remembered. */
    readonly initialWidth?: number;
    /** Called when a drag settles, so the width outlives the session. */
    readonly onWidthChanged?: (columns: number) => void;
    /** Called whenever the layout changed and the frame needs redrawing. */
    readonly onLayoutChanged?: () => void;
}

/** A block in the column, paired with the label drawn above it. */
export interface TuiSidebarBlock {
    readonly node: Renderable;
    /** Who a quotation taken from this block is attributed to. */
    readonly speaker: string;
}

export interface TuiSidebar {
    /** Holds the transcript and the sidebar side by side. */
    readonly body: BoxRenderable;
    /** What a selection can land in, and who said it. */
    blocks(): readonly TuiSidebarBlock[];
    isOpen(): boolean;
    /** True while the split is actually drawn: false when narrow or hidden. */
    isShown(): boolean;
    layout(): "main" | "split" | "sidebar";
    /** Cycles split -> sidebar-only -> main-only -> split. */
    cycleLayout(): "main" | "split" | "sidebar";
    /** Marks this surface as the current composer target. */
    setFocused(focused: boolean): void;
    isFocused(): boolean;
    /** Persistent identity and permission text above the attached surface. */
    setHeader(text: string | undefined): void;
    /** Persistent identity and permission text above the primary transcript. */
    setMainHeader(text: string | undefined): void;
    open(): void;
    close(): void;
    append(label: string, text: string, speaker?: string): void;
    /** Replaces every transcript block with one layout notification. */
    replace(blocks: readonly {
        readonly label: string;
        readonly text: string;
        readonly speaker?: string;
    }[]): void;
    /** Reconciles caller-rendered transcript nodes without rebuilding them. */
    replaceRendered(blocks: readonly TuiSidebarBlock[]): void;
    clear(): void;
    /**
     * Repaints the column, and every block already in it, in a new palette.
     *
     * The syntax style comes with it: the old one is destroyed when the theme
     * changes, and a block drawn against a destroyed style throws.
     */
    setTheme(theme: TuiSidebarTheme, syntaxStyle: SyntaxStyle): void;
    /** Re-reads the terminal width; call it on resize. */
    refit(): void;
    /** True while the column is pinned to its newest block. */
    isFollowing(): boolean;
    scrollToBottom(): void;
    /** Where the scrolling region sits, for an overlay pinned to its foot. */
    bounds(): { x: number; y: number; width: number; height: number };
    width(): number;
}

/**
 * A region beside the transcript that something other than the transcript owns.
 *
 * It is deliberately not a multi-lane pane: it takes labelled blocks of text,
 * so the next thing that needs a second column does not need a second
 * implementation.
 */
export function createTuiSidebar(options: TuiSidebarOptions): TuiSidebar {
    const { renderer } = options;
    let theme = options.theme;
    let syntaxStyle = options.syntaxStyle;
    let width = clampSidebarWidth(
        options.initialWidth ?? DEFAULT_SIDEBAR_WIDTH,
        renderer.terminalWidth,
    );
    let open = false;
    // Layout is explicit so a hidden pane can never remain the composer target.
    let layout: "main" | "split" | "sidebar" = "split";
    let focused = false;
    let headerText: string | undefined;
    let mainHeaderText: string | undefined;
    let blocks = 0;
    const appended: TuiSidebarBlock[] = [];
    // The parts of each block that carry a colour. A block is built once and
    // the theme can change under it, so the pieces have to stay reachable.
    const painted: { label: TextRenderable; text: MarkdownRenderable }[] = [];

    // The divider is grabbed on mouse-down, and every drag after that resizes
    // wherever the pointer went. A fast drag reports its first motion well
    // clear of the three columns, which is why the drag is not read off the
    // divider itself.
    let dragging = false;

    const body = new BoxRenderable(renderer, {
        id: "body",
        width: "100%",
        flexGrow: 1,
        flexDirection: "row",
        onMouseDrag: (event: MouseEvent) => {
            if (!dragging) return;
            event.preventDefault();
            event.stopPropagation();
            resize(renderer.terminalWidth - event.x - 1);
        },
        onMouseUp: (event: MouseEvent) => {
            if (!dragging) return;
            dragging = false;
            divider.backgroundColor = theme.handle;
            event.stopPropagation();
            options.onWidthChanged?.(width);
        },
    });

    const divider = new BoxRenderable(renderer, {
        id: "sidebar-divider",
        width: DIVIDER_WIDTH,
        height: "100%",
        flexShrink: 0,
        visible: false,
        backgroundColor: theme.handle,
        onMouseDown: (event: MouseEvent) => {
            // Claimed before the transcript's selection sees it, or dragging
            // the divider would paint a selection across the transcript.
            event.preventDefault();
            event.stopPropagation();
            dragging = true;
            // Lit while held, so a drag that runs past the strip still shows
            // what is being moved.
            divider.backgroundColor = theme.handleActive;
        },
    });
    const content = new ScrollBoxRenderable(renderer, {
        id: "sidebar-content",
        flexGrow: 1,
        width: "100%",
        stickyScroll: true,
        stickyStart: "bottom",
        scrollY: true,
        contentOptions: {
            flexDirection: "column",
            gap: 1,
            paddingRight: 1,
        },
    });
    let panelDragged = false;
    const sidebarColumn = new BoxRenderable(renderer, {
        id: "sidebar-column",
        width,
        height: "100%",
        flexShrink: 0,
        flexDirection: "column",
        visible: false,
        // Own the whole column, including the focus rail. Otherwise a click on
        // the rail itself reaches the app behind it and switches focus back to
        // the transcript.
        onMouseDrag: () => {
            panelDragged = true;
        },
        onMouseDragEnd: () => {
            panelDragged = true;
        },
        onMouseUp: (event: MouseEvent) => {
            const dragged = panelDragged;
            panelDragged = false;
            event.stopPropagation();
            options.onPanelRelease?.();
            if (!dragged) {
                options.onPanelClick?.();
            }
        },
    });
    const panel = new BoxRenderable(renderer, {
        id: "sidebar",
        width: "100%",
        flexGrow: 1,
        flexDirection: "column",
        paddingLeft: 1,
        // The app supplies the shared top inset. Keep only a line at the foot
        // so the last block does not sit on the edge.
        paddingTop: 0,
        paddingBottom: 1,
    });
    const header = new TextRenderable(renderer, {
        id: "sidebar-header",
        content: "",
        fg: theme.muted,
        attributes: TextAttributes.BOLD,
        width: "100%",
        height: 1,
        visible: false,
    });
    const sidebarFocusRail = new TextRenderable(renderer, {
        id: "sidebar-focus-rail",
        width: "100%",
        height: 1,
        flexShrink: 0,
        content: "",
        fg: SIDEBAR_FOCUS_GREEN,
    });
    sidebarColumn.add(header);
    sidebarColumn.add(sidebarFocusRail);
    panel.add(content);
    sidebarColumn.add(panel);

    const mainColumn = new BoxRenderable(renderer, {
        id: "main-column",
        flexGrow: 1,
        flexDirection: "column",
    });
    const mainHeader = new TextRenderable(renderer, {
        id: "main-header",
        content: "",
        fg: theme.muted,
        attributes: TextAttributes.BOLD,
        width: "100%",
        height: 1,
        visible: false,
    });
    const mainFocusRail = new TextRenderable(renderer, {
        id: "main-focus-rail",
        width: "100%",
        height: 1,
        flexShrink: 0,
        content: "",
        fg: SIDEBAR_FOCUS_GREEN,
    });
    mainColumn.add(mainHeader);
    mainColumn.add(mainFocusRail);
    mainColumn.add(options.transcript);
    body.add(mainColumn);
    body.add(divider);
    body.add(sidebarColumn);

    function resize(requested: number): void {
        const next = clampSidebarWidth(requested, renderer.terminalWidth);
        if (next === width) return;
        width = next;
        sidebarColumn.width = width;
        paintFocusRails();
        options.onLayoutChanged?.();
    }

    function effectiveLayout(): "main" | "split" | "sidebar" {
        if (!open) return "main";
        if (layout === "split" && renderer.terminalWidth < MIN_SPLIT_WIDTH) {
            return "main";
        }
        return layout;
    }

    function shown(): boolean {
        return effectiveLayout() !== "main";
    }

    function paintFocusRails(): void {
        const current = effectiveLayout();
        if (current !== "split") {
            mainFocusRail.content = "";
            sidebarFocusRail.content = "";
            return;
        }
        const mainWidth = Math.max(
            0,
            renderer.terminalWidth - width - DIVIDER_WIDTH,
        );
        mainFocusRail.content = focused ? "" : "▁".repeat(mainWidth);
        sidebarFocusRail.content = focused ? "▁".repeat(width) : "";
    }

    function apply(): void {
        const current = effectiveLayout();
        if (current === "main") focused = false;
        if (current !== "split") {
            dragging = false;
            divider.backgroundColor = theme.handle;
        }
        mainColumn.visible = current !== "sidebar";
        sidebarColumn.visible = current !== "main";
        sidebarColumn.width = current === "sidebar" ? "100%" : width;
        panel.paddingLeft = current === "sidebar" ? 2 : 1;
        divider.visible = current === "split";
        paintFocusRails();
        options.onLayoutChanged?.();
    }

    function createBlock(
        number: number,
        label: string,
        text: string,
        speaker?: string,
    ): {
        readonly block: TuiSidebarBlock;
        readonly paint: { label: TextRenderable; text: MarkdownRenderable };
    } {
        const node = new BoxRenderable(renderer, {
            id: `sidebar-block-${number}`,
            width: "100%",
            flexDirection: "column",
        });
        // The label is drawn, not parsed: markdown would eat the brackets and
        // asterisks that model names and aliases are full of.
        const labelNode = new TextRenderable(renderer, {
            id: `sidebar-block-${number}-label`,
            content: label,
            fg: theme.muted,
            attributes: TextAttributes.BOLD,
            width: "100%",
            wrapMode: "word",
        });
        const textNode = new MarkdownRenderable(renderer, {
            id: `sidebar-block-${number}-text`,
            content: text,
            syntaxStyle,
            fg: theme.text,
            width: "100%",
            marginTop: 1,
        });
        node.add(labelNode);
        node.add(textNode);
        return {
            block: { node, speaker: speaker ?? label },
            paint: { label: labelNode, text: textNode },
        };
    }

    function removeBlocks(): void {
        for (const child of [...content.getChildren()]) {
            content.remove(child.id);
        }
        appended.length = 0;
        painted.length = 0;
        blocks = 0;
    }

    return {
        body,
        isFollowing: () =>
            content.scrollTop >= content.scrollHeight - content.viewport.height,
        scrollToBottom: () => content.scrollTo(content.scrollHeight),
        bounds: () => ({
            x: content.x,
            y: content.y,
            width: content.width,
            height: content.height,
        }),
        isOpen: () => open,
        isShown: shown,
        layout: effectiveLayout,
        cycleLayout(): "main" | "split" | "sidebar" {
            layout = layout === "split"
                ? "sidebar"
                : layout === "sidebar" ? "main" : "split";
            focused = layout === "sidebar";
            apply();
            return effectiveLayout();
        },
        setFocused(nextFocused): void {
            focused = nextFocused;
            // Keep the row mounted. OpenTUI can retain stale flex geometry
            // when a child is repeatedly hidden and restored, which made the
            // rail appear on first focus but not on later focus cycles.
            paintFocusRails();
            options.onLayoutChanged?.();
        },
        isFocused: () => focused,
        setHeader(text): void {
            if (headerText === text) return;
            headerText = text;
            header.content = text ?? "";
            header.visible = text !== undefined && text.length > 0;
            options.onLayoutChanged?.();
        },
        setMainHeader(text): void {
            if (mainHeaderText === text) return;
            mainHeaderText = text;
            mainHeader.content = text ?? "";
            mainHeader.visible = text !== undefined && text.length > 0;
            options.onLayoutChanged?.();
        },
        open(): void {
            open = true;
            layout = "split";
            // The terminal may have been resized while the sidebar was closed.
            resize(width);
            apply();
        },
        close(): void {
            open = false;
            apply();
        },
        refit(): void {
            resize(width);
            apply();
        },
        append(label: string, text: string, speaker?: string): void {
            blocks += 1;
            const created = createBlock(blocks, label, text, speaker);
            painted.push(created.paint);
            appended.push(created.block);
            content.add(created.block.node);
            options.onLayoutChanged?.();
        },
        replace(nextBlocks): void {
            // Markdown layout finishes asynchronously. Recreating every node
            // on each streamed update exposes labels before their bodies are
            // ready, so retain the common prefix and update it in place.
            const retained = Math.min(appended.length, nextBlocks.length);
            for (let index = 0; index < retained; index += 1) {
                const next = nextBlocks[index]!;
                const paint = painted[index]!;
                paint.label.content = next.label;
                paint.text.content = next.text;
                appended[index] = {
                    node: appended[index]!.node,
                    speaker: next.speaker ?? next.label,
                };
            }
            while (appended.length > nextBlocks.length) {
                const removed = appended.pop()!;
                painted.pop();
                content.remove(removed.node.id);
            }
            blocks = appended.length;
            for (const next of nextBlocks.slice(retained)) {
                blocks += 1;
                const created = createBlock(
                    blocks,
                    next.label,
                    next.text,
                    next.speaker,
                );
                painted.push(created.paint);
                appended.push(created.block);
                content.add(created.block.node);
            }
            options.onLayoutChanged?.();
        },
        replaceRendered(nextBlocks): void {
            let retained = 0;
            while (
                retained < appended.length
                && retained < nextBlocks.length
                && appended[retained]!.node === nextBlocks[retained]!.node
            ) {
                appended[retained] = nextBlocks[retained]!;
                retained += 1;
            }
            while (appended.length > retained) {
                const removed = appended.pop()!;
                content.remove(removed.node.id);
            }
            // Caller-rendered nodes carry their own palette and are not part
            // of the sidebar's label/Markdown paint list.
            painted.length = 0;
            for (const block of nextBlocks.slice(retained)) {
                appended.push(block);
                content.add(block.node);
            }
            blocks = appended.length;
            options.onLayoutChanged?.();
        },
        blocks: () => appended,
        clear(): void {
            removeBlocks();
            options.onLayoutChanged?.();
        },
        setTheme(next: TuiSidebarTheme, nextSyntaxStyle: SyntaxStyle): void {
            theme = next;
            syntaxStyle = nextSyntaxStyle;
            header.fg = theme.muted;
            mainHeader.fg = theme.muted;
            divider.backgroundColor = dragging
                ? theme.handleActive
                : theme.handle;
            for (const block of painted) {
                block.label.fg = theme.muted;
                block.text.fg = theme.text;
                block.text.syntaxStyle = syntaxStyle;
            }
        },
        width: () => width,
    };
}

export function clampSidebarWidth(
    requested: number,
    terminalWidth: number,
): number {
    const room = terminalWidth - MIN_TRANSCRIPT_WIDTH - DIVIDER_WIDTH;
    if (room < MIN_SIDEBAR_WIDTH) {
        // Too narrow to split at all: the sidebar keeps its floor and the
        // transcript gives up what is left, rather than both collapsing.
        return MIN_SIDEBAR_WIDTH;
    }
    return Math.min(Math.max(Math.round(requested), MIN_SIDEBAR_WIDTH), room);
}
