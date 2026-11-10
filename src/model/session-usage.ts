import type { AssistantMessage, ModelMessage, ModelUsage } from "./types.ts";

export interface SessionModelUsageRow extends ModelUsage {
    readonly provider: string;
    readonly model: string;
    readonly calls: number;
    readonly durationMs: number;
    readonly callsWithoutCost: number;
}

export interface SessionModelUsage {
    readonly rows: readonly SessionModelUsageRow[];
}

export function summarizeSessionModelUsage(
    messages: readonly ModelMessage[],
): SessionModelUsage {
    return messages.reduce(
        (usage, message) => message.role === "assistant"
            ? addSessionModelUsage(usage, message)
            : usage,
        { rows: [] } as SessionModelUsage,
    );
}

export function addSessionModelUsage(
    usage: SessionModelUsage,
    message: AssistantMessage,
): SessionModelUsage {
    const key = `${message.source.provider}\0${message.source.model}`;
    const rows = [...usage.rows];
    const index = rows.findIndex((row) =>
        `${row.provider}\0${row.model}` === key
    );
    const prior = rows[index];
    const next: SessionModelUsageRow = {
        provider: message.source.provider,
        model: message.source.model,
        calls: (prior?.calls ?? 0) + 1,
        durationMs: (prior?.durationMs ?? 0) + (message.durationMs ?? 0),
        inputTokens: (prior?.inputTokens ?? 0) + message.usage.inputTokens,
        outputTokens: (prior?.outputTokens ?? 0) + message.usage.outputTokens,
        cachedInputTokens: (prior?.cachedInputTokens ?? 0)
            + message.usage.cachedInputTokens,
        ...(prior?.cacheWriteInputTokens === undefined
                && message.usage.cacheWriteInputTokens === undefined
            ? {}
            : {
                cacheWriteInputTokens: (prior?.cacheWriteInputTokens ?? 0)
                    + (message.usage.cacheWriteInputTokens ?? 0),
            }),
        reasoningTokens: (prior?.reasoningTokens ?? 0)
            + message.usage.reasoningTokens,
        totalTokens: (prior?.totalTokens ?? 0) + message.usage.totalTokens,
        ...(message.usage.cost === undefined && prior?.cost === undefined
            ? {}
            : { cost: (prior?.cost ?? 0) + (message.usage.cost ?? 0) }),
        callsWithoutCost: (prior?.callsWithoutCost ?? 0)
            + (message.usage.cost === undefined ? 1 : 0),
    };
    if (index < 0) rows.push(next);
    else rows[index] = next;
    return { rows };
}

export class SessionUsageAccumulator {
    private usage: SessionModelUsage;
    private readonly positions = new Map<string, number>();
    private lastProvider: string | undefined;
    private lastModel: string | undefined;
    private lastPosition: number | undefined;

    constructor(initial: SessionModelUsage = { rows: [] }) {
        this.usage = { rows: initial.rows.map((row) => ({ ...row })) };
        for (const [index, row] of this.usage.rows.entries()) {
            this.positions.set(`${row.provider}\0${row.model}`, index);
        }
    }

    add(message: AssistantMessage): void {
        this.addValues(message.source.provider, message.source.model, message.usage, message.durationMs);
    }

    addValues(provider: string, model: string, usage: ModelUsage, durationMs?: number): void {
        const same = provider === this.lastProvider && model === this.lastModel;
        const key = same ? undefined : `${provider}\0${model}`;
        const position = same ? this.lastPosition : this.positions.get(key!);
        this.lastProvider = provider;
        this.lastModel = model;
        this.lastPosition = position;
        const prior = position === undefined ? undefined : this.usage.rows[position];
        if (prior === undefined
            || (prior.cacheWriteInputTokens === undefined && usage.cacheWriteInputTokens !== undefined)
            || (prior.cost === undefined && usage.cost !== undefined)) {
            this.usage = addSessionModelUsage(this.usage, { role: "assistant", content: [], stopReason: "stop",
                source: { provider, model, api: "usage" }, usage, ...(durationMs === undefined ? {} : { durationMs }) });
            if (position === undefined) {
                this.lastPosition = this.usage.rows.length - 1;
                this.positions.set(key ?? `${provider}\0${model}`, this.lastPosition);
            }
            return;
        }
        const row = prior as { -readonly [Key in keyof SessionModelUsageRow]: SessionModelUsageRow[Key] };
        row.calls += 1;
        row.durationMs += durationMs ?? 0;
        row.inputTokens += usage.inputTokens;
        row.outputTokens += usage.outputTokens;
        row.cachedInputTokens += usage.cachedInputTokens;
        if (row.cacheWriteInputTokens !== undefined) row.cacheWriteInputTokens += usage.cacheWriteInputTokens ?? 0;
        row.reasoningTokens += usage.reasoningTokens;
        row.totalTokens += usage.totalTokens;
        if (row.cost !== undefined) row.cost += usage.cost ?? 0;
        row.callsWithoutCost += usage.cost === undefined ? 1 : 0;
    }

    result(): SessionModelUsage {
        return this.usage;
    }
}
