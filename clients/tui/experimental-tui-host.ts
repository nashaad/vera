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
    refreshTuiExperimentalRawView,
    type TuiExperimentalRawView,
} from "./experimental-tui-raw-view.ts";
import {
    createTuiExperimentalEventBus,
    type TuiExperimentalEventBus,
} from "./experimental-tui-events.ts";
import {
    isTuiExperimentalViewVisible,
    tuiExperimentalViewSignature,
} from "./experimental-tui-view-state.ts";
import { createTuiExperimentalSlotRegistry } from "./experimental-tui-slots.ts";
import {
    findTuiExperimentalFocusable,
    findTuiExperimentalModal,
    hasTuiExperimentalModal,
} from "./experimental-tui-focus.ts";
import { type TuiChordKey } from "./keymap.ts";
import {
    findTuiExperimentalKeybinding,
    tuiExperimentalKeyEvent,
} from "./experimental-tui-input.ts";
import { invokeTuiExperimentalAction } from "./experimental-tui-actions.ts";
import { settleTuiExperimentalKeyResult } from "./experimental-tui-key-results.ts";
import type {
    ClientExtensionExperimentalTuiAdapter,
} from "../../src/extensions/client-registry.ts";
import type {
    VeraExperimentalTuiContext,
    VeraExperimentalTuiAgentEvent,
    VeraExperimentalTuiNode,
    VeraExperimentalTuiTheme,
    VeraExperimentalTuiViewSpec,
    VeraExperimentalTuiRawViewSpec,
    VeraExperimentalTuiTranscriptRenderableSpec,
    VeraExperimentalTuiDocument,
} from "../../src/sdk/experimental-tui.ts";
import type { VeraExtensionDisposer } from "../../src/sdk/extensions.ts";

