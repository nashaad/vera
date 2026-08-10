import {
    BoxRenderable,
    type CliRenderer,
    type Renderable,
} from "@opentui/core";

import type { TuiTheme } from "./theme.ts";
import {
    renderTuiExperimentalView,
    validateTuiExperimentalNode,
} from "./experimental-tui-renderer.ts";
import {
    refreshTuiExperimentalSlotVisibility,
    tuiExperimentalBottomInsetRows,
} from "./experimental-tui-layout.ts";
import {
    createTuiExperimentalRawView,
    disposeTuiExperimentalRawView,
    type TuiExperimentalRawView,
} from "./experimental-tui-raw-view.ts";
import { tuiChord, type TuiChordKey } from "./keymap.ts";
import type {
    ClientExtensionExperimentalTuiAdapter,
} from "../../src/extensions/client-registry.ts";
import type {
    VeraExperimentalTuiContext,
    VeraExperimentalTuiAgentEvent,
    VeraExperimentalTuiKey,
    VeraExperimentalTuiNode,
    VeraExperimentalTuiTheme,
    VeraExperimentalTuiViewSpec,
    VeraExperimentalTuiRawViewSpec,
} from "../../src/sdk/experimental-tui.ts";
import type { VeraExtensionDisposer } from "../../src/sdk/extensions.ts";

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
    bottomInsetRows(): number;
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

interface ExperimentalTuiListener {
    readonly extensionId: string;
    readonly listener: (...args: any[]) => void | Promise<void>;
}

interface EventListeners {
    readonly conversation_changed: Set<ExperimentalTuiListener>;
    readonly transcript_changed: Set<ExperimentalTuiListener>;
    readonly agent_event: Set<ExperimentalTuiListener>;
}

