import type { EngineEvent } from "../engine/events.ts";
import type {
    SessionModelUsage,
    SessionModelUsageRow,
} from "../engine/protocol.ts";

export interface AgentRunToolCall {
    readonly id: string;
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>>;
    /** Absent when the run stopped before the tool finished. */
    readonly output?: string;
    readonly isError?: boolean;
    readonly durationMs?: number;
}

/** Tool calls in the order they started; parallel calls pair by call id. */
export class ToolCallRecord {
    private readonly calls = new Map<string, AgentRunToolCall>();

    observe(event: EngineEvent): void {
        if (event.type === "tool_execution_started") {
            this.calls.set(event.toolCall.id, {
                id: event.toolCall.id,
                name: event.toolCall.name,
                args: event.toolCall.input,
            });
            return;
        }
        if (event.type !== "tool_execution_finished") return;
        const started = this.calls.get(event.toolCall.id);
        this.calls.set(event.toolCall.id, {
            id: event.toolCall.id,
            name: started?.name ?? event.toolCall.name,
            args: started?.args ?? event.toolCall.input,
            output: event.result.content.map((part) => part.text).join(""),
            isError: event.result.isError,
            durationMs: event.durationMs,
        });
    }

    list(): readonly AgentRunToolCall[] {
        return [...this.calls.values()];
    }
}

/** Session usage is cumulative; a continued session subtracts what it held before the run. */
export function usageSince(
    before: SessionModelUsage,
    after: SessionModelUsage,
): SessionModelUsage {
    const rows: SessionModelUsageRow[] = [];
    for (const row of after.rows) {
        const prior = before.rows.find((candidate) =>
            candidate.provider === row.provider && candidate.model === row.model
        );
        if (prior === undefined) {
            rows.push(row);
            continue;
        }
        if (row.calls === prior.calls) continue;
        rows.push({
            provider: row.provider,
            model: row.model,
            calls: row.calls - prior.calls,
            durationMs: row.durationMs - prior.durationMs,
            inputTokens: row.inputTokens - prior.inputTokens,
            outputTokens: row.outputTokens - prior.outputTokens,
            cachedInputTokens: row.cachedInputTokens - prior.cachedInputTokens,
            ...(row.cacheWriteInputTokens === undefined
                ? {}
                : {
                    cacheWriteInputTokens: row.cacheWriteInputTokens
                        - (prior.cacheWriteInputTokens ?? 0),
                }),
            reasoningTokens: row.reasoningTokens - prior.reasoningTokens,
            totalTokens: row.totalTokens - prior.totalTokens,
            ...(row.cost === undefined
                ? {}
                : { cost: row.cost - (prior.cost ?? 0) }),
            callsWithoutCost: row.callsWithoutCost - prior.callsWithoutCost,
        });
    }
    return { rows };
}
