import type {
    VeraExtensionModelAssignment,
    VeraExtensionOneshotMessage,
    VeraExtensionOneshotResult,
    VeraSessionAskResult,
    VeraSessionTitleOutcome,
} from "../sdk/extensions.ts";
import type { TurnFinishedHook, TurnFinishedHookPayload } from "../sdk/hooks.ts";

const MAX_ONESHOT_TEXT_BYTES = 256 * 1024;
const MAX_TITLE_BYTES = 200;
const MODEL_ASSIGNMENTS: readonly VeraExtensionModelAssignment[] = [
    "snappy",
    "eco",
    "extra",
];

export interface ExtensionOneshotCall {
    readonly assignment: VeraExtensionModelAssignment;
    readonly systemPrompt: string;
    readonly messages: readonly VeraExtensionOneshotMessage[];
    readonly maxTokens?: number;
}

export interface ExtensionSessionAskCall {
    readonly sessionId: string;
    readonly question: string;
    readonly maxTokens?: number;
}

/** What the host lends extensions once its sessions exist. */
export interface ExtensionHostServices {
    oneshot(
        call: ExtensionOneshotCall,
        signal: AbortSignal,
    ): Promise<VeraExtensionOneshotResult>;
    setSessionTitle(
        sessionId: string,
        title: string,
    ): Promise<VeraSessionTitleOutcome>;
    askSession(
        call: ExtensionSessionAskCall,
        signal: AbortSignal,
    ): Promise<VeraSessionAskResult>;
}

export interface RegisteredTurnFinishedHook {
    readonly extensionId: string;
    readonly run: TurnFinishedHook;
}

/**
 * Extensions activate before the host has sessions, so the host binds its
 * services afterwards. Calls made before then, or after close, reject.
 */
export class ExtensionHostSlot {
    private services: ExtensionHostServices | undefined;
    private readonly closed = new AbortController();

    bind(services: ExtensionHostServices): void {
        if (this.closed.signal.aborted) {
            throw new Error("Extension registry is closed");
        }
        if (this.services !== undefined) {
            throw new Error("Extension host services are already bound");
        }
        this.services = services;
    }

    close(): void {
        this.services = undefined;
        this.closed.abort(new Error("Extension registry is closing"));
    }

    async oneshot(request: unknown): Promise<VeraExtensionOneshotResult> {
        const { call, signal } = parseOneshotRequest(request);
        const services = this.require();
        const combined = signal === undefined
            ? this.closed.signal
            : AbortSignal.any([signal, this.closed.signal]);
        const result = await services.oneshot(call, combined);
        return {
            text: result.text,
            model: result.model,
            ...(result.provider === undefined
                ? {}
                : { provider: result.provider }),
        };
    }

    async askSession(request: unknown): Promise<VeraSessionAskResult> {
        const { call, signal } = parseAskRequest(request);
        const services = this.require();
        const combined = signal === undefined
            ? this.closed.signal
            : AbortSignal.any([signal, this.closed.signal]);
        const result = await services.askSession(call, combined);
        return {
            text: result.text,
            model: result.model,
            ...(result.provider === undefined
                ? {}
                : { provider: result.provider }),
        };
    }

    async setTitle(
        sessionId: unknown,
        title: unknown,
    ): Promise<VeraSessionTitleOutcome> {
        if (typeof sessionId !== "string" || sessionId.length === 0) {
            throw new Error("Invalid session ID");
        }
        const normalized = normalizeTitle(title);
        if (normalized === undefined) {
            throw new Error(
                `Session title must be 1 to ${MAX_TITLE_BYTES} bytes of text`,
            );
        }
        return this.require().setSessionTitle(sessionId, normalized);
    }

    private require(): ExtensionHostServices {
        if (this.closed.signal.aborted) {
            throw new Error("Extension registry is closed");
        }
        if (this.services === undefined) {
            throw new Error("Vera's host is not ready yet");
        }
        return this.services;
    }
}

/** Fire and forget: a slow or failing hook never holds up the session. */
export function notifyTurnFinished(
    hooks: readonly RegisteredTurnFinishedHook[],
    payload: TurnFinishedHookPayload,
    onFailure: (extensionId: string, message: string) => void,
): void {
    for (const hook of hooks) {
        void Promise.resolve()
            .then(() => hook.run(structuredClone(payload)))
            .catch((error: unknown) => {
                try {
                    onFailure(
                        hook.extensionId,
                        error instanceof Error ? error.message : String(error),
                    );
                } catch {
                    // A broken logger must not surface as an unhandled rejection.
                }
            });
    }
}

