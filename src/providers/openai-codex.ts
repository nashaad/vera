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
import { promptCacheKey } from "../model/prompt-cache.ts";
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
    refreshRejectedOpenAICodexAuthorization,
    resolveOpenAICodexAuthorization,
    type OpenAICodexAuthorization,
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
            const cacheKey = promptCacheKey(request);
            const providerRequest: OpenAICodexRequest = {
                model: request.model,
                instructions: request.systemPrompt ?? "",
                input: encodeOpenAICodexInput(messages, request.model),
                tools: encodeOpenAICodexTools(request.tools ?? []),
                tool_choice: "auto",
                parallel_tool_calls: true,
                reasoning: {
                    ...(reasoning?.providerEffort === undefined
                        ? {}
                        : { effort: reasoning.providerEffort }),
                    summary: "auto",
                },
                store: false,
                stream: true,
                include: ["reasoning.encrypted_content"],
                ...(cacheKey === undefined ? {} : { prompt_cache_key: cacheKey }),
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

    const send = async (
        authorization: OpenAICodexAuthorization,
        request: OpenAICodexRequest,
        signal: AbortSignal | undefined,
    ): Promise<Response> => {
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
        // The backend pins a conversation to one cache by these headers as well as the body key.
        if (request.prompt_cache_key !== undefined) {
            headers["session-id"] = request.prompt_cache_key;
            headers["x-client-request-id"] = request.prompt_cache_key;
        }
        return fetchRequest(`${baseUrl}/responses`, {
            method: "POST",
            headers,
            body: JSON.stringify(request),
            signal,
        });
    };

    return new OpenAICodexAdapter(async (request, signal) => {
        const authorization = await resolveOpenAICodexAuthorization(
            authorizationOptions,
        );
        let response = await send(authorization, request, signal);
        if (response.status === 401) {
            // The server drops these tokens well before the expiry they carry,
            // so one 401 buys one refresh and one retry.
            const rejected = await response.text();
            let refreshed: OpenAICodexAuthorization;
            try {
                refreshed = await refreshRejectedOpenAICodexAuthorization(
                    authorization.accessToken,
                    authorizationOptions,
                );
            } catch {
                throw new OpenAICodexHttpError(401, rejected);
            }
            response = await send(refreshed, request, signal);
        }
        if (!response.ok) {
            throw new OpenAICodexHttpError(
                response.status,
                await response.text(),
            );
        }
        if (response.body === null) {
            throw new Error("OpenAI Codex response omitted its event stream");
        }
        return readOpenAICodexEvents(response.body, signal);
    });
}

class OpenAICodexHttpError extends Error {
    readonly statusCode: number;
    readonly detail: string;

    constructor(statusCode: number, detail: string) {
        super(
            detail
                ? `OpenAI Codex returned ${statusCode}: ${detail}`
                : `OpenAI Codex returned ${statusCode}`,
        );
        this.name = "OpenAICodexHttpError";
        this.statusCode = statusCode;
        this.detail = detail;
    }
}

interface CodexUsageLimit {
    readonly message: string;
    readonly resetsAt?: number;
}

// The subscription's usage window is spent; the body says when it resets.
function codexUsageLimit(detail: string): CodexUsageLimit | undefined {
    let body: unknown;
    try {
        body = JSON.parse(detail);
    } catch {
        return undefined;
    }
    const error = typeof body === "object" && body !== null
        ? (body as { error?: unknown }).error
        : undefined;
    if (typeof error !== "object" || error === null) return undefined;
    const fields = error as {
        type?: unknown;
        message?: unknown;
        resets_at?: unknown;
    };
    if (fields.type !== "usage_limit_reached") return undefined;
    const message = typeof fields.message === "string" && fields.message.length > 0
        ? fields.message
        : "The usage limit has been reached";
    const resetsAt = typeof fields.resets_at === "number"
        ? fields.resets_at * 1_000
        : undefined;
    return resetsAt !== undefined && Number.isSafeInteger(resetsAt) && resetsAt > 0
        ? { message, resetsAt }
        : { message };
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
    // Bun reports a dropped socket as a plain Error with a code such as ECONNRESET.
    if (value instanceof TypeError || hasErrorCode(value)) {
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
    const usageLimit = statusCode === 429 ? codexUsageLimit(error.detail) : undefined;
    if (usageLimit !== undefined) {
        return {
            kind: "rate_limit",
            resolution: "none",
            message: `OpenAI Codex usage limit reached: ${usageLimit.message}`,
            statusCode,
            providerErrorType: "usage_limit_reached",
            providerMessage: usageLimit.message,
            ...(usageLimit.resetsAt === undefined ? {} : { resetsAt: usageLimit.resetsAt }),
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

function hasErrorCode(value: unknown): boolean {
    return value instanceof Error
        && typeof (value as { code?: unknown }).code === "string";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw signal.reason ?? new Error("Model request aborted");
    }
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

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
