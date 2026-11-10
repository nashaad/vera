import type { EngineEventBus } from "../../engine/events.ts";
import type { InboundCommandRouter } from "../../engine/inbound-command-router.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelStream,
} from "../../model/types.ts";
import type {
    ModelAdapterContext,
    SourcedModelMiddleware,
} from "../../sdk/model-middleware.ts";
import { extensionNoticeEvent } from "../extension-notice.ts";
import type { WorkerAdapterSpec, WorkerSessionSeed } from "./start.ts";

export interface WorkerModelContextOptions {
    readonly session: WorkerSessionSeed;
    readonly provider: string;
    readonly purpose?: ModelAdapterContext["purpose"];
    readonly events?: EngineEventBus;
    readonly inbound: () => InboundCommandRouter | undefined;
    readonly extensionId: string;
}

export function failingWorkerAdapter(
    message: string,
    model: string,
): ModelAdapter {
    const error = new Error(message);
    const response: AssistantMessage = {
        role: "assistant",
        content: [],
        source: { provider: "worker", api: "worker", model },
        usage: emptyUsage(),
        stopReason: "error",
        errorMessage: message,
    };
    return {
        stream: (): ModelStream => ({
            async *[Symbol.asyncIterator]() {
                yield { type: "error", error, message: response };
            },
            async result() {
                return response;
            },
        }),
    };
}

export function workerProvider(spec: WorkerAdapterSpec): string {
    const options = spec.options;
    if (typeof options !== "object" || options === null) return "unknown";
    const provider = (options as { readonly provider?: unknown }).provider;
    return typeof provider === "string" ? provider : "unknown";
}

export function workerModelContext(
    options: WorkerModelContextOptions,
): ModelAdapterContext {
    const header = options.session.header as {
        readonly id: string;
        readonly cwd: string;
        readonly parentId?: string;
    };
    const events = options.events;
    return {
        sessionId: header.id,
        sessionPath: options.session.path,
        ...(header.parentId === undefined
            ? {}
            : { parentSessionId: header.parentId }),
        workspace: header.cwd,
        provider: options.provider,
        purpose: options.purpose ?? "turn",
        ...(events === undefined
            ? {}
            : {
                notice: (notice) => events.emit(
                    extensionNoticeEvent(notice, options.extensionId),
                ),
            }),
        ask: async (request, signal) => {
            const inbound = options.inbound();
            if (inbound === undefined) return { outcome: "cancelled" };
            return inbound.requestUserQuestion(
                request,
                signal === undefined ? {} : { signal },
            );
        },
    };
}

export function applyWorkerModelMiddleware(
    adapter: ModelAdapter,
    middleware: readonly SourcedModelMiddleware[],
    options: Omit<WorkerModelContextOptions, "extensionId">,
): ModelAdapter {
    let wrapped = adapter;
    for (const entry of middleware) {
        wrapped = entry.apply(wrapped, workerModelContext({ ...options, extensionId: entry.extensionId }));
    }
    return wrapped;
}

/** One middleware chain per routed provider, each seeing that provider and the request's purpose. */
export function workerAdapterWithMiddleware(
    adapter: ModelAdapter,
    middleware: readonly SourcedModelMiddleware[],
    options: Omit<WorkerModelContextOptions, "extensionId">,
): ModelAdapter {
    if (middleware.length === 0) return adapter;
    const chains = new Map<string, ModelAdapter>();
    return {
        ...(adapter.supportsImageInput === undefined
            ? {}
            : { supportsImageInput: adapter.supportsImageInput }),
        ...(adapter.imageInputSupport === undefined
            ? {}
            : {
                imageInputSupport: adapter.imageInputSupport.bind(adapter),
            }),
        ...(adapter.supportsImageInputFor === undefined
            ? {}
            : {
                supportsImageInputFor: adapter.supportsImageInputFor.bind(
                    adapter,
                ),
            }),
        stream: (request) => {
            const provider = request.provider ?? options.provider;
            let chain = chains.get(provider);
            if (chain === undefined) {
                chain = applyWorkerModelMiddleware(
                    adapter,
                    middleware,
                    { ...options, provider },
                );
                chains.set(provider, chain);
            }
            return chain.stream(request);
        },
    };
}
