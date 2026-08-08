import {
    BoxRenderable,
    MarkdownRenderable,
    ScrollBoxRenderable,
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
/**
 * The divider is drawn one column wide and grabbed three: a one-column target
 * is a line, not a handle.
 */
const DIVIDER_WIDTH = 3;

export interface TuiSidebarTheme {
    readonly background: string;
    readonly border: string;
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
    open(title: string): void;
    close(): void;
    /** Replaces the title of an already open sidebar. */
    setTitle(title: string): void;
    append(label: string, text: string): void;
    clear(): void;
    width(): number;
}

/**
 * A region beside the transcript that something other than the transcript owns.
 *
 * It is deliberately not a multi-seat pane: it takes a title and blocks of
 * text, so the next thing that needs a second column does not need a second
 * implementation.
 */
export function createTuiSidebar(options: TuiSidebarOptions): TuiSidebar {
    const { renderer, theme } = options;
    let width = clampSidebarWidth(
        options.initialWidth ?? DEFAULT_SIDEBAR_WIDTH,
        renderer.terminalWidth,
    );
    let open = false;
    let blocks = 0;

    const body = new BoxRenderable(renderer, {
        id: "body",
        width: "100%",
        flexGrow: 1,
        flexDirection: "row",
    });

    const divider = new BoxRenderable(renderer, {
        id: "sidebar-divider",
        width: DIVIDER_WIDTH,
        height: "100%",
        flexShrink: 0,
        visible: false,
        onMouseDown: (event: MouseEvent) => {
            // Claimed before the transcript's selection sees it, or dragging
            // the divider would paint a selection across the transcript.
            event.preventDefault();
            event.stopPropagation();
        },
        onMouseDrag: (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            resize(renderer.terminalWidth - event.x - 1);
        },
        onMouseDragEnd: (event: MouseEvent) => {
            event.stopPropagation();
            options.onWidthChanged?.(width);
        },
    });
    const dividerLine = new BoxRenderable(renderer, {
        id: "sidebar-divider-line",
        width: 1,
        height: "100%",
        marginLeft: 1,
        backgroundColor: theme.border,
    });
    divider.add(dividerLine);

    const title = new TextRenderable(renderer, {
        id: "sidebar-title",
        content: "",
        fg: theme.muted,
        width: "100%",
        height: 1,
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
        visible: false,
    });
    panel.add(title);
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

    return {
        body,
        isOpen: () => open,
        open(text: string): void {
            open = true;
            title.content = text;
            // The terminal may have been resized while the sidebar was closed.
            resize(width);
            panel.visible = true;
            divider.visible = true;
            options.onLayoutChanged?.();
        },
        close(): void {
            open = false;
            panel.visible = false;
            divider.visible = false;
            options.onLayoutChanged?.();
        },
        setTitle(text: string): void {
            title.content = text;
            options.onLayoutChanged?.();
        },
        append(label: string, text: string): void {
            blocks += 1;
            content.add(
                new MarkdownRenderable(renderer, {
                    id: `sidebar-block-${blocks}`,
                    content: `**${label}**\n\n${text}`,
                    syntaxStyle: options.syntaxStyle,
                    fg: theme.text,
                    width: "100%",
                }),
            );
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
