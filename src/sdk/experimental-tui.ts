import type { VeraExtensionDisposer } from "./extensions.ts";
import type { CliRenderer, Renderable } from "@opentui/core";

/** Slots supported by the experimental TUI host. They are client-local. */
export type VeraExperimentalTuiSlot =
    | "transcript-top"
    | "transcript-bottom"
    | "footer"
    | "composer-adornment"
    | "overlay";

export type VeraExperimentalTuiTone =
    | "text"
    | "muted"
    | "accent"
    | "notice"
    | "success";

/** A small declarative tree; no OpenTUI object crosses the extension boundary. */
export type VeraExperimentalTuiNode =
    | {
        readonly kind: "text";
        readonly text: string;
        readonly tone?: VeraExperimentalTuiTone;
        readonly bold?: boolean;
    }
    | {
        readonly kind: "stack";
        readonly direction: "row" | "column";
        readonly children: readonly VeraExperimentalTuiNode[];
        readonly gap?: number;
    }
    | {
        readonly kind: "rule";
        readonly tone?: VeraExperimentalTuiTone;
    }
    | {
        readonly kind: "button";
        readonly label: string;
        readonly action: string;
        readonly tone?: VeraExperimentalTuiTone;
        readonly selected?: boolean;
        readonly disabled?: boolean;
    };

export interface VeraExperimentalTuiTheme {
    readonly text: string;
    readonly muted: string;
    readonly accent: string;
    readonly notice: string;
    readonly success: string;
    readonly panel: string;
}

export interface VeraExperimentalTuiContext {
    readonly workspace: string;
    readonly focused: boolean;
    readonly theme: VeraExperimentalTuiTheme;
    readonly transcript: readonly {
        readonly role: "user" | "assistant";
        readonly text: string;
    }[];
}

export interface VeraExperimentalTuiKey {
    readonly chord: string;
    readonly name: string;
    readonly ctrl: boolean;
    readonly shift: boolean;
    readonly meta: boolean;
}

export interface VeraExperimentalTuiKeybinding {
    readonly keys: readonly string[];
    readonly action: string;
}

/** Sanitized client event data; engine/provider objects never cross here. */
export interface VeraExperimentalTuiAgentEvent {
    readonly type:
        | "user_prompt"
        | "assistant_delta"
        | "assistant_thinking"
        | "tool_started"
        | "tool_finished"
        | "tool_presentation"
        | "turn_finished"
        | "status"
        | "agent_failed";
    readonly text?: string;
    readonly tool?: string;
    readonly output?: string;
    readonly isError?: boolean;
    readonly state?: "working" | "waiting" | "idle";
}

export interface VeraExperimentalTuiViewSpec {
    /** Unique within the extension; this is not a global TUI identifier. */
    readonly id: string;
    readonly slot: VeraExperimentalTuiSlot;
    readonly title?: string;
    /** Overlay views block the native TUI until dismissed. */
    readonly modal?: boolean;
    /** A view may claim scoped keyboard focus when the host focuses it. */
    readonly focusable?: boolean;
    readonly visible?: () => boolean;
    readonly render: (
        context: VeraExperimentalTuiContext,
    ) => VeraExperimentalTuiNode;
    readonly keybindings?: readonly VeraExperimentalTuiKeybinding[];
    readonly onKey?: (
        key: VeraExperimentalTuiKey,
        context: VeraExperimentalTuiContext,
    ) => boolean | void;
    readonly onAction?: (
        action: string,
        context: VeraExperimentalTuiContext,
    ) => void | Promise<void>;
}

/**
 * Trusted, TUI-only access for extensions that need real OpenTUI components.
 * None of these objects cross Vera's runtime/client protocol boundary.
 */
export interface VeraExperimentalTuiRawContext {
    readonly renderer: CliRenderer;
    readonly workspace: string;
    readonly theme: VeraExperimentalTuiTheme;
    readonly transcript: VeraExperimentalTuiContext["transcript"];
    requestRender(): void;
}

export interface VeraExperimentalTuiRawViewSpec {
    readonly id: string;
    readonly slot: VeraExperimentalTuiSlot;
    readonly modal?: boolean;
    readonly visible?: () => boolean;
    create(context: VeraExperimentalTuiRawContext): Renderable;
    onKey?: (
        key: VeraExperimentalTuiKey,
    ) => boolean | void;
}

/** A raw view inserted once at the current transcript position. */
export interface VeraExperimentalTuiTranscriptRenderableSpec {
    readonly id: string;
    create(context: VeraExperimentalTuiRawContext): Renderable;
    onResize?(width: number): void;
}

export interface VeraExperimentalTuiEvents {
    on(
        event: "conversation_changed",
        listener: () => void | Promise<void>,
    ): VeraExtensionDisposer;
    on(
        event: "transcript_changed",
        listener: (
            transcript: VeraExperimentalTuiContext["transcript"],
        ) => void | Promise<void>,
    ): VeraExtensionDisposer;
    on(
        event: "agent_event",
        listener: (
            event: VeraExperimentalTuiAgentEvent,
        ) => void | Promise<void>,
    ): VeraExtensionDisposer;
}

export type VeraExperimentalTuiAgentLayout =
    | "split"
    | "secondary"
    | "primary";

export type VeraExperimentalTuiAgentFocus = "primary" | "secondary";

export interface VeraExperimentalTuiAgentSurfaceSnapshot {
    readonly layout: VeraExperimentalTuiAgentLayout;
    readonly focused: VeraExperimentalTuiAgentFocus;
}

/** Controls only the hosted-agent surface owned by this extension. */
export interface VeraExperimentalTuiAgentSurface {
    current(): VeraExperimentalTuiAgentSurfaceSnapshot | undefined;
    cycleLayout(): boolean;
    toggleFocus(): boolean;
}

/**
 * Deliberately experimental and TUI-only. The semantic mounts are bounded;
 * mountRenderable is the trusted in-process escape hatch for client UI.
 */
export interface VeraClientExperimentalTui {
    mount(spec: VeraExperimentalTuiViewSpec): VeraExtensionDisposer;
    mountRenderable(
        spec: VeraExperimentalTuiRawViewSpec,
    ): VeraExtensionDisposer;
    appendTranscriptRenderable(
        spec: VeraExperimentalTuiTranscriptRenderableSpec,
    ): VeraExtensionDisposer;
    readonly events: VeraExperimentalTuiEvents;
    readonly agentSurface: VeraExperimentalTuiAgentSurface;
}