export interface TuiExperimentalHostOptions {
    readonly renderer: CliRenderer;
    readonly theme: TuiTheme;
    readonly workspace: () => string;
    readonly transcript: () => VeraExperimentalTuiContext["transcript"];
    readonly onFailure: (extensionId: string, message: string) => void;
    readonly onRenderRequested: () => void;
    readonly appendTranscriptRenderable?: (
        node: Renderable,
    ) => VeraExtensionDisposer;
    readonly openDocument?: (document: VeraExperimentalTuiDocument) => void;
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
    clearTranscriptRenderables(): void;
    agentEvent(event: VeraExperimentalTuiAgentEvent): void;
    hasModal(): boolean;
    showNotice(message: string): boolean;
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

interface TranscriptRenderable {
    readonly extensionId: string;
    readonly spec: VeraExperimentalTuiTranscriptRenderableSpec;
    readonly root: Renderable;
    readonly remove: VeraExtensionDisposer;
    active: boolean;
    lastWidth: number;
}

const NOTICE_DURATION_MS = 2_000;

export function createTuiExperimentalHost(
    options: TuiExperimentalHostOptions,
): TuiExperimentalHost {
    let theme = options.theme;
    let focusedView: MountedView | undefined;
    let notice: string | undefined;
    let noticeVersion = 0;
    let closed = false;
    const views = new Map<string, MountedView>();
    const rawViews = new Map<string, TuiExperimentalRawView>();
    const transcriptRenderables = new Set<TranscriptRenderable>();

    const slotRegistry = createTuiExperimentalSlotRegistry({
        renderer: options.renderer,
        theme,
    });
    const {
        transcriptTop,
        transcriptBottom,
        footer,
        composerAdornment,
        overlay,
    } = slotRegistry;
    const eventBus: TuiExperimentalEventBus = createTuiExperimentalEventBus(
        options.onFailure,
        options.onRenderRequested,
    );

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
            (spec.fullscreen === true ? options.renderer.root : slotRegistry.slotFor(spec.slot)).add(view.container);
            options.onRenderRequested();
            let active = true;
            return async () => {
                if (!active) return;
                active = false;
                try {
                    disposeTuiExperimentalRawView(
                        view,
                        (containerId) => (spec.fullscreen === true ? options.renderer.root : slotRegistry.slotFor(spec.slot)).remove(containerId),
                    );
                } finally {
                    rawViews.delete(key);
                    options.onRenderRequested();
                }
            };
        },
        appendTranscriptRenderable(
            extensionId,
            spec,
        ): VeraExtensionDisposer {
            if (closed) throw new Error("Experimental TUI host is closed");
            if ([...transcriptRenderables].some((entry) =>
                entry.extensionId === extensionId && entry.spec.id === spec.id
            )) {
                throw new Error(`Duplicate experimental TUI view: ${spec.id}`);
            }
            const root = spec.create({
                renderer: options.renderer,
                workspace: options.workspace(),
                theme: experimentalTheme(theme),
                transcript: options.transcript(),
                requestRender: options.onRenderRequested,
            });
            if (
                typeof root !== "object"
                || root === null
                || typeof root.destroy !== "function"
                || typeof root.destroyRecursively !== "function"
            ) {
                throw new Error(
                    "Transcript experimental TUI view must return a Renderable",
                );
            }
            let remove: VeraExtensionDisposer = async () => {};
            try {
                if (options.appendTranscriptRenderable === undefined) {
                    throw new Error(
                        "Native transcript renderables are unavailable on this host",
                    );
                }
                remove = options.appendTranscriptRenderable(root);
            } catch (error) {
                root.destroyRecursively();
                throw error;
            }
            const entry: TranscriptRenderable = {
                extensionId,
                spec,
                root,
                remove,
                active: true,
                lastWidth: options.renderer.terminalWidth,
            };
            transcriptRenderables.add(entry);
            options.onRenderRequested();
            return async () => {
                if (!entry.active) return;
                entry.active = false;
                transcriptRenderables.delete(entry);
                try {
                    await remove();
                } finally {
                    root.destroyRecursively();
                    options.onRenderRequested();
                }
            };
        },
        openDocument(_extensionId, document): void {
            if (closed) throw new Error("Experimental TUI host is closed");
            if (options.openDocument === undefined) {
                throw new Error("This client cannot open markdown reports");
            }
            options.openDocument(document);
        },
        events: eventBus.events,
        agentSurface: {
            current: () => undefined,
            cycleLayout: () => false,
            toggleFocus: () => false,
        },
    };

    function contextFor(view: MountedView): VeraExperimentalTuiContext {
        return {
            workspace: options.workspace(),
            width: options.renderer.width,
            height: options.renderer.height,
            focused: view === focusedView,
            theme: experimentalTheme(theme),
            transcript: eventBus.currentTranscript(),
            requestRender: options.onRenderRequested,
        };
    }

    function visible(view: MountedView): boolean {
        return isTuiExperimentalViewVisible({
            extensionId: view.extensionId,
            visible: view.spec.visible,
            onFailure: options.onFailure,
        });
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
            signature = tuiExperimentalViewSignature(
                node,
                context.focused,
                context.theme,
            );
            if (signature !== undefined && notice !== undefined) {
                signature = `${signature}\u0000${notice}`;
            }
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
            ...(notice === undefined || view.spec.slot !== "overlay"
                ? {}
                : { notice }),
            focus: () => focusView(view),
            triggerAction: (action) => triggerAction(view, action),
        });
        view.root = root;
        view.lastRender = signature;
        slotRegistry.slotFor(view.spec.slot).add(root);
    }

    function removeView(view: MountedView): void {
        if (view.root === undefined) return;
        slotRegistry.slotFor(view.spec.slot).remove(view.root.id);
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
        const modal = findTuiExperimentalModal(
            views.values(),
            (view) => view.spec,
            visible,
        );
        return modal ?? focusedView;
    }

    function firstFocusableView(): MountedView | undefined {
        return findTuiExperimentalFocusable(
            views.values(),
            (view) => view.spec,
            visible,
        );
    }

    function triggerAction(view: MountedView, action: string): Promise<void> {
        return invokeTuiExperimentalAction({
            action,
            context: contextFor(view),
            onAction: view.spec.onAction,
            onFailure: (error) => reportFailure(view, error),
            onRenderRequested: options.onRenderRequested,
        });
    }

    function render(): void {
        if (closed) return;
        eventBus.transcriptChanged(options.transcript());
        for (const view of views.values()) {
            renderView(view);
        }
        for (const view of rawViews.values()) {
            refreshTuiExperimentalRawView(view, options.onFailure);
        }
        for (const entry of transcriptRenderables) {
            if (entry.lastWidth === options.renderer.terminalWidth) continue;
            entry.lastWidth = options.renderer.terminalWidth;
            try {
                entry.spec.onResize?.(options.renderer.terminalWidth);
            } catch (error) {
                options.onFailure(
                    entry.extensionId,
                    error instanceof Error ? error.message : String(error),
                );
            }
        }
        refreshTuiExperimentalSlotVisibility({
            transcriptTop,
            transcriptBottom,
            footer,
            composerAdornment,
            overlay,
        });
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
        conversationChanged(): void {
            void clearTranscriptRenderables();
            eventBus.conversationChanged();
        },
        clearTranscriptRenderables(): void {
            void clearTranscriptRenderables();
        },
        agentEvent: eventBus.agentEvent,
        hasModal: () => hasTuiExperimentalModal(
            views.values(),
            (view) => view.spec,
            visible,
        ) || hasTuiExperimentalModal(
            rawViews.values(),
            (view) => view.spec,
            (view) => view.container.visible,
        ),
        showNotice(message): boolean {
            const overlayView = [...views.values()].find((view) =>
                view.spec.slot === "overlay" && visible(view)
            );
            if (overlayView === undefined) return false;
            notice = message;
            noticeVersion += 1;
            const version = noticeVersion;
            render();
            options.onRenderRequested();
            setTimeout(() => {
                if (noticeVersion !== version) return;
                notice = undefined;
                render();
                options.onRenderRequested();
            }, NOTICE_DURATION_MS);
            return true;
        },
        hasFocus: () => focusedView !== undefined,
        focus(): void {
            const rawModal = findTuiExperimentalModal(
                rawViews.values(),
                (view) => view.spec,
                (view) => view.container.visible,
            );
            if (rawModal !== undefined) {
                rawModal.root.focus();
                return;
            }
            const view = activeView() ?? firstFocusableView();
            if (view !== undefined) focusView(view);
        },
        handleKey(key): boolean {
            const rawModal = findTuiExperimentalModal(
                rawViews.values(),
                (view) => view.spec,
                (view) => view.container.visible,
            );
            if (rawModal !== undefined) {
                if (rawModal.spec.onKey === undefined) return true;
                const event = tuiExperimentalKeyEvent(key);
                try {
                    const handled = rawModal.spec.onKey(event);
                    return settleTuiExperimentalKeyResult(handled, {
                        onRenderRequested: options.onRenderRequested,
                        onFailure: (error) => options.onFailure(
                            rawModal.extensionId,
                            error instanceof Error ? error.message : String(error),
                        ),
                    });
                } catch (error) {
                    options.onFailure(
                        rawModal.extensionId,
                        error instanceof Error ? error.message : String(error),
                    );
                    options.onRenderRequested();
                    return true;
                }
            }
            const view = activeView();
            if (view === undefined) return false;
            if (!visible(view)) return false;
            const binding = findTuiExperimentalKeybinding(
                key,
                view.spec.keybindings,
            );
            if (binding !== undefined) {
                void triggerAction(view, binding.action);
                return true;
            }
            if (view.spec.onKey !== undefined) {
                const event = tuiExperimentalKeyEvent(key);
                try {
                    const handled = view.spec.onKey(event, contextFor(view));
                    return settleTuiExperimentalKeyResult(handled, {
                        onRenderRequested: options.onRenderRequested,
                        onFailure: (error) => reportFailure(view, error),
                    });
                } catch (error) {
                    reportFailure(view, error);
                    options.onRenderRequested();
                    return false;
                }
            }
            return view.spec.slot === "overlay" && view.spec.modal === true;
        },
        async close(): Promise<void> {
            if (closed) return;
            closed = true;
            await clearTranscriptRenderables();
            for (const view of [...views.values()]) removeView(view);
            views.clear();
            for (const view of rawViews.values()) {
                try {
                    disposeTuiExperimentalRawView(
                        view,
                        (containerId) => (view.spec.fullscreen === true ? options.renderer.root : slotRegistry.slotFor(view.spec.slot)).remove(containerId),
                    );
                } catch (error) {
                    options.onFailure(
                        view.extensionId,
                        error instanceof Error ? error.message : String(error),
                    );
                }
            }
            rawViews.clear();
            eventBus.clear();
            try {
                slotRegistry.destroy();
            } catch (error) {
                options.onFailure(
                    "experimental-tui-host",
                    error instanceof Error ? error.message : String(error),
                );
            }
        },
    };

    async function clearTranscriptRenderables(): Promise<void> {
        const current = [...transcriptRenderables];
        transcriptRenderables.clear();
        for (const entry of current) {
            if (!entry.active) continue;
            entry.active = false;
            try {
                await entry.remove();
            } catch (error) {
                options.onFailure(
                    entry.extensionId,
                    error instanceof Error ? error.message : String(error),
                );
            }
            try {
                entry.root.destroyRecursively();
            } catch (error) {
                options.onFailure(
                    entry.extensionId,
                    error instanceof Error ? error.message : String(error),
                );
            }
        }
        if (current.length > 0) options.onRenderRequested();
    }
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
