import type { VeraExtensionApi, VeraExtensionProcessOutcome } from "../../sdk/extensions.ts";

export function activate(vera: VeraExtensionApi): void {
    vera.tools.register({
        name: "monitor",
        description: "Start a background command and receive its outcome in this conversation.",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "The shell command to run." },
                description: { type: "string", description: "What this command is doing." },
            },
            required: ["command", "description"],
            additionalProperties: false,
        },
        commandInput: "command",
        async run(request) {
            if (request.startProcess === undefined) throw new Error("Process launch is unavailable.");
            const result = await request.startProcess(request.input.description as string);
            if (result.kind === "rejected") return { output: result.reason, isError: true };
            if (result.kind === "aborted") return { output: "Command was cancelled.", isError: true };
            return {
                output: `Started process ${result.snapshot.processId} (PID ${result.snapshot.pid}).`,
            };
        },
    });
    vera.tools.onProcessOutcome(formatOutcome);
}

function formatOutcome(outcome: VeraExtensionProcessOutcome): string {
    const status = outcome.outcome === "interrupted"
        ? "Interrupted before its outcome could be confirmed."
        : outcome.exitCode === undefined
            ? "Exited without an available exit code."
            : `Exited with code ${outcome.exitCode}.`;
    const output = outcome.outputTail === undefined || outcome.outputTail.length === 0
        ? "(no output)"
        : outcome.outputTail;
    const label = outcome.outputTruncated === true ? "Last output (truncated)" : "Last output";
    return `${outcome.description}\nProcess ${outcome.processId} (PID ${outcome.pid}). ${status}\n${label}:\n${output}`;
}
