import { platform, release, arch } from "node:os";

import { OpenAICodexStreamDecoder } from "./openai-codex-stream.ts";
import { resolveReasoningSelection } from "../model/reasoning-effort.ts";
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
    private readonly sendResponse: SendOpenAICodexResponse;

    constructor(sendResponse: SendOpenAICodexResponse) {
        this.sendResponse = sendResponse;
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
                );
            const providerRequest: OpenAICodexRequest = {
                model: request.model,
                ...(request.maxTokens === undefined
                    ? {}
                    : { max_output_tokens: request.maxTokens }),
                instructions: request.systemPrompt ?? "",
                input: encodeOpenAICodexInput(messages),
                tools: encodeOpenAICodexTools(request.tools ?? []),
                tool_choice: "auto",
                parallel_tool_calls: false,
                reasoning: {
                    ...(reasoning === undefined
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

            stream.push({ type: "done", message: decoder.finish() });
        } catch (value) {
            const error = request.signal?.aborted
                ? toError(value)
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

function snapshotImageInputs(request: ModelRequest): ModelRequest {
    return {
        ...request,
        messages: request.messages.map((message) => message.role !== "user"
            ? message
            : {
                ...message,
                content: message.content.map((block) => block.type === "text"
                    ? block
                    : { ...block, data: new Uint8Array(block.data) }),
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
