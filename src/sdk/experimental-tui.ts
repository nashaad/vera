import type { VeraExtensionDisposer } from "./extensions.ts";

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
    ) => boolean | void | Promise<boolean | void>;
    readonly onAction?: (
        action: string,
        context: VeraExperimentalTuiContext,
    ) => void | Promise<void>;
}

export interface VeraExperimentalTuiEvents {
    on(
        event: "conversation_changed",
        listener: () => void,
    ): VeraExtensionDisposer;
    on(
        event: "transcript_changed",
        listener: (
            transcript: VeraExperimentalTuiContext["transcript"],
        ) => void,
    ): VeraExtensionDisposer;
    on(
        event: "agent_event",
        listener: (event: VeraExperimentalTuiAgentEvent) => void,
    ): VeraExtensionDisposer;
}

/**
 * Deliberately experimental and TUI-only. It is a narrow in-process host,
 * not a portable client contract and not a runtime or renderable escape hatch.
 */
export interface VeraClientExperimentalTui {
    mount(spec: VeraExperimentalTuiViewSpec): VeraExtensionDisposer;
    readonly events: VeraExperimentalTuiEvents;
}
