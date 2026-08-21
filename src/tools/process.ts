import type { ManagedProcessSnapshot } from "./process-runtime.ts";
import type { RegisteredTool, ToolOutput } from "./types.ts";

export const processTool: RegisteredTool = {
    definition: {
        name: "process",
        description: "Read or terminate a shell process returned by Bash.",
        inputSchema: {
            type: "object",
            properties: {
                action: { type: "string", enum: ["read", "kill"] },
                process_id: { type: "string" },
            },
            required: ["action", "process_id"],
            additionalProperties: false,
        },
    },
    async execute(input, context): Promise<ToolOutput> {
        const action = input.action;
        const processId = input.process_id;
        if (action !== "read" && action !== "kill") {
            throw new Error("process action must be read or kill");
        }
        if (typeof processId !== "string" || processId.length === 0) {
            throw new Error("process tool requires a process_id");
        }
        if (action === "kill") {
            const snapshot = await context.processes.kill(processId);
            return snapshot === undefined
                ? unknownProcess(processId)
                : {
                    kind: "output",
                    output: formatSnapshot(snapshot, true),
                    isError: snapshot.status === "running",
                    processId,
                };
        }
        const snapshot = context.processes.read(processId);
        return snapshot === undefined
            ? unknownProcess(processId)
            : {
                kind: "output",
                output: formatSnapshot(snapshot, false),
                isError:
                    snapshot.status === "exited" && snapshot.exitCode !== 0,
                processId,
            };
    },
};

function unknownProcess(processId: string): ToolOutput {
    return {
        kind: "output",
        output:
            `Process ${processId} is unknown. It may already have been read, `
            + "or the host may have restarted.",
        isError: true,
    };
}

function formatSnapshot(
    snapshot: ManagedProcessSnapshot,
    killed: boolean,
): string {
    const state = killed
        ? snapshot.status === "running"
            ? "could not be confirmed terminated"
            : `terminated with exit code ${snapshot.exitCode ?? "unknown"}`
        : snapshot.status === "running"
            ? "is still running"
            : `exited with code ${snapshot.exitCode ?? "unknown"}`;
    return [
        `Process ${snapshot.processId} ${state} after ${formatElapsed(snapshot.elapsedMs)}.`,
        snapshot.terminationError ?? "",
        snapshot.output,
    ].filter((part) => part.length > 0).join("\n\n");
}

function formatElapsed(milliseconds: number): string {
    if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
    return `${(milliseconds / 1_000).toFixed(1)}s`;
}
