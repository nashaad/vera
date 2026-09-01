import type { ModelTurnSettings } from "../engine/model-settings.ts";
import { connectHost } from "./connection.ts";

export async function readModelSettingsThroughHost(
    socketPath: string,
    workspace?: string,
    responseTimeoutMs = 2_000,
): Promise<ModelTurnSettings | undefined> {
    const connection = await connectHost({ socketPath });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        await connection.send({
            type: "model_settings",
            ...(workspace === undefined ? {} : { workspace }),
        });
        const response = await Promise.race([
            connection.receive(),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    reject(new Error("Host model settings deadline exceeded"));
                }, responseTimeoutMs);
            }),
        ]);
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
        clearTimeout(timeout);
        connection.close();
    }
}
