import type { ModelTurnSettings } from "../engine/model-settings.ts";
import { connectHost } from "./connection.ts";

export async function setProviderEnabledThroughHost(socketPath: string, provider: string, enabled: boolean, workspace?: string): Promise<ModelTurnSettings | undefined> {
    const connection = await connectHost({ socketPath });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        await connection.send({ type: "provider_set_enabled", provider, enabled, workspace });
        const response = await Promise.race([connection.receive(), new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Provider change timed out. Refresh settings before retrying.")), 30_000);
        })]) as Record<string, unknown>;
        if (response.type !== "model_operation_complete") throw new Error("This host does not support turning providers off.");
        if (typeof response.error === "string") throw new Error(response.error);
        return response.settings as ModelTurnSettings | undefined;
    } finally { clearTimeout(timeout); connection.close(); }
}
