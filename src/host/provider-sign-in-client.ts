import { randomUUID } from "node:crypto";
import type { ProviderSignInStatus } from "../providers/provider-sign-in.ts";
import type { SaveProviderInput } from "../providers/save-provider.ts";
import { connectHost } from "./connection.ts";

export async function listProvidersThroughHost(socketPath: string): Promise<readonly ProviderSignInStatus[]> {
    const connection = await connectHost({ socketPath });
    try {
        const requestId = randomUUID();
        await connection.send({ type: "provider_list", request_id: requestId });
        const response = await connection.receiveWithin(10_000, "The host did not list providers") as Record<string, unknown>;
        if (response.request_id !== requestId) throw new Error("Invalid provider response");
        if (response.type === "provider_request_failed") throw new Error(String(response.reason));
        if (response.type !== "provider_list_result" || !Array.isArray(response.providers)) throw new Error("Invalid provider response");
        const providers = response.providers.map(parseProviderSignInStatus);
        if (providers.some((provider) => provider === undefined)) throw new Error("Invalid provider response");
        return providers as ProviderSignInStatus[];
    } finally { connection.close(); }
}

export async function saveProviderThroughHost(socketPath: string, input: SaveProviderInput & { readonly custom: boolean }): Promise<ProviderSignInStatus> {
    const connection = await connectHost({ socketPath });
    try {
        const requestId = randomUUID();
        await connection.send({ type: "provider_save", request_id: requestId, provider: input.id, key: input.apiKey ?? "",
            credential: input.declaration.credential,
            ...(input.apiKey === undefined && input.editing === input.id ? { reuse_existing: true } : {}), endpoint: input.declaration.base_url, protocol: input.declaration.protocol, custom: input.custom,
            ...(input.editing === undefined ? {} : { editing: input.editing }),
            ...(input.replaces === undefined ? {} : { replaces: input.replaces }),
            ...(input.shipped === undefined ? {} : { shipped: input.shipped }),
            ...(input.restore === undefined ? {} : { restore: input.restore }) });
        const response = await connection.receiveWithin(30_000, "The provider did not answer in time") as Record<string, unknown>;
        if (response.request_id !== requestId) throw new Error("Invalid provider response");
        if (response.type === "provider_request_failed") throw new Error(String(response.reason));
        if (response.type !== "provider_save_result" || typeof response.provider !== "object" || response.provider === null) throw new Error("Invalid provider response");
        const provider = parseProviderSignInStatus(response.provider);
        if (provider === undefined) throw new Error("Invalid provider response");
        return provider;
    } finally { connection.close(); }
}

export async function loginProviderThroughHost(socketPath: string, provider: string, onUrl: (url: string) => void, signal?: AbortSignal): Promise<ProviderSignInStatus> {
    const connection = await connectHost({ socketPath, signal });
    const requestId = randomUUID();
    const abort = () => connection.close();
    signal?.addEventListener("abort", abort, { once: true });
    try {
        await connection.send({ type: "provider_sign_in", request_id: requestId, provider });
        for (;;) {
            const response = await connection.receiveWithin(310_000, "Sign-in timed out") as Record<string, unknown>;
            if (response.request_id !== requestId) throw new Error("Invalid sign-in response");
            if (response.type === "provider_sign_in_url" && typeof response.url === "string") { onUrl(response.url); continue; }
            if (response.type === "provider_request_failed") throw new Error(String(response.reason));
            if (response.type === "provider_sign_in_result") {
                const status = parseProviderSignInStatus(response.provider);
                if (status !== undefined) return status;
            }
            throw new Error("Invalid sign-in response");
        }
    } finally { signal?.removeEventListener("abort", abort); connection.close(); }
}

export async function saveKnownProviderKeyThroughHost(socketPath: string, provider: string, key: string): Promise<void> {
    const entry = (await listProvidersThroughHost(socketPath)).find((row) => row.id === provider);
    if (entry?.endpoint === undefined || entry.protocol === undefined) throw new Error("Provider endpoint is unavailable");
    await saveProviderThroughHost(socketPath, { id: provider, apiKey: key, custom: entry.custom,
        ...(entry.connected ? { editing: provider } : {}),
        declaration: { credential: "api_key", protocol: entry.protocol, base_url: entry.endpoint } });
}

export async function selectProviderModelThroughHost(socketPath: string, provider: string, model: string): Promise<void> {
    const connection = await connectHost({ socketPath });
    try {
        const requestId = randomUUID();
        await connection.send({ type: "provider_select_model", request_id: requestId, provider, model });
        const response = await connection.receiveWithin(180_000, "The model did not answer in time") as Record<string, unknown>;
        if (response.request_id !== requestId) throw new Error("Invalid model response");
        if (response.type === "provider_request_failed") throw new Error(String(response.reason));
        if (response.type !== "provider_select_model_result") throw new Error("Invalid model response");
    } finally { connection.close(); }
}

export function parseProviderSignInStatus(value: unknown): ProviderSignInStatus | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const fields = value as Record<string, unknown>;
    if (typeof fields.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(fields.id) || fields.id.length > 128
        || typeof fields.name !== "string" || fields.name.length === 0 || fields.name.length > 512
        || !Array.isArray(fields.methods) || fields.methods.length > 2
        || fields.methods.some((method) => method !== "key" && method !== "browser")
        || typeof fields.connected !== "boolean" || typeof fields.catalog_connected !== "boolean" || typeof fields.custom !== "boolean"
        || (fields.connected_by !== undefined && !["key", "browser", "environment", "none"].includes(String(fields.connected_by)))
        || (fields.endpoint !== undefined && (typeof fields.endpoint !== "string" || fields.endpoint.length > 4096))
        || (fields.protocol !== undefined && fields.protocol !== "openai-chat" && fields.protocol !== "anthropic-messages")
        || (fields.models_discovered !== undefined && (!Number.isSafeInteger(fields.models_discovered) || (fields.models_discovered as number) < 0))) return undefined;
    return {
        id: fields.id, name: fields.name, methods: fields.methods as ("key" | "browser")[],
        connected: fields.connected, catalog_connected: fields.catalog_connected, custom: fields.custom,
        ...(fields.connected_by === undefined ? {} : { connected_by: fields.connected_by as "key" | "browser" | "environment" | "none" }),
        ...(fields.endpoint === undefined ? {} : { endpoint: fields.endpoint as string }),
        ...(fields.protocol === undefined ? {} : { protocol: fields.protocol as "openai-chat" | "anthropic-messages" }),
        ...(fields.models_discovered === undefined ? {} : { models_discovered: fields.models_discovered as number }),
    };
}
