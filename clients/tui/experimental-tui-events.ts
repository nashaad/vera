import type {
    VeraExperimentalTuiAgentEvent,
    VeraExperimentalTuiContext,
    VeraExperimentalTuiKey,
} from "../../src/sdk/experimental-tui.ts";
import type { VeraExtensionDisposer } from "../../src/sdk/extensions.ts";

export type TuiExperimentalEventName =
    | "conversation_changed"
    | "transcript_changed"
    | "agent_event";

export interface TuiExperimentalEventListener {
    readonly extensionId: string;
    readonly listener: (...args: any[]) => void | Promise<void>;
}

export interface TuiExperimentalEventAdapter {
    on(
        extensionId: string,
        event: TuiExperimentalEventName,
        listener: (...args: any[]) => void | Promise<void>,
    ): VeraExtensionDisposer;
}

export interface TuiExperimentalEventBus {
    readonly events: TuiExperimentalEventAdapter;
    currentTranscript(): VeraExperimentalTuiContext["transcript"];
    transcriptChanged(
        transcript: VeraExperimentalTuiContext["transcript"],
    ): void;
    conversationChanged(): void;
    agentEvent(event: VeraExperimentalTuiAgentEvent): void;
    clear(): void;
}

interface EventListeners {
    readonly conversation_changed: Set<TuiExperimentalEventListener>;
    readonly transcript_changed: Set<TuiExperimentalEventListener>;
    readonly agent_event: Set<TuiExperimentalEventListener>;
}

export function createTuiExperimentalEventBus(
    onFailure: (extensionId: string, message: string) => void,
    requestRender: (updateType: string) => void,
): TuiExperimentalEventBus {
    let lastTranscript: VeraExperimentalTuiContext["transcript"] = [];
    let closed = false;
    const listeners: EventListeners = {
        conversation_changed: new Set(),
        transcript_changed: new Set(),
        agent_event: new Set(),
    };
    const events: TuiExperimentalEventAdapter = {
        on(extensionId, event, listener): VeraExtensionDisposer {
            if (closed) throw new Error("Experimental TUI host is closed");
            if (typeof listener !== "function") {
                throw new Error("Experimental TUI event listener must be a function");
            }
            const registered = { extensionId, listener };
            listeners[event].add(registered);
            let active = true;
            return async () => {
                if (!active) return;
                active = false;
                listeners[event].delete(registered);
            };
        },
    };

    function fire(
        event: TuiExperimentalEventName,
        ...args: any[]
    ): void {
        for (const registered of listeners[event]) {
            try {
                const result = registered.listener(...args);
                if (isThenable(result)) {
                    void Promise.resolve(result)
                        .catch((error) => reportFailure(registered, error))
                        .then(() => { if (!closed) requestRender(event); });
                } else if (!closed) {
                    requestRender(event);
                }
            } catch (error) {
                reportFailure(registered, error);
                requestRender(event);
            }
        }
    }

    function reportFailure(
        registered: TuiExperimentalEventListener,
        error: unknown,
    ): void {
        onFailure(
            registered.extensionId,
            error instanceof Error ? error.message : String(error),
        );
    }

    return {
        events,
        currentTranscript: () => lastTranscript,
        transcriptChanged(transcript): void {
            if (sameTranscript(transcript, lastTranscript)) return;
            lastTranscript = transcript;
            fire("transcript_changed", transcript);
        },
        conversationChanged: () => fire("conversation_changed"),
        agentEvent: (event) => fire("agent_event", event),
        clear(): void {
            closed = true;
            for (const set of Object.values(listeners)) set.clear();
        },
    };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
    return typeof (value as PromiseLike<unknown> | undefined)?.then === "function";
}

function sameTranscript(
    next: VeraExperimentalTuiContext["transcript"],
    previous: VeraExperimentalTuiContext["transcript"],
): boolean {
    if (next.length !== previous.length) return false;
    for (let index = next.length - 1; index >= 0; index -= 1) {
        if (next[index]!.role !== previous[index]!.role) return false;
        if (next[index]!.text !== previous[index]!.text) return false;
    }
    return true;
}