// Line breaks collapse so a model-written title still reads as one line.
function normalizeTitle(title: unknown): string | undefined {
    if (typeof title !== "string") {
        return undefined;
    }
    const collapsed = title.replaceAll(/\s+/g, " ").trim();
    return collapsed.length === 0
            || collapsed.includes("\0")
            || Buffer.byteLength(collapsed, "utf8") > MAX_TITLE_BYTES
        ? undefined
        : collapsed;
}

function parseOneshotRequest(request: unknown): {
    readonly call: ExtensionOneshotCall;
    readonly signal?: AbortSignal;
} {
    if (typeof request !== "object" || request === null) {
        throw new Error("Invalid oneshot request");
    }
    const value = request as Record<string, unknown>;
    const assignment = value.assignment;
    if (
        typeof assignment !== "string"
        || !MODEL_ASSIGNMENTS.includes(assignment as VeraExtensionModelAssignment)
    ) {
        throw new Error(
            `Oneshot assignment must be one of ${MODEL_ASSIGNMENTS.join(", ")}`,
        );
    }
    const systemPrompt = value.systemPrompt ?? "";
    if (typeof systemPrompt !== "string") {
        throw new Error("Oneshot systemPrompt must be text");
    }
    const messages = parseMessages(value.messages);
    let bytes = Buffer.byteLength(systemPrompt, "utf8");
    for (const message of messages) {
        bytes += Buffer.byteLength(message.text, "utf8");
    }
    if (bytes > MAX_ONESHOT_TEXT_BYTES) {
        throw new Error(
            `Oneshot request text exceeds ${MAX_ONESHOT_TEXT_BYTES} bytes`,
        );
    }
    const maxTokens = value.maxTokens;
    if (
        maxTokens !== undefined
        && (typeof maxTokens !== "number"
            || !Number.isSafeInteger(maxTokens)
            || maxTokens <= 0)
    ) {
        throw new Error("Oneshot maxTokens must be a positive whole number");
    }
    const signal = value.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new Error("Oneshot signal must be an AbortSignal");
    }
    return {
        call: {
            assignment: assignment as VeraExtensionModelAssignment,
            systemPrompt,
            messages,
            ...(maxTokens === undefined ? {} : { maxTokens }),
        },
        ...(signal === undefined ? {} : { signal }),
    };
}

function parseAskRequest(request: unknown): {
    readonly call: ExtensionSessionAskCall;
    readonly signal?: AbortSignal;
} {
    if (typeof request !== "object" || request === null) {
        throw new Error("Invalid session ask request");
    }
    const value = request as Record<string, unknown>;
    const sessionId = value.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw new Error("Invalid session ID");
    }
    const question = value.question;
    if (typeof question !== "string" || question.trim().length === 0) {
        throw new Error("Session ask needs a question");
    }
    if (Buffer.byteLength(question, "utf8") > MAX_ONESHOT_TEXT_BYTES) {
        throw new Error(
            `Session ask question exceeds ${MAX_ONESHOT_TEXT_BYTES} bytes`,
        );
    }
    const maxTokens = value.maxTokens;
    if (
        maxTokens !== undefined
        && (typeof maxTokens !== "number"
            || !Number.isSafeInteger(maxTokens)
            || maxTokens <= 0)
    ) {
        throw new Error("Session ask maxTokens must be a positive whole number");
    }
    const signal = value.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
        throw new Error("Session ask signal must be an AbortSignal");
    }
    return {
        call: {
            sessionId,
            question,
            ...(maxTokens === undefined ? {} : { maxTokens }),
        },
        ...(signal === undefined ? {} : { signal }),
    };
}

function parseMessages(value: unknown): readonly VeraExtensionOneshotMessage[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error("Oneshot needs at least one message");
    }
    return value.map((entry: unknown): VeraExtensionOneshotMessage => {
        if (typeof entry !== "object" || entry === null) {
            throw new Error("Invalid oneshot message");
        }
        const message = entry as Record<string, unknown>;
        if (
            (message.role !== "user" && message.role !== "assistant")
            || typeof message.text !== "string"
        ) {
            throw new Error("Oneshot messages need a user or assistant role and text");
        }
        return { role: message.role, text: message.text };
    });
}
