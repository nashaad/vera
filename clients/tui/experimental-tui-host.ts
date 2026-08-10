import {
    BoxRenderable,
    TextAttributes,
    TextRenderable,
    type CliRenderer,
    type MouseEvent,
    type Renderable,
} from "@opentui/core";

import type { TuiTheme } from "./theme.ts";
import { tuiChord, type TuiChordKey } from "./keymap.ts";
import type {
    ClientExtensionExperimentalTuiAdapter,
} from "../../src/extensions/client-registry.ts";
import type {
    VeraExperimentalTuiContext,
    VeraExperimentalTuiAgentEvent,
    VeraExperimentalTuiEvents,
    VeraExperimentalTuiKey,
    VeraExperimentalTuiNode,
    VeraExperimentalTuiTone,
    VeraExperimentalTuiTheme,
    VeraExperimentalTuiViewSpec,
} from "../../src/sdk/experimental-tui.ts";
import type { VeraExtensionDisposer } from "../../src/sdk/extensions.ts";

const MAX_NODE_DEPTH = 20;
const MAX_NODE_CHILDREN = 100;
const MAX_TEXT_LENGTH = 8_000;

export interface TuiExperimentalHostOptions {
    readonly renderer: CliRenderer;
    readonly theme: TuiTheme;
    readonly workspace: () => string;
    readonly transcript: () => VeraExperimentalTuiContext["transcript"];
    readonly onFailure: (extensionId: string, message: string) => void;
    readonly onRenderRequested: () => void;
}

export interface TuiExperimentalHost {
    readonly adapter: ClientExtensionExperimentalTuiAdapter;
    readonly transcriptTop: BoxRenderable;
    readonly transcriptBottom: BoxRenderable;
    readonly footer: BoxRenderable;
    readonly composerAdornment: BoxRenderable;
    readonly overlay: BoxRenderable;
    render(): void;
    setTheme(theme: TuiTheme): void;
    conversationChanged(): void;
    agentEvent(event: VeraExperimentalTuiAgentEvent): void;
    hasModal(): boolean;
    hasFocus(): boolean;
    focus(): void;
    handleKey(key: TuiChordKey): boolean;
    close(): Promise<void>;
}

interface MountedView {
    readonly extensionId: string;
    readonly spec: VeraExperimentalTuiViewSpec;
    root?: BoxRenderable;
    lastRender?: string;
    focused: boolean;
}

interface EventListeners {
    readonly conversation_changed: Set<() => void>;
    readonly transcript_changed: Set<(
        transcript: VeraExperimentalTuiContext["transcript"],
    ) => void>;
    readonly agent_event: Set<(event: VeraExperimentalTuiAgentEvent) => void>;
}

