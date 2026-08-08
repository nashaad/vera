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
    readonly background: string;
    /** The sidebar's own ground: the split is a colour change, not a rule. */
    readonly panel: string;
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
    readonly theme: TuiSidebarTheme;
    readonly syntaxStyle: SyntaxStyle;
    /** The width to open at, when one was remembered. */
    readonly initialWidth?: number;
    /** Called when a drag settles, so the width outlives the session. */
    readonly onWidthChanged?: (columns: number) => void;
    /** Called whenever the layout changed and the frame needs redrawing. */
    readonly onLayoutChanged?: () => void;
}

export interface TuiSidebar {
    /** Holds the transcript and the sidebar side by side. */
    readonly body: BoxRenderable;
    isOpen(): boolean;
    /** True while the split is actually drawn: false when narrow or hidden. */
    isShown(): boolean;
    /** Hides or restores the split without taking it from its owner. */
    toggleHidden(): void;
    open(): void;
    close(): void;
    append(label: string, text: string): void;
    clear(): void;
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
 * It is deliberately not a multi-seat pane: it takes labelled blocks of text,
 * so the next thing that needs a second column does not need a second
 * implementation.
 */
export function createTuiSidebar(options: TuiSidebarOptions): TuiSidebar {
    const { renderer, theme } = options;
    let width = clampSidebarWidth(
        options.initialWidth ?? DEFAULT_SIDEBAR_WIDTH,
        renderer.terminalWidth,
    );
    let open = false;
    // Hidden is the user's call, and outlives a resize: the sidebar stays out
    // of the way until it is asked back.
    let hidden = false;
    let blocks = 0;

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
    const panel = new BoxRenderable(renderer, {
        id: "sidebar",
        width,
        height: "100%",
        flexShrink: 0,
        flexDirection: "column",
        paddingLeft: 1,
        // Starts on the transcript's first line, not the frame's, and keeps a
        // line at the foot so the last block does not sit on the edge.
        paddingTop: 1,
        paddingBottom: 1,
        backgroundColor: theme.panel,
        visible: false,
    });
    panel.add(content);

    body.add(options.transcript);
    body.add(divider);
    body.add(panel);

    function resize(requested: number): void {
        const next = clampSidebarWidth(requested, renderer.terminalWidth);
        if (next === width) return;
        width = next;
        panel.width = width;
        options.onLayoutChanged?.();
    }

    function shown(): boolean {
        return open && !hidden && renderer.terminalWidth >= MIN_SPLIT_WIDTH;
    }

    function apply(): void {
        const visible = shown();
        if (!visible) {
            dragging = false;
            divider.backgroundColor = theme.handle;
        }
        panel.visible = visible;
        divider.visible = visible;
        options.onLayoutChanged?.();
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
        toggleHidden(): void {
            hidden = !hidden;
            apply();
        },
        open(): void {
            open = true;
            hidden = false;
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
        append(label: string, text: string): void {
            blocks += 1;
            const block = new BoxRenderable(renderer, {
                id: `sidebar-block-${blocks}`,
                width: "100%",
                flexDirection: "column",
            });
            // The label is drawn, not parsed: markdown would eat the brackets
            // and asterisks that model names and aliases are full of.
            block.add(
                new TextRenderable(renderer, {
                    id: `sidebar-block-${blocks}-label`,
                    content: label,
                    fg: theme.muted,
                    attributes: TextAttributes.BOLD,
                    width: "100%",
                    wrapMode: "word",
                }),
            );
            block.add(
                new MarkdownRenderable(renderer, {
                    id: `sidebar-block-${blocks}-text`,
                    content: text,
                    syntaxStyle: options.syntaxStyle,
                    fg: theme.text,
                    width: "100%",
                    marginTop: 1,
                }),
            );
            content.add(block);
            options.onLayoutChanged?.();
        },
        clear(): void {
            for (const child of [...content.getChildren()]) {
                content.remove(child.id);
            }
            blocks = 0;
            options.onLayoutChanged?.();
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
