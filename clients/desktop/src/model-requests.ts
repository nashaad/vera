import { isAbsolute } from "node:path";

import { connectHost, type HostConnection } from "../../../src/host/connection.ts";
import type {
    HostModelsResult,
    HostRequestFailure,
    ModelCheck,
    ModelOperationKind,
    ModelOperationResult,
} from "../../ui/src/protocol/bridge.ts";

type Fields = Record<string, unknown>;

const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const MAX_MODEL_CHARS = 256;
const READ_TIMEOUT_MS = 10_000;
const REFRESH_TIMEOUT_MS = 30_000;
// A probe sends a live request to the provider; a slow provider can take minutes.
const PROBE_TIMEOUT_MS = 180_000;
const OPERATIONS: readonly ModelOperationKind[] = ["keep", "unkeep", "verify"];

const NOT_RUNNING: HostRequestFailure = { ok: false, reason: "The host is not running." };

export function workspaceArgument(value: unknown): string | undefined {
    return typeof value === "string" && isAbsolute(value) ? value : undefined;
}

export function providerArgument(value: unknown): string | undefined {
    return typeof value === "string" && PROVIDER_PATTERN.test(value) ? value : undefined;
}

export function modelArgument(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_MODEL_CHARS ? value : undefined;
}

export function operationArgument(value: unknown): ModelOperationKind | undefined {
    return OPERATIONS.find((operation) => operation === value);
}

export async function readModels(socketPath: string | undefined, workspace: string | undefined): Promise<HostModelsResult> {
    if (socketPath === undefined) return NOT_RUNNING;
    return withHost(socketPath, "The host did not answer in time.", async (connection): Promise<HostModelsResult> => {
        await connection.send({ type: "model_settings", ...workspaceField(workspace) });
        const reply = record(await connection.receiveWithin(READ_TIMEOUT_MS, "The host did not answer in time."));
        return reply?.type === "model_settings" && isFields(reply.settings)
            ? { ok: true, settings: reply.settings }
            : { ok: false, reason: "The host did not list its models." };
    });
}

export async function refreshProvider(
    socketPath: string | undefined,
    provider: string,
    workspace: string | undefined,
): Promise<HostModelsResult> {
    if (socketPath === undefined) return NOT_RUNNING;
    return withHost(socketPath, "The provider did not answer in time.", async (connection): Promise<HostModelsResult> => {
        await connection.send({ type: "catalog_refresh", provider, ...workspaceField(workspace) });
        const reply = record(await connection.receiveWithin(REFRESH_TIMEOUT_MS, "The provider did not answer in time."));
        return reply?.type === "catalog_refresh" && isFields(reply.settings)
            ? { ok: true, settings: reply.settings }
            : { ok: false, reason: "The provider could not be asked for its models." };
    });
}

export async function forgetProvider(
    socketPath: string | undefined,
    provider: string,
    workspace: string | undefined,
): Promise<HostModelsResult> {
    if (socketPath === undefined) return NOT_RUNNING;
    return withHost(socketPath, "The host could not remove that provider.", async (connection): Promise<HostModelsResult> => {
        await connection.send({ type: "provider_forget", provider, ...workspaceField(workspace) });
        const reply = record(await connection.receiveWithin(REFRESH_TIMEOUT_MS, "The host did not answer in time."));
        if (reply?.type !== "model_operation_complete") return { ok: false, reason: "This host cannot remove providers." };
        if (typeof reply.error === "string") return { ok: false, reason: reply.error };
        return { ok: true, settings: reply.settings ?? null };
    });
}

export async function operateModel(
    socketPath: string | undefined,
    operation: ModelOperationKind,
    provider: string,
    model: string,
    workspace: string | undefined,
): Promise<ModelOperationResult> {
    if (socketPath === undefined) return NOT_RUNNING;
    const silence = operation === "verify" ? PROBE_TIMEOUT_MS : READ_TIMEOUT_MS;
    return withHost(socketPath, "The host could not change that model.", async (connection): Promise<ModelOperationResult> => {
        await connection.send({ type: "model_operation", operation, models: [{ provider, model }], ...workspaceField(workspace) });
        const results: ModelCheck[] = [];
        while (true) {
            const reply = record(await connection.receiveWithin(silence, "The host did not answer in time."));
            if (reply?.type === "model_operation_step") continue;
            if (reply?.type === "model_operation_result") {
                const check = parseCheck(reply.result);
                if (check !== undefined) results.push(check);
                continue;
            }
            if (reply?.type !== "model_operation_complete") return { ok: false, reason: "This host cannot change models." };
            if (typeof reply.error === "string") return { ok: false, reason: reply.error };
            return { ok: true, results, ...(isFields(reply.settings) ? { settings: reply.settings } : {}) };
        }
    });
}

async function withHost<T>(
    socketPath: string,
    failure: string,
    run: (connection: HostConnection) => Promise<T>,
): Promise<T | HostRequestFailure> {
    let connection: HostConnection | undefined;
    try {
        connection = await connectHost({ socketPath });
        return await run(connection);
    } catch (error) {
        return { ok: false, reason: error instanceof Error && error.message.length > 0 ? error.message : failure };
    } finally {
        connection?.close();
    }
}

function parseCheck(value: unknown): ModelCheck | undefined {
    const fields = record(value);
    if (fields === undefined) return undefined;
    const { provider, model, status, reason } = fields;
    if (typeof provider !== "string" || typeof model !== "string") return undefined;
    if (status !== "passed" && status !== "failed") return undefined;
    return { provider, model, status, ...(typeof reason === "string" ? { reason } : {}) };
}

function workspaceField(workspace: string | undefined): { workspace?: string } {
    return workspace === undefined ? {} : { workspace };
}

function record(value: unknown): Fields | undefined {
    return isFields(value) ? value : undefined;
}

function isFields(value: unknown): value is Fields {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