export function createTuiExperimentalHost(
    options: TuiExperimentalHostOptions,
): TuiExperimentalHost {
    let theme = options.theme;
    let lastTranscript: VeraExperimentalTuiContext["transcript"] = [];
    let focusedView: MountedView | undefined;
    let closed = false;
    const views = new Map<string, MountedView>();
    const listeners: EventListeners = {
        conversation_changed: new Set(),
        transcript_changed: new Set(),
        agent_event: new Set(),
    };

    const transcriptTop = createSlot("transcript-top");
    const transcriptBottom = createSlot("transcript-bottom");
    const footer = createSlot("footer");
    const composerAdornment = createSlot("composer-adornment");
    const overlay = new BoxRenderable(options.renderer, {
        id: "experimental-tui-overlay",
        position: "absolute",
        left: 2,
        right: 2,
        top: 2,
        bottom: 2,
        flexDirection: "column",
        backgroundColor: theme.panel,
        zIndex: 30,
        visible: false,
    });

    const events: VeraExperimentalTuiEvents = {
        on(event, listener): VeraExtensionDisposer {
            if (closed) throw new Error("Experimental TUI host is closed");
            if (typeof listener !== "function") {
                throw new Error("Experimental TUI event listener must be a function");
            }
            const set = listeners[event] as Set<(...args: never[]) => void>;
            set.add(listener as (...args: never[]) => void);
            let active = true;
            return async () => {
                if (!active) return;
                active = false;
                set.delete(listener as (...args: never[]) => void);
            };
        },
    };

    const adapter: ClientExtensionExperimentalTuiAdapter = {
        mount(extensionId, spec): VeraExtensionDisposer {
            if (closed) throw new Error("Experimental TUI host is closed");
            const key = `${extensionId}:${spec.id}`;
            if (views.has(key)) {
                throw new Error(`Duplicate experimental TUI view: ${spec.id}`);
            }
            const view: MountedView = { extensionId, spec, focused: false };
            views.set(key, view);
            options.onRenderRequested();
            let active = true;
            return async () => {
                if (!active) return;
                active = false;
                if (focusedView === view) focusedView = undefined;
                removeView(view);
                views.delete(key);
                options.onRenderRequested();
            };
        },
        events,
    };

    function createSlot(id: string): BoxRenderable {
        return new BoxRenderable(options.renderer, {
            id: `experimental-tui-${id}`,
            width: "100%",
            flexDirection: "column",
            visible: false,
        });
    }

    function contextFor(view: MountedView): VeraExperimentalTuiContext {
        return {
            workspace: options.workspace(),
            focused: view === focusedView,
            theme: experimentalTheme(theme),
            transcript: lastTranscript,
        };
    }

    function visible(view: MountedView): boolean {
        if (view.spec.visible === undefined) return true;
        try {
            return view.spec.visible() === true;
        } catch (error) {
            reportFailure(view, error);
            return false;
        }
    }

    function reportFailure(view: MountedView, error: unknown): void {
        options.onFailure(
            view.extensionId,
            error instanceof Error ? error.message : String(error),
        );
    }

    function renderView(view: MountedView): void {
        const isVisible = visible(view);
        if (!isVisible) {
            removeView(view);
            return;
        }
        const context = contextFor(view);
        let node: VeraExperimentalTuiNode;
        try {
            node = view.spec.render(context);
            validateNode(node, 0);
        } catch (error) {
            reportFailure(view, error);
            removeView(view);
            return;
        }
        const signature = JSON.stringify({
            node,
            focused: context.focused,
            theme: context.theme,
        });
        if (view.root !== undefined && view.lastRender === signature) {
            return;
        }
        removeView(view);
        const root = new BoxRenderable(options.renderer, {
            id: `experimental-tui-view-${view.extensionId}-${view.spec.id}`,
            width: "100%",
            flexDirection: "column",
            paddingLeft: 1,
            paddingRight: 1,
            ...(view.spec.slot === "overlay"
                ? { flexGrow: 1 }
                : {}),
        });
        if (view.spec.title !== undefined) {
            root.add(new TextRenderable(options.renderer, {
                id: `${root.id}-title`,
                content: view.spec.title,
                fg: theme.accent,
                attributes: TextAttributes.BOLD,
                width: "100%",
                height: 1,
            }));
        }
        root.add(renderNode(
            options.renderer,
            node,
            view,
            `${root.id}-content`,
        ));
        view.root = root;
        view.lastRender = signature;
        slotFor(view.spec.slot).add(root);
    }

    function renderNode(
        renderer: CliRenderer,
        node: VeraExperimentalTuiNode,
        view: MountedView,
        id: string,
    ): Renderable {
        if (node.kind === "text") {
            return new TextRenderable(renderer, {
                id,
                content: node.text,
                fg: toneColor(node.tone),
                attributes: node.bold ? TextAttributes.BOLD : undefined,
                width: "100%",
                wrapMode: "word",
            });
        }
        if (node.kind === "rule") {
            return new TextRenderable(renderer, {
                id,
                content: "─".repeat(Math.max(1, Math.min(240, renderer.terminalWidth - 4))),
                fg: toneColor(node.tone ?? "muted"),
                width: "100%",
                height: 1,
            });
        }
        if (node.kind === "button") {
            const button = new BoxRenderable(renderer, {
                id,
                width: "100%",
                height: 1,
                paddingLeft: 1,
                paddingRight: 1,
                backgroundColor: node.selected ? theme.accent : theme.panel,
                visible: !node.disabled,
                onMouseDown: (event: MouseEvent) => {
                    event.preventDefault();
                    event.stopPropagation();
                    focusView(view);
                    void triggerAction(view, node.action);
                },
            });
            button.add(new TextRenderable(renderer, {
                id: `${id}-label`,
                content: node.label,
                fg: toneColor(node.tone ?? "text"),
                width: "100%",
                height: 1,
            }));
            return button;
        }
        const stack = new BoxRenderable(renderer, {
            id,
            width: "100%",
            flexDirection: node.direction,
            gap: node.gap ?? 0,
        });
        node.children.forEach((child, index) => {
            stack.add(renderNode(renderer, child, view, `${id}-${index}`));
        });
        return stack;
    }

    function slotFor(slot: VeraExperimentalTuiViewSpec["slot"]): BoxRenderable {
        switch (slot) {
            case "transcript-top": return transcriptTop;
            case "transcript-bottom": return transcriptBottom;
            case "footer": return footer;
            case "composer-adornment": return composerAdornment;
            case "overlay": return overlay;
        }
    }

    function removeView(view: MountedView): void {
        if (view.root === undefined) return;
        slotFor(view.spec.slot).remove(view.root.id);
        view.root.destroy();
        view.root = undefined;
        view.lastRender = undefined;
        if (focusedView === view) focusedView = undefined;
    }

    function toneColor(tone: VeraExperimentalTuiTone | undefined): string {
        switch (tone) {
            case "muted": return theme.muted;
            case "accent": return theme.accent;
            case "notice": return theme.notice;
            case "success": return theme.success;
            default: return theme.text;
        }
    }

    function focusView(view: MountedView): void {
        if (!view.spec.focusable && view.spec.slot !== "overlay") return;
        if (focusedView !== undefined) focusedView.focused = false;
        focusedView = view;
        view.focused = true;
        view.root?.focus();
        options.onRenderRequested();
    }

    function activeView(): MountedView | undefined {
        const modal = [...views.values()].find((view) =>
            view.spec.slot === "overlay" && visible(view)
        );
        return modal ?? focusedView;
    }

    function firstFocusableView(): MountedView | undefined {
        return [...views.values()].find((view) =>
            view.spec.focusable === true && visible(view)
        );
    }

    function triggerAction(view: MountedView, action: string): Promise<void> {
        if (view.spec.onAction === undefined) return Promise.resolve();
        try {
            return Promise.resolve(view.spec.onAction(action, contextFor(view)))
                .catch((error) => reportFailure(view, error))
                .then(() => options.onRenderRequested());
        } catch (error) {
            reportFailure(view, error);
            return Promise.resolve();
        }
    }

    function fireTranscriptChanged(
        transcript: VeraExperimentalTuiContext["transcript"],
    ): void {
        const signature = JSON.stringify(transcript);
        if (signature === JSON.stringify(lastTranscript)) return;
        lastTranscript = transcript;
        for (const listener of listeners.transcript_changed) {
            try {
                listener(transcript);
            } catch (error) {
                options.onFailure("experimental-tui-listener", String(error));
            }
        }
    }

    function fireConversationChanged(): void {
        for (const listener of listeners.conversation_changed) {
            try {
                listener();
            } catch (error) {
                options.onFailure("experimental-tui-listener", String(error));
            }
        }
    }

    function fireAgentEvent(event: VeraExperimentalTuiAgentEvent): void {
        for (const listener of listeners.agent_event) {
            try {
                listener(event);
            } catch (error) {
                options.onFailure("experimental-tui-listener", String(error));
            }
        }
    }

    function render(): void {
        if (closed) return;
        fireTranscriptChanged(options.transcript());
        for (const view of views.values()) {
            renderView(view);
        }
        transcriptTop.visible = transcriptTop.getChildren().length > 0;
        transcriptBottom.visible = transcriptBottom.getChildren().length > 0;
        footer.visible = footer.getChildren().length > 0;
        composerAdornment.visible = composerAdornment.getChildren().length > 0;
        overlay.visible = [...views.values()].some((view) =>
            view.spec.slot === "overlay" && view.root !== undefined && visible(view)
        );
    }

    return {
        adapter,
        transcriptTop,
        transcriptBottom,
        footer,
        composerAdornment,
        overlay,
        render,
        setTheme(nextTheme): void {
            theme = nextTheme;
            for (const view of views.values()) view.lastRender = undefined;
        },
        conversationChanged: fireConversationChanged,
        agentEvent: fireAgentEvent,
        hasModal: () => [...views.values()].some((view) =>
            view.spec.slot === "overlay" && visible(view)
        ),
        hasFocus: () => focusedView !== undefined,
        focus(): void {
            const view = activeView() ?? firstFocusableView();
            if (view !== undefined) focusView(view);
        },
        handleKey(key): boolean {
            const view = activeView();
            if (view === undefined) return false;
            if (!visible(view)) return false;
            const chord = tuiChord(key);
            const binding = chord === undefined
                ? undefined
                : view.spec.keybindings?.find((candidate) =>
                    candidate.keys.includes(chord)
                );
            if (binding !== undefined) {
                void triggerAction(view, binding.action);
                return true;
            }
            if (view.spec.onKey !== undefined) {
                const event: VeraExperimentalTuiKey = {
                    chord: chord ?? key.name,
                    name: key.name,
                    ctrl: key.ctrl === true,
                    shift: key.shift === true,
                    meta: key.meta === true,
                };
                try {
                    void Promise.resolve(view.spec.onKey(event, contextFor(view)))
                        .then(() => options.onRenderRequested())
                        .catch((error) => reportFailure(view, error));
                } catch (error) {
                    reportFailure(view, error);
                }
                return true;
            }
            return view.spec.slot === "overlay" && view.spec.modal === true;
        },
        async close(): Promise<void> {
            if (closed) return;
            closed = true;
            for (const view of [...views.values()]) removeView(view);
            views.clear();
            for (const set of Object.values(listeners)) set.clear();
            for (const slot of [
                transcriptTop,
                transcriptBottom,
                footer,
                composerAdornment,
                overlay,
            ]) {
                slot.destroy();
            }
        },
    };
}

