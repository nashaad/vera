import type { VeraConfig } from "../../config.ts";
import { ModelEventStream } from "../../model/stream.ts";
import { emptyUsage, type ModelAdapter, type ModelRequest, type ModelStream } from "../../model/types.ts";
import type { AuthStorage, StoredCredential } from "../../providers/auth-storage.ts";
import { createConfiguredModelAdapter, type ConfiguredProviderOptions } from "../../providers/configured.ts";
import { findConfiguredProvider } from "../../providers/registry.ts";
import type { CredentialLease } from "./credentials.ts";
import { redactCredentialValues } from "./redact-credential.ts";

export type LeaseCredential = (provider: string, rejected?: string, signal?: AbortSignal) => Promise<CredentialLease>;

export function createLeasedAdapter(
    config: VeraConfig,
    options: ConfiguredProviderOptions,
    leaseCredential: LeaseCredential,
): ModelAdapter {
    const provider = config.provider;
    const descriptor = findConfiguredProvider(provider, config);
    const capabilities = createConfiguredModelAdapter(config, options);
    return {
        ...(capabilities.supportsImageInput === undefined ? {} : { supportsImageInput: capabilities.supportsImageInput }),
        ...(capabilities.imageInputSupport === undefined ? {} : {
            imageInputSupport: (model: string) => capabilities.imageInputSupport!(model),
        }),
        stream(request: ModelRequest): ModelStream {
            const output = new ModelEventStream();
            void produce(request, output);
            return output;
        },
    };

    async function produce(request: ModelRequest, output: ModelEventStream): Promise<void> {
        let terminal = false;
        const secrets: string[] = [];
        try {
            const lease = descriptor?.credential === "none"
                ? { kind: "none" } as const
                : await leaseCredential(provider, undefined, request.signal);
            if (lease.kind === "api_key") secrets.push(lease.key);
            if (lease.kind === "oauth") secrets.push(lease.authorization.accessToken);
            const credential: StoredCredential | undefined = lease.kind === "api_key"
                ? { type: "api_key", key: lease.key }
                : undefined;
            const authStorage: AuthStorage = {
                getCredential: (id) => id === provider ? credential : undefined,
                setCredential: () => { throw new Error("Worker credentials are read only"); },
                deleteCredential: () => { throw new Error("Worker credentials are read only"); },
            };
            const authorization = lease.kind === "oauth" ? {
                resolve: async () => lease.authorization,
                refreshRejected: async (rejected: string) => {
                    const renewed = await leaseCredential(provider, rejected, request.signal);
                    if (renewed.kind !== "oauth") throw new Error("Provider authorization is unavailable");
                    secrets.push(renewed.authorization.accessToken);
                    return renewed.authorization;
                },
            } : undefined;
            const adapter = createConfiguredModelAdapter(config, {
                ...options,
                authStorage,
                env: {},
                ...(authorization === undefined ? {} : { authorization }),
                ...(options.captureFailedRequest === undefined ? {} : {
                    captureFailedRequest: (detail) => options.captureFailedRequest!(
                        redactCredentialValues(detail, secrets) as typeof detail,
                    ),
                }),
            });
            for await (const event of adapter.stream(request)) {
                if (event.type === "done" || event.type === "error") terminal = true;
                output.push(redactCredentialValues(event, secrets) as typeof event);
            }
            if (!terminal) throw new Error(`Provider ${provider} ended its stream without a terminal event`);
        } catch (error) {
            if (terminal) return;
            const failure = redactCredentialValues(error instanceof Error ? error : new Error(String(error)), secrets) as Error;
            output.push({
                type: "error",
                error: failure,
                message: {
                    role: "assistant", content: [],
                    source: { provider, api: "none", model: request.model },
                    usage: emptyUsage(),
                    stopReason: request.signal?.aborted === true ? "aborted" : "error",
                    errorMessage: failure.message,
                },
            });
        }
    }
}