export function createTuiExperimentalHost(
    options: TuiExperimentalHostOptions,
): TuiExperimentalHost {
    let theme = options.theme;
    let lastTranscript: VeraExperimentalTuiContext["transcript"] = [];
    let focusedView: MountedView | undefined;
    let closed = false;
    const views = new Map<string, MountedView>();
    const rawViews = new Map<string, TuiExperimentalRawView>();
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

    const events: ClientExtensionExperimentalTuiAdapter["events"] = {
        on(extensionId, event, listener): VeraExtensionDisposer {
            if (closed) throw new Error("Experimental TUI host is closed");
            if (typeof listener !== "function") {
                throw new Error("Experimental TUI event listener must be a function");
            }
            const set = listeners[event];
            const registered = { extensionId, listener };
            set.add(registered);
            let active = true;
            return async () => {
                if (!active) return;
                active = false;
                set.delete(registered);
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
        mountRenderable(extensionId, spec): VeraExtensionDisposer {
            if (closed) throw new Error("Experimental TUI host is closed");
            const key = `${extensionId}:${spec.id}`;
            if (rawViews.has(key) || views.has(key)) {
                throw new Error(`Duplicate experimental TUI view: ${spec.id}`);
            }
            const view = createTuiExperimentalRawView({
                renderer: options.renderer,
                extensionId,
                spec,
                workspace: options.workspace(),
                theme: experimentalTheme(theme),
                transcript: options.transcript(),
                requestRender: options.onRenderRequested,
            });
            rawViews.set(key, view);
            slotFor(spec.slot).add(view.container);
            options.onRenderRequested();
            let active = true;
            return async () => {
                if (!active) return;
                active = false;
                disposeTuiExperimentalRawView(
                    view,
                    (containerId) => slotFor(spec.slot).remove(containerId),
                );
                rawViews.delete(key);
                options.onRenderRequested();
            };
        },
        events,
        agentSurface: {
            current: () => undefined,
            cycleLayout: () => false,
            toggleFocus: () => false,
        },
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
            validateTuiExperimentalNode(node);
        } catch (error) {
            reportFailure(view, error);
            removeView(view);
            return;
        }
        let signature: string | undefined;
        try {
            signature = JSON.stringify({
                node,
                focused: context.focused,
                theme: context.theme,
            });
        } catch (error) {
            reportFailure(view, error);
            removeView(view);
            return;
        }
        if (signature === undefined) {
            reportFailure(view, "Experimental TUI view has no render signature");
            removeView(view);
            return;
        }
        if (view.root !== undefined && view.lastRender === signature) {
            return;
        }
        removeView(view);
        const root = renderTuiExperimentalView({
            renderer: options.renderer,
            theme,
            node,
            id: `experimental-tui-view-${view.extensionId}-${view.spec.id}`,
            overlay: view.spec.slot === "overlay",
            title: view.spec.title,
            focus: () => focusView(view),
            triggerAction: (action) => triggerAction(view, action),
        });
        view.root = root;
        view.lastRender = signature;
        slotFor(view.spec.slot).add(root);
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
            view.spec.slot === "overlay"
            && view.spec.modal === true
            && visible(view)
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
        for (const registered of listeners.transcript_changed) {
            fireListener(registered, transcript);
        }
    }

    function fireConversationChanged(): void {
        for (const registered of listeners.conversation_changed) {
            fireListener(registered);
        }
    }

    function fireAgentEvent(event: VeraExperimentalTuiAgentEvent): void {
        for (const registered of listeners.agent_event) {
            fireListener(registered, event);
        }
    }

    function fireListener(
        registered: ExperimentalTuiListener,
        ...args: any[]
    ): void {
        try {
            void Promise.resolve(registered.listener(...args)).catch((error) => {
                options.onFailure(
                    registered.extensionId,
                    error instanceof Error ? error.message : String(error),
                );
            });
        } catch (error) {
            options.onFailure(
                registered.extensionId,
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    function render(): void {
        if (closed) return;
        fireTranscriptChanged(options.transcript());
        for (const view of views.values()) {
            renderView(view);
        }
        for (const view of rawViews.values()) {
            try {
                view.container.visible = view.spec.visible?.() ?? true;
            } catch (error) {
                options.onFailure(
                    view.extensionId,
                    error instanceof Error ? error.message : String(error),
                );
                view.container.visible = false;
            }
        }
        refreshTuiExperimentalSlotVisibility({
            transcriptTop,
            transcriptBottom,
            footer,
            composerAdornment,
            overlay,
        }, [...views.values()].some((view) =>
            view.spec.slot === "overlay" && view.root !== undefined && visible(view)
        ));
    }

    return {
        adapter,
        transcriptTop,
        transcriptBottom,
        footer,
        composerAdornment,
        overlay,
        bottomInsetRows: () => tuiExperimentalBottomInsetRows(
            footer,
            composerAdornment,
        ),
        render,
        setTheme(nextTheme): void {
            theme = nextTheme;
            for (const view of views.values()) view.lastRender = undefined;
        },
        conversationChanged: fireConversationChanged,
        agentEvent: fireAgentEvent,
        hasModal: () => [...views.values()].some((view) =>
            view.spec.slot === "overlay"
            && view.spec.modal === true
            && visible(view)
        ) || [...rawViews.values()].some((view) =>
            view.spec.slot === "overlay"
            && view.spec.modal === true
            && view.container.visible
        ),
        hasFocus: () => focusedView !== undefined,
        focus(): void {
            const rawModal = [...rawViews.values()].find((view) =>
                view.spec.slot === "overlay"
                && view.spec.modal === true
                && view.container.visible
            );
            if (rawModal !== undefined) {
                rawModal.root.focus();
                return;
            }
            const view = activeView() ?? firstFocusableView();
            if (view !== undefined) focusView(view);
        },
        handleKey(key): boolean {
            const rawModal = [...rawViews.values()].find((view) =>
                view.spec.slot === "overlay"
                && view.spec.modal === true
                && view.container.visible
            );
            if (rawModal !== undefined) {
                if (rawModal.spec.onKey === undefined) return true;
                const event: VeraExperimentalTuiKey = {
                    chord: tuiChord(key) ?? key.name,
                    name: key.name,
                    ctrl: key.ctrl === true,
                    shift: key.shift === true,
                    meta: key.meta === true,
                };
                try {
                    const handled = rawModal.spec.onKey(event);
                    if (handled instanceof Promise) {
                        void handled
                            .then(() => options.onRenderRequested())
                            .catch((error) => options.onFailure(
                                rawModal.extensionId,
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                            ));
                        return true;
                    }
                    options.onRenderRequested();
                    return handled !== false;
                } catch (error) {
                    options.onFailure(
                        rawModal.extensionId,
                        error instanceof Error ? error.message : String(error),
                    );
                    return true;
                }
            }
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
                    const handled = view.spec.onKey(event, contextFor(view));
                    if (handled instanceof Promise) {
                        void handled
                            .then(() => options.onRenderRequested())
                            .catch((error) => reportFailure(view, error));
                        return true;
                    }
                    options.onRenderRequested();
                    return handled !== false;
                } catch (error) {
                    reportFailure(view, error);
                    return false;
                }
            }
            return view.spec.slot === "overlay" && view.spec.modal === true;
        },
        async close(): Promise<void> {
            if (closed) return;
            closed = true;
            for (const view of [...views.values()]) removeView(view);
            views.clear();
            for (const view of rawViews.values()) {
                disposeTuiExperimentalRawView(
                    view,
                    (containerId) => slotFor(view.spec.slot).remove(containerId),
                );
            }
            rawViews.clear();
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
