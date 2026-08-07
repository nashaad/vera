import { connectHost } from "./connection.ts";

export interface RunOnceOutcome {
    readonly agentId: string;
    readonly sessionPath: string;
    readonly text: string;
    readonly outcome: "completed" | "error" | "aborted";
    readonly error?: string;
    readonly notes: readonly string[];
}

export class RunOnceError extends Error {
    constructor(readonly reason?: string) {
        super(reason ?? "Bounded run failed to start");
        this.name = "RunOnceError";
    }
}

export async function runOnceThroughHost(
    socketPath: string,
    request: {
        readonly workspace: string;
        readonly prompt: string;
        readonly approvalMode?: string;
    },
): Promise<RunOnceOutcome> {
    const connection = await connectHost({ socketPath });
    try {
        await connection.send({
            type: "run_once",
            workspace: request.workspace,
            prompt: request.prompt,
            ...(request.approvalMode === undefined
                ? {}
                : { approval_mode: request.approvalMode }),
        });
        const response = asRecord(await connection.receive());
        if (response?.type === "run_once_failed") {
            throw new RunOnceError(
                typeof response.reason === "string"
                        && response.reason.length > 0
                    ? response.reason
                    : undefined,
            );
        }
        if (
            response?.type !== "run_once_finished"
            || typeof response.agent_id !== "string"
            || typeof response.session_path !== "string"
            || typeof response.text !== "string"
            || !isOutcome(response.outcome)
        ) {
            throw new Error("Host returned an invalid bounded run response");
        }
        return {
            agentId: response.agent_id,
            sessionPath: response.session_path,
            text: response.text,
            outcome: response.outcome,
            ...(typeof response.error === "string"
                ? { error: response.error }
                : {}),
            notes: Array.isArray(response.notes)
                ? response.notes.filter(
                    (note): note is string => typeof note === "string",
                )
                : [],
        };
    } finally {
        connection.close();
    }
}

function isOutcome(
    value: unknown,
): value is "completed" | "error" | "aborted" {
    return value === "completed" || value === "error" || value === "aborted";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null
        ? value as Record<string, unknown>
        : undefined;
}
