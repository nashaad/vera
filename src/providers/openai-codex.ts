import { platform, release, arch } from "node:os";

import { OpenAICodexStreamDecoder } from "./openai-codex-stream.ts";
import {
    effortSubstitutionNotice,
    resolveReasoningSelection,
    type ResolveReasoningOptions,
} from "../model/reasoning-effort.ts";
import { effectiveCatalog } from "../model/catalog.ts";
import {
    encodeOpenAICodexInput,
    encodeOpenAICodexTools,
    readOpenAICodexEvents,
    type OpenAICodexRequest,
    type SendOpenAICodexResponse,
} from "./openai-codex-wire.ts";
import {
    ProviderFailureError,
    type ProviderFailure,
} from "../model/provider-failure.ts";
import { ModelEventStream } from "../model/stream.ts";
import { transformMessages } from "../model/transform.ts";
import type {
    AssistantMessage,
    ModelAdapter,
    ModelRequest,
    ModelSource,
} from "../model/types.ts";
import {
    createAuthStorage,
} from "./auth-storage.ts";
import {
    resolveOpenAICodexAuthorization,
    type OpenAICodexAuthorizationOptions,
} from "./openai-codex-oauth.ts";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";

export type { SendOpenAICodexResponse } from "./openai-codex-wire.ts";

export interface OpenAICodexAdapterOptions extends OpenAICodexAuthorizationOptions {
    readonly baseUrl?: string;
}

export class OpenAICodexAdapter implements ModelAdapter {
    readonly supportsImageInput = true;
    private readonly sendResponse: SendOpenAICodexResponse;
    /** Where the model catalog is read from, so a test can name its own. */
    private readonly catalogCacheDir: string | undefined;

    constructor(sendResponse: SendOpenAICodexResponse, cacheDir?: string) {
        this.sendResponse = sendResponse;
        this.catalogCacheDir = cacheDir;
    }

    stream(request: ModelRequest): ModelEventStream {
        const stream = new ModelEventStream();
        void this.produce(snapshotImageInputs(request), stream);
        return stream;
    }

    private async produce(
        request: ModelRequest,
        stream: ModelEventStream,
    ): Promise<void> {
        const source: ModelSource = {
            provider: "openai-codex",
            api: "responses",
            model: request.model,
        };
        const decoder = new OpenAICodexStreamDecoder(source, stream);
        stream.push({ type: "start" });

        try {
            throwIfAborted(request.signal);
            const messages = transformMessages(request.messages, { target: source });
            const reasoning = request.reasoningEffort === undefined
                ? undefined
                : await resolveReasoningSelection(
                    "openai-codex",
                    request.model,
                    request.reasoningEffort,
                    codexReasoningLevels(request.model, this.catalogCacheDir),
                );
            const substituted = reasoning === undefined
                ? undefined
                : effortSubstitutionNotice(reasoning);
            if (substituted !== undefined) {
                stream.push(substituted);
            }
            const providerRequest: OpenAICodexRequest = {
                model: request.model,
                // request.maxTokens is dropped rather than sent: this backend
                // answers a request carrying an output cap with a 400.
                instructions: request.systemPrompt ?? "",
                input: encodeOpenAICodexInput(messages, request.model),
                tools: encodeOpenAICodexTools(request.tools ?? []),
                tool_choice: "auto",
                parallel_tool_calls: false,
                reasoning: {
                    ...(reasoning?.providerEffort === undefined
                        ? {}
                        : { effort: reasoning.providerEffort }),
                    summary: "auto",
                },
                store: false,
                stream: true,
                include: ["reasoning.encrypted_content"],
            };

            const events = await this.sendResponse(
                providerRequest,
                request.signal,
            );
            for await (const event of events) {
                throwIfAborted(request.signal);
                decoder.accept(event);
            }

            const message = decoder.finish();
            if (isReasoningOnlyStop(message)) {
                const failure: ProviderFailure = {
                    kind: "unknown",
                    resolution: "retry",
                    message: "OpenAI Codex returned no visible response or structured tool call",
                    partialOutputReplaceable: true,
                };
                const error = new ProviderFailureError(
                    failure,
                    new Error(failure.message),
                );
                stream.push({
                    type: "error",
                    error,
                    message: {
                        ...message,
                        stopReason: "error",
                        errorMessage: error.message,
                    },
                });
                return;
            }
            stream.push({ type: "done", message });
        } catch (value) {
            const error = request.signal?.aborted
                ? toError(value)
                : value instanceof ProviderFailureError
                    ? value
                    : new ProviderFailureError(
                        classifyOpenAICodexError(value),
                        value,
                    );
            const stopReason = request.signal?.aborted ? "aborted" : "error";
            stream.push({
                type: "error",
                error,
                message: decoder.partial(stopReason, error.message),
            });
        }
    }
}

