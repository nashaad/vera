import { createHash } from "node:crypto";

import type { VeraConfig } from "../../config.ts";
import { fileReadStamp } from "../../store/read-cache.ts";
import { apiKey, type AuthStorage, type StoredCredential } from "../../providers/auth-storage.ts";
import {
    OPENAI_CODEX_PROVIDER_ID,
    refreshRejectedOpenAICodexAuthorization,
    resolveOpenAICodexAuthorization,
    type OpenAICodexAuthorization,
} from "../../providers/openai-codex-oauth.ts";
import { findConfiguredProvider } from "../../providers/registry.ts";
import { redactCredentialValues, storedCredentialSecrets } from "./redact-credential.ts";

export type CredentialLease =
    | { readonly kind: "none" }
    | { readonly kind: "api_key"; readonly key: string }
    | { readonly kind: "oauth"; readonly authorization: OpenAICodexAuthorization };

interface PendingAuthorization {
    readonly promise: Promise<OpenAICodexAuthorization>;
    readonly rejected: boolean;
    readonly state: { refreshStarted: boolean };
}

export function cachedHostAuthStorage(
    storage: AuthStorage,
    path: string,
    onWrite: () => void,
): AuthStorage {
    let stamp: string | undefined;
    let initialized = false;
    const cached = new Map<string, StoredCredential | undefined>();
    return {
        getCredential(provider) {
            const current = fileReadStamp(path);
            if (!initialized || current !== stamp) {
                stamp = current;
                initialized = true;
                cached.clear();
            }
            if (!cached.has(provider)) cached.set(provider, storage.getCredential(provider));
            return cached.get(provider);
        },
        setCredential(provider, credential) {
            storage.setCredential(provider, credential);
            initialized = false;
            cached.clear();
            onWrite();
        },
        deleteCredential(provider) {
            storage.deleteCredential(provider);
            initialized = false;
            cached.clear();
            onWrite();
        },
    };
}

export function createCredentialBroker(options: {
    readonly authStorage: AuthStorage;
    readonly config: () => VeraConfig;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly fetch?: typeof globalThis.fetch;
}) {
    const pending = new Map<string, PendingAuthorization>();
    const mutations = new Map<string, Promise<void>>();
    async function lease(provider: string, rejected?: string): Promise<CredentialLease> {
        while (mutations.has(provider)) await mutations.get(provider);
        const descriptor = findConfiguredProvider(provider, options.config());
        if (descriptor === undefined) throw new Error(`Unknown provider ${provider}`);
        if (provider === OPENAI_CODEX_PROVIDER_ID) {
            const stored = options.authStorage.getCredential(provider);
            const secrets = stored?.type === "oauth" ? [...storedCredentialSecrets(stored.token)] : [];
            if (rejected !== undefined) secrets.push(rejected);
            try {
                const credential = stored?.type === "oauth" ? stored.token : "";
                const key = `${provider}:${createHash("sha256").update(credential).digest("hex")}`;
                let request = pending.get(key);
                if (request === undefined) {
                    const state = { refreshStarted: false };
                    const refreshFetch = ((input, init) => {
                        state.refreshStarted = true;
                        return (options.fetch ?? globalThis.fetch)(input, init);
                    }) as typeof globalThis.fetch;
                    const authorizationOptions = { authStorage: options.authStorage, fetch: refreshFetch };
                    const operation = rejected === undefined
                        ? resolveOpenAICodexAuthorization(authorizationOptions)
                        : refreshRejectedOpenAICodexAuthorization(rejected, authorizationOptions);
                    const promise = operation.finally(() => {
                        if (pending.get(key) === request) pending.delete(key);
                    });
                    request = { promise, rejected: rejected !== undefined, state };
                    pending.set(key, request);
                }
                const authorization = await request.promise;
                if (rejected !== undefined && !request.rejected && !request.state.refreshStarted
                    && authorization.accessToken === rejected) {
                    return await lease(provider, rejected);
                }
                return { kind: "oauth", authorization };
            } catch (error) {
                throw redactCredentialValues(error, secrets);
            }
        }
        if (descriptor.credential === "none") return { kind: "none" };
        const stored = apiKey(options.authStorage, provider);
        const key = stored !== undefined && stored.length > 0 ? stored
            : descriptor.envVar === undefined ? undefined : (options.env ?? process.env)[descriptor.envVar];
        return key === undefined || key.length === 0
            ? { kind: "none" }
            : { kind: "api_key", key };
    }
    return {
        lease,
        async withProviderMutation(provider: string, change: () => void): Promise<void> {
            const previous = mutations.get(provider);
            const released = Promise.withResolvers<void>();
            const gate = previous === undefined ? released.promise : previous.then(() => released.promise);
            mutations.set(provider, gate);
            try {
                await previous;
                await Promise.allSettled([...pending.entries()]
                    .filter(([key]) => key.startsWith(`${provider}:`))
                    .map(([, request]) => request.promise));
                change();
            } finally {
                released.resolve();
                if (mutations.get(provider) === gate) mutations.delete(provider);
            }
        },
    };
}