function experimentalTheme(theme: TuiTheme): VeraExperimentalTuiTheme {
    return {
        text: theme.text,
        muted: theme.muted,
        accent: theme.accent,
        notice: theme.notice,
        success: theme.success,
        panel: theme.panel,
    };
}

function validateNode(node: VeraExperimentalTuiNode, depth: number): void {
    if (depth > MAX_NODE_DEPTH || typeof node !== "object" || node === null) {
        throw new Error("Experimental TUI view returned an invalid node tree");
    }
    if (node.kind === "text") {
        if (typeof node.text !== "string" || node.text.length > MAX_TEXT_LENGTH) {
            throw new Error("Experimental TUI text is invalid or too long");
        }
        return;
    }
    if (node.kind === "rule") return;
    if (node.kind === "button") {
        if (
            typeof node.label !== "string"
            || node.label.length === 0
            || node.label.length > 240
            || typeof node.action !== "string"
            || node.action.length === 0
        ) {
            throw new Error("Experimental TUI button is invalid");
        }
        return;
    }
    if (
        node.kind !== "stack"
        || !Array.isArray(node.children)
        || node.children.length > MAX_NODE_CHILDREN
        || (node.gap !== undefined
            && (!Number.isInteger(node.gap) || node.gap < 0 || node.gap > 8))
    ) {
        throw new Error("Experimental TUI stack is invalid");
    }
    for (const child of node.children) validateNode(child, depth + 1);
}
