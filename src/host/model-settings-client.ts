import type { ModelTurnSettings } from "../engine/model-settings.ts";
import { connectHost } from "./connection.ts";

export async function readModelSettingsThroughHost(
    socketPath: string,
    workspace?: string,
    responseTimeoutMs = 2_000,
): Promise<ModelTurnSettings | undefined> {
    const connection = await connectHost({ socketPath });
    try {
        await connection.send({
            type: "model_settings",
            ...(workspace === undefined ? {} : { workspace }),
        });
        const response = await connection.receiveWithin(
            responseTimeoutMs,
            "Host model settings deadline exceeded",
        );
        const record = typeof response === "object" && response !== null
            ? response as Record<string, unknown>
            : undefined;
        if (record?.type !== "model_settings") {
            return undefined;
        }
        const settings = record.settings;
        return typeof settings === "object" && settings !== null
            ? settings as ModelTurnSettings
            : undefined;
    } finally {
        connection.close();
    }
}

export async function refreshCatalogThroughHost(
    socketPath: string,
    provider: string,
    workspace?: string,
    responseTimeoutMs = 10_000,
): Promise<ModelTurnSettings | undefined> {
    const connection = await connectHost({ socketPath });
    try {
        await connection.send({
            type: "catalog_refresh",
            provider,
            ...(workspace === undefined ? {} : { workspace }),
        });
        const response = await connection.receiveWithin(
            responseTimeoutMs,
            "Host catalog refresh deadline exceeded",
        );
        const record = typeof response === "object" && response !== null
            ? response as Record<string, unknown>
            : undefined;
        if (record?.type !== "catalog_refresh") {
            return undefined;
        }
        const settings = record.settings;
        return typeof settings === "object" && settings !== null
            ? settings as ModelTurnSettings
            : undefined;
    } finally {
        connection.close();
    }
}
