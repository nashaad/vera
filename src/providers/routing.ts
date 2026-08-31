import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
    type ModelStream,
    type ModelStreamEvent,
} from "../model/types.ts";
import { ModelEventStream } from "../model/stream.ts";
import type { VeraConfig } from "../config.ts";
import type { JsonObject } from "../sdk/hooks.ts";
import { validateProviderRequestBody } from "./request-options.ts";

export type PrepareModelRequest = (
    request: ModelRequest,
    provider: string,
) => ModelRequest | Promise<ModelRequest>;

export function applyModelRequestOptions(
    request: ModelRequest,
    config: Pick<VeraConfig, "model_request_options">,
    provider: string,
): ModelRequest {
    const reference = `${provider}/${request.model}`;
    const entry = config.model_request_options?.[reference];
    if (entry === undefined) return request;
    validateProviderRequestBody(
        provider,
        entry.body,
        `model_request_options.${reference}.body`,
    );
    return mergeModelRequestBody(
        request,
        entry.body,
        `profile request options for ${reference}`,
    );
}

/** A fixed config snapshot for one bounded operation such as model admission. */
export function createRequestOptionsSnapshotAdapter(
    createAdapter: (provider: string) => ModelAdapter,
    defaultProvider: string,
    config: Pick<VeraConfig, "model_request_options">,
): ModelAdapter {
    return new ProviderRoutingAdapter(
        createAdapter,
        defaultProvider,
        undefined,
        (request, provider) => applyModelRequestOptions(
            request,
            config,
            provider,
        ),
    );
}

export function mergeModelRequestBody(
    request: ModelRequest,
    addition: JsonObject,
    source: string,
): ModelRequest {
    const existing = request.bodyExtensions ?? {};
    const collision = Object.keys(addition).find((key) => key in existing);
    if (collision !== undefined) {
        throw new Error(
            `Model request body field "${collision}" is defined by both existing contributions and ${source}`,
        );
    }
    if (Object.keys(addition).length === 0) return request;
    return {
        ...request,
        bodyExtensions: {
            ...existing,
            ...structuredClone(addition),
        },
    };
}

/**
 * How this adapter's cached client can be told apart from one built against
 * different credentials. Absent when the provider has none to speak of.
 */
export type CredentialFingerprint = (provider: string) => string | undefined;

interface CachedAdapter {
    readonly fingerprint: string | undefined;
    readonly adapter: ModelAdapter;
}

export class ProviderRoutingAdapter implements ModelAdapter {
    private readonly adapters = new Map<string, CachedAdapter>();
    private readonly preparedRequests = new WeakMap<
        ModelRequest,
        Map<string, Promise<ModelRequest>>
    >();

    /**
     * Every client is built on demand, including the default provider's.
     *
     * Building it up front meant a configured provider with no credential threw
     * while the agent was being created, so Vera could not start at all: no
     * agent, no TUI, and the connect pane that fixes it lives inside the TUI.
     * Deferred, the same failure arrives on the first turn instead, where it can
     * be read and acted on.
     */
    constructor(
        private readonly createAdapter: (provider: string) => ModelAdapter,
        private readonly defaultProvider: string,
        private readonly fingerprint?: CredentialFingerprint,
        private readonly prepareRequest?: PrepareModelRequest,
    ) {}

    /**
     * A client that cannot be built is a failed turn, not a failed agent.
     *
     * Building one is where a missing credential is noticed, and the adapter
     * contract already says provider failures belong in the stream's terminal
     * error event. Throwing out of here instead would take the whole agent down
     * on the first prompt, which is the opposite of being able to connect a
     * provider and carry on.
     */
    stream(request: ModelRequest): ModelStream {
        const provider = request.provider ?? this.defaultProvider;
        if (this.prepareRequest !== undefined) {
            const output = new ModelEventStream();
            void this.producePrepared(provider, request, output);
            return output;
        }
        try {
            return this.adapter(provider).stream(request);
        } catch (error) {
            return failedStream(
                error instanceof Error ? error : new Error(String(error)),
            );
        }
    }

    private async producePrepared(
        provider: string,
        request: ModelRequest,
        output: ModelEventStream,
    ): Promise<void> {
        let terminal = false;
        try {
            const prepared = await this.preparedRequest(request, provider);
            for await (const event of this.adapter(provider).stream(prepared)) {
                if (event.type === "done" || event.type === "error") {
                    terminal = true;
                }
                output.push(event);
            }
            if (!terminal) {
                throw new Error(
                    `Provider ${provider} ended its stream without a terminal event`,
                );
            }
        } catch (error) {
            if (terminal) return;
            const failure = error instanceof Error ? error : new Error(String(error));
            const aborted = request.signal?.aborted === true;
            output.push({
                type: "error",
                error: failure,
                message: {
                    role: "assistant",
                    content: [],
                    source: { provider, api: "none", model: request.model },
                    usage: emptyUsage(),
                    stopReason: aborted ? "aborted" : "error",
                    errorMessage: failure.message,
                },
            });
        }
    }

    /**
     * Recovery retries the same request object. Retaining its prepared value
     * makes one logical request a snapshot even when the profile changes while
     * the provider is backing off. A fallback builds a new request object (and
     * may select another model), so it receives that model's current options.
     */
    private preparedRequest(
        request: ModelRequest,
        provider: string,
    ): Promise<ModelRequest> {
        let byProvider = this.preparedRequests.get(request);
        if (byProvider === undefined) {
            byProvider = new Map();
            this.preparedRequests.set(request, byProvider);
        }
        let prepared = byProvider.get(provider);
        if (prepared === undefined) {
            prepared = Promise.resolve(this.prepareRequest!(request, provider));
            byProvider.set(provider, prepared);
        }
        return prepared;
    }

    supportsImageInputFor(provider: string, model: string): boolean {
        try {
            const adapter = this.adapter(provider);
            const perModel = adapter.imageInputSupport?.(model);
            return perModel ?? adapter.supportsImageInput !== false;
        } catch {
            // Unknown rather than unsupported: the turn should reach the stream
            // and fail there, with the reason, instead of being turned away
            // here with a message about images.
            return true;
        }
    }

    prepareProvider(provider: string): void {
        this.adapter(provider);
    }

    /**
     * The cached client for a provider, rebuilt when its credentials changed.
     *
     * A client captures the key it was built with, so signing in again while an
     * agent is running would otherwise keep spending the old one until the host
     * restarted, with nothing on screen to explain it. Checking on the way past
     * makes that impossible rather than making it somebody's job to remember: a
     * scheme where whoever writes a credential must also announce it is one
     * missed call away from the same silent staleness.
     */
    private adapter(provider: string): ModelAdapter {
        const fingerprint = this.fingerprint?.(provider);
        const cached = this.adapters.get(provider);
        if (cached !== undefined && cached.fingerprint === fingerprint) {
            return cached.adapter;
        }
        const adapter = this.createAdapter(provider);
        this.adapters.set(provider, { fingerprint, adapter });
        return adapter;
    }
}

/** A stream that carries one failure, in the shape the engine already handles. */
function failedStream(error: Error): ModelStream {
    const message: AssistantMessage = {
        role: "assistant",
        content: [],
        source: { provider: "unavailable", api: "none", model: "none" },
        usage: emptyUsage(),
        stopReason: "error",
        // The turn's terminal detail, which is how the reason reaches the
        // client: without it the turn ends as a bare "error".
        errorMessage: error.message,
    };
    const event: ModelStreamEvent = { type: "error", error, message };
    return {
        async *[Symbol.asyncIterator]() {
            yield event;
        },
        result: () => Promise.resolve(message),
    };
}
