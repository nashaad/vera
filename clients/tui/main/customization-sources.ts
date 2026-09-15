import { randomUUID } from "node:crypto";
import type { CustomizationCatalog } from "../../../src/customize/types.ts";
import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import type { TuiAgentClient } from "../agent-client.ts";
import type { TuiRuntime } from "./runtime.ts";

interface Pending {
    readonly client: TuiAgentClient;
    readonly resolve: (catalog: CustomizationCatalog) => void;
}
const pending = new Map<string, Pending>();

export function requestCustomizationSources(rt: TuiRuntime, signal: AbortSignal): Promise<CustomizationCatalog> {
    signal.throwIfAborted();
    const client = rt.client;
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
        const finish = (error?: unknown, catalog?: CustomizationCatalog): void => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            pending.delete(requestId);
            if (error !== undefined) reject(error);
            else if (rt.client !== client) reject(new Error("Conversation changed"));
            else resolve(catalog!);
        };
        const abort = (): void => finish(signal.reason ?? new Error("Cancelled"));
        const timer = setTimeout(() => finish(new Error("Source catalog request timed out")), 10_000);
        signal.addEventListener("abort", abort, { once: true });
        pending.set(requestId, { client, resolve: (catalog) => finish(undefined, catalog) });
        void client.send({ type: "list_customization_sources", requestId }).catch((error) => finish(error));
    });
}

export function receiveCustomizationSources(client: TuiAgentClient, update: AgentUpdate): boolean {
    if (update.type !== "customization_sources") return false;
    const request = pending.get(update.requestId);
    if (request?.client === client) request.resolve(update.catalog);
    return true;
}
