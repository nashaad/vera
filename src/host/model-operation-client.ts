import type { ModelTurnSettings } from "../engine/model-settings.ts";
import type { ModelOperation, ModelOperationResult } from "../model/model-operations.ts";
import { connectHost } from "./connection.ts";

export async function operateModelsThroughHost(
    socketPath: string,
    operation: ModelOperation,
    onResult: (result: ModelOperationResult) => void,
    workspace?: string,
    responseTimeoutMs = 180_000,
): Promise<ModelTurnSettings | undefined> {
    const connection = await connectHost({ socketPath });
    try {
        await connection.send({ type: "model_operation", ...operation,
            ...(workspace === undefined ? {} : { workspace }) });
        while (true) {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let response: unknown;
            try {
                response = await Promise.race([connection.receive(), new Promise<never>((_, reject) => {
                    timeout = setTimeout(() => reject(new Error("Model operation response timed out")), responseTimeoutMs);
                })]);
            } finally { clearTimeout(timeout); }
            const record = response as Record<string, unknown> | undefined;
            if (record?.type === "model_operation_result") {
                onResult(record.result as ModelOperationResult);
                continue;
            }
            if (record?.type !== "model_operation_complete") throw new Error("This host does not support model operations.");
            if (typeof record.error === "string") throw new Error(record.error);
            return record.settings as ModelTurnSettings | undefined;
        }
    } finally { connection.close(); }
}