function isReasoningOnlyStop(message: AssistantMessage): boolean {
    return message.stopReason === "stop"
        && message.content.every((block) =>
            block.type === "thinking"
            || (block.type === "text" && block.text.trim().length === 0)
        )
        && message.content.some((block) =>
            block.type === "thinking"
            && (
                block.text.trim().length > 0
                || (block.signature?.length ?? 0) > 0
            )
        );
}

function snapshotImageInputs(request: ModelRequest): ModelRequest {
    return {
        ...request,
        messages: request.messages.map((message) => message.role !== "user"
            ? message
            : {
                ...message,
                content: message.content.map((block) => {
                    if (block.type === "text") return block;
                    if (block.type === "image_attachment") {
                        throw new Error("Image attachment was not hydrated");
                    }
                    return { ...block, data: new Uint8Array(block.data) };
                }),
            }),
    };
}

export function createOpenAICodexAdapter(
    options: OpenAICodexAdapterOptions = {},
): OpenAICodexAdapter {
    const fetchRequest = options.fetch ?? globalThis.fetch;
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    const authStorage = options.authStorage ?? createAuthStorage();
    const authorizationOptions: OpenAICodexAuthorizationOptions = {
        authStorage,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.now === undefined ? {} : { now: options.now }),
    };

    return new OpenAICodexAdapter(async (request, signal) => {
        const authorization = await resolveOpenAICodexAuthorization(
            authorizationOptions,
        );
        const headers: Record<string, string> = {
            Authorization: `Bearer ${authorization.accessToken}`,
            Accept: "text/event-stream",
            "Content-Type": "application/json",
            originator: "vera",
            "User-Agent": `vera (${platform()} ${release()}; ${arch()})`,
        };
        if (authorization.accountId !== undefined) {
            headers["chatgpt-account-id"] = authorization.accountId;
        }

        const response = await fetchRequest(`${baseUrl}/responses`, {
            method: "POST",
            headers,
            body: JSON.stringify(request),
            signal,
        });
        if (!response.ok) {
            throw new OpenAICodexHttpError(
                response.status,
                await response.text(),
            );
        }
        if (response.body === null) {
            throw new Error("OpenAI Codex response omitted its event stream");
        }
        return readOpenAICodexEvents(response.body);
    });
}

class OpenAICodexHttpError extends Error {
    readonly statusCode: number;

    constructor(statusCode: number, detail: string) {
        super(
            detail
                ? `OpenAI Codex returned ${statusCode}: ${detail}`
                : `OpenAI Codex returned ${statusCode}`,
        );
        this.name = "OpenAICodexHttpError";
        this.statusCode = statusCode;
    }
}

function classifyOpenAICodexError(value: unknown): ProviderFailure {
    const error = toError(value);
    if (value instanceof OpenAICodexHttpError) {
        return httpFailure(value);
    }
    if (error.name === "TimeoutError") {
        return {
            kind: "timeout",
            resolution: "retry",
            message: error.message,
        };
    }
    if (value instanceof TypeError) {
        return {
            kind: "connection",
            resolution: "retry",
            message: error.message,
        };
    }
    return {
        kind: "unknown",
        resolution: "none",
        message: error.message,
    };
}

function httpFailure(error: OpenAICodexHttpError): ProviderFailure {
    const statusCode = error.statusCode;
    if (statusCode === 408) {
        return {
            kind: "timeout",
            resolution: "retry",
            message: error.message,
            statusCode,
        };
    }
    if (statusCode === 429 || statusCode >= 500) {
        return {
            kind: statusCode === 429 ? "rate_limit" : "server",
            resolution: "retry",
            message: error.message,
            statusCode,
        };
    }

    const kinds: Readonly<Partial<Record<number, ProviderFailure["kind"]>>> = {
        401: "authentication",
        402: "payment_required",
        403: "permission",
        404: "not_found",
        413: "request_too_large",
    };
    return {
        kind: kinds[statusCode] ?? "invalid_request",
        resolution: "user_action",
        message: error.message,
        statusCode,
    };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw signal.reason ?? new Error("Model request aborted");
    }
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

/**
 * The model's own reasoning levels, from the catalog Vera already publishes
 * from the Codex cache.
 *
 * `resolveReasoningSelection` takes a level list from its caller and returns no
 * provider effort without one, so a request made without this carries no
 * `effort` at all: the level the user picked is accepted, displayed, and never
 * sent. A model the catalog has not heard of still yields nothing, which is the
 * honest answer rather than a guessed ladder.
 */
function codexReasoningLevels(
    model: string,
    cacheDir: string | undefined,
): ResolveReasoningOptions {
    const catalog = effectiveCatalog(
        "openai-codex",
        cacheDir === undefined ? {} : { cacheDir },
    );
    const catalogModel = catalog.models.find((candidate) => candidate.id === model);
    if (catalogModel === undefined || catalogModel.levels.length === 0) {
        return {};
    }
    return {
        supportedEfforts: catalogModel.levels.map((level) => level.id),
        ...(catalogModel.default_level === undefined
            ? {}
            : { defaultLevel: catalogModel.default_level }),
    };
}
