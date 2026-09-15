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

export const MIN_SIDEBAR_WIDTH = 20;
export const MIN_TRANSCRIPT_WIDTH = 30;
export const DEFAULT_SIDEBAR_WIDTH = 44;
const DIVIDER_WIDTH = 1;
const PANE_HEADER_GAP = 1;

export const MIN_SPLIT_WIDTH = MIN_SIDEBAR_WIDTH + MIN_TRANSCRIPT_WIDTH
    + DIVIDER_WIDTH;

export interface TuiSidebarTheme {
    readonly handle: string;
    readonly handleActive: string;
    readonly muted: string;
    readonly text: string;
    readonly focus: string;
    readonly inactive: string;
}

export interface TuiSidebarOptions {
    readonly renderer: CliRenderer;
    readonly transcript: Renderable;
    readonly onPanelClick?: () => void;
    readonly onPanelRelease?: () => void;
    readonly theme: TuiSidebarTheme;
    readonly syntaxStyle: SyntaxStyle;
    readonly onHeaderClick?: () => void;
    readonly onMainHeaderClick?: () => void;
    readonly initialWidth?: number;
    readonly onWidthChanged?: (columns: number) => void;
    readonly onLayoutChanged?: () => void;
}

export interface TuiSidebarBlock {
    readonly node: Renderable;
    readonly speaker: string;
}

export interface TuiSidebar {
    readonly body: BoxRenderable;
    blocks(): readonly TuiSidebarBlock[];
    headers(): readonly TextRenderable[];
    isOpen(): boolean;
    isShown(): boolean;
    layout(): "main" | "split" | "sidebar";
    cycleLayout(): "main" | "split" | "sidebar";
    setFocused(focused: boolean): void;
    isFocused(): boolean;
    setHeader(text: string | undefined): void;
    setMainHeader(text: string | undefined): void;
    open(): void;
    close(): void;
    append(label: string, text: string, speaker?: string): void;
    replace(blocks: readonly {
        readonly label: string;
        readonly text: string;
        readonly speaker?: string;
    }[]): void;
    replaceRendered(blocks: readonly TuiSidebarBlock[]): void;
    clear(): void;
    setTheme(theme: TuiSidebarTheme, syntaxStyle: SyntaxStyle): void;
    refit(): void;
    isFollowing(): boolean;
    scrollToBottom(): void;
    bounds(): { x: number; y: number; width: number; height: number };
    width(): number;
}

export function createTuiSidebar(options: TuiSidebarOptions): TuiSidebar {
    const { renderer } = options;
    let theme = options.theme;
    let syntaxStyle = options.syntaxStyle;
    let width = clampSidebarWidth(
        options.initialWidth ?? DEFAULT_SIDEBAR_WIDTH,
        renderer.terminalWidth,
    );
    let open = false;
    let layout: "main" | "split" | "sidebar" = "split";
    let focused = false;
    let headerText: string | undefined;
    let mainHeaderText: string | undefined;
    let blocks = 0;
    const appended: TuiSidebarBlock[] = [];
    const painted: { label: TextRenderable; text: MarkdownRenderable }[] = [];

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
            divider.borderColor = theme.handle;
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
        border: ["left"],
        borderColor: theme.handle,
        onMouseDown: (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            dragging = true;
            divider.borderColor = theme.handleActive;
        },
    });
    const content = new ScrollBoxRenderable(renderer, {
        id: "sidebar-content",
        flexGrow: 1,
        width: "100%",
        stickyScroll: true,
        stickyStart: "bottom",
        scrollY: true,
        // Reserve a column inside the scrollbar. Content padding does not shrink OpenTUI's full-width rows, so it would still paint flush.
        wrapperOptions: { paddingRight: 1 },
        contentOptions: {
            flexDirection: "column",
            gap: 0,
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
        marginBottom: PANE_HEADER_GAP,
        onMouseUp: (event: MouseEvent) => {
            if (renderer.getSelection()?.getSelectedText()) return;
            event.preventDefault();
            event.stopPropagation();
            options.onHeaderClick?.();
        },
        visible: false,
    });
    const sidebarFocusRail = new TextRenderable(renderer, {
        id: "sidebar-focus-rail",
        width: "100%",
        height: 1,
        flexShrink: 0,
        visible: false,
        content: "",
        fg: theme.focus,
    });
    sidebarColumn.add(sidebarFocusRail);
    sidebarColumn.add(header);
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
        marginBottom: PANE_HEADER_GAP,
        onMouseUp: (event: MouseEvent) => {
            if (renderer.getSelection()?.getSelectedText()) return;
            event.preventDefault();
            event.stopPropagation();
            options.onMainHeaderClick?.();
        },
        visible: false,
    });
    const mainFocusRail = new TextRenderable(renderer, {
        id: "main-focus-rail",
        width: "100%",
        height: 1,
        flexShrink: 0,
        visible: false,
        content: "",
        fg: theme.focus,
    });
    mainColumn.add(mainFocusRail);
    mainColumn.add(mainHeader);
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
            mainFocusRail.visible = false;
            sidebarFocusRail.visible = false;
            return;
        }
        mainFocusRail.visible = true;
        sidebarFocusRail.visible = true;
        const mainWidth = Math.max(
            0,
            renderer.terminalWidth - width - DIVIDER_WIDTH,
        );
        mainFocusRail.content = (focused ? "─" : "━").repeat(mainWidth);
        sidebarFocusRail.content = (focused ? "━" : "─").repeat(width);
        mainFocusRail.fg = focused
            ? theme.inactive
            : theme.focus;
        sidebarFocusRail.fg = focused
            ? theme.focus
            : theme.inactive;
    }

    function apply(): void {
        const current = effectiveLayout();
        if (current === "main") focused = false;
        if (current !== "split") {
            dragging = false;
            divider.borderColor = theme.handle;
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
            marginTop: number > 1 ? 1 : 0,
        });
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
        headers: () => [mainHeader, header],
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
            // Keep the row mounted. OpenTUI can retain stale flex geometry when a child is repeatedly hidden and restored, which made the rail appear on first focus but not on later focus.
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
            divider.borderColor = dragging
                ? theme.handleActive
                : theme.handle;
            paintFocusRails();
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
        return MIN_SIDEBAR_WIDTH;
    }
    return Math.min(Math.max(Math.round(requested), MIN_SIDEBAR_WIDTH), room);
}
