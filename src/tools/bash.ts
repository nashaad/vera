import {
    DEFAULT_BASH_YIELD_MS,
    ManagedProcessRegistry,
    MAX_BASH_YIELD_MS,
    type ManagedProcessRunResult,
    type ManagedProcessScope,
} from "./process-runtime.ts";
import type { RegisteredTool, ToolOutput } from "./types.ts";

export const bashTool: RegisteredTool = {
    definition: {
        name: "bash",
        description: "Run a shell command in the current working directory.",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string" },
                yield_after: {
                    type: "number",
                    minimum: 0,
                    maximum: MAX_BASH_YIELD_MS / 1_000,
                    description:
                        "Seconds to wait before returning a process ID. Use 0 to start in the background.",
                },
            },
            required: ["command"],
            additionalProperties: false,
        },
    },
    execute(input, context, signal): Promise<ToolOutput> {
        const command = input.command;
        if (typeof command !== "string") {
            throw new Error("bash tool requires a string command");
        }
        const yieldAfterMs = parseYieldAfter(input.yield_after);
        return runBash(command, context.workspace, signal, context.env, {
            processes: context.processes,
            yieldAfterMs,
        });
    },
};

export interface RunBashOptions {
    readonly processes?: ManagedProcessScope;
    readonly yieldAfterMs?: number;
}

export async function runBash(
    command: string,
    workspace: string,
    signal?: AbortSignal,
    env?: Readonly<Record<string, string>>,
    options: RunBashOptions = {},
): Promise<ToolOutput> {
    signal?.throwIfAborted();
    const ownedRegistry = options.processes === undefined
        ? new ManagedProcessRegistry()
        : undefined;
    const processes = options.processes
        ?? ownedRegistry!.scope("direct-bash-call");
    let result: ManagedProcessRunResult;
    try {
        result = await processes.run({
            command,
            cwd: workspace,
            env: { ...process.env, ...env },
            signal,
            yieldAfterMs: options.processes === undefined
                ? undefined
                : options.yieldAfterMs ?? DEFAULT_BASH_YIELD_MS,
            interactive: false,
        });
    } finally {
        await ownedRegistry?.close();
    }
    return bashOutput(result);
}

function parseYieldAfter(value: unknown): number {
    if (value === undefined) return DEFAULT_BASH_YIELD_MS;
    if (
        typeof value !== "number"
        || !Number.isFinite(value)
        || value < 0
        || value * 1_000 > MAX_BASH_YIELD_MS
    ) {
        throw new Error(
            `bash yield_after must be between 0 and ${MAX_BASH_YIELD_MS / 1_000} seconds`,
        );
    }
    return Math.round(value * 1_000);
}

function bashOutput(result: ManagedProcessRunResult): ToolOutput {
    if (result.kind === "rejected") {
        return { kind: "output", output: result.reason, isError: true };
    }
    if (result.kind === "exited") {
        return {
            kind: "output",
            output: result.snapshot.output.trim() || "(no output)",
            isError: result.snapshot.exitCode !== 0,
        };
    }
    if (result.kind === "aborted") {
        const snapshot = result.snapshot;
        const retained = result.terminated
            ? ""
            : `\n\n${snapshot.terminationError ?? "Termination could not be confirmed."}`
                + ` The process remains managed as ${snapshot.processId}; use process kill to retry.`;
        return {
            kind: "output",
            output: (snapshot.output.trim() || "(no output)") + retained,
            isError: true,
            ...(result.terminated ? {} : { processId: snapshot.processId }),
        };
    }
    const snapshot = result.snapshot;
    const output = snapshot.output === "(no output)"
        ? ""
        : `\n\nOutput so far:\n${snapshot.output.trim()}`;
    return {
        kind: "output",
        output:
            `Process still running after ${formatElapsed(snapshot.elapsedMs)} `
            + `(process_id: ${snapshot.processId}, pid: ${snapshot.pid}).\n`
            + "Use process read to inspect it or process kill to terminate it."
            + output,
        isError: false,
        processId: snapshot.processId,
    };
}

function formatElapsed(milliseconds: number): string {
    if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))}ms`;
    return `${(milliseconds / 1_000).toFixed(1)}s`;
}
