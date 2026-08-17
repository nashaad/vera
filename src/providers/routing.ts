import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
    type ModelStream,
    type ModelStreamEvent,
} from "../model/types.ts";
import { ModelEventStream } from "../model/stream.ts";

export type PrepareModelRequest = (
    request: ModelRequest,
) => ModelRequest | Promise<ModelRequest>;

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
            const prepared = await this.prepareRequest!(request);
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
