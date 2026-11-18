import { join } from "node:path";

export interface ClientFlightPaths {
    readonly directory: string;
    readonly logPath: string;
    readonly heartbeatPath: string;
}

export function clientFlightPaths(runtimeDirectory: string, instanceId: string): ClientFlightPaths {
    const directory = join(runtimeDirectory, "logs", "clients");
    return {
        directory,
        logPath: join(directory, `${instanceId}.jsonl`),
        heartbeatPath: join(directory, `${instanceId}.heartbeat`),
    };
}
