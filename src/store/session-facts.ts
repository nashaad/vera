import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import type { ContextMeasurement } from "../engine/context-measurement.ts";
import { measureReportedUsage } from "../engine/context-measurement.ts";
import type { SessionModelUsage, SessionModelUsageRow } from "../engine/protocol.ts";
import type { ModelUsage } from "../model/types.ts";
import type { ModelFailureRecord } from "./model-failures.ts";

export type SessionFactName = "usage" | "context" | "failure" | "model";

export interface SessionModelSelection {
    readonly provider: string;
    readonly model: string;
    readonly effort?: string;
}

export interface SessionFacts {
    readonly usage?: SessionModelUsage;
    readonly context?: ContextMeasurement;
    readonly contextMeasuredAt?: string;
    readonly model?: SessionModelSelection;
    readonly failure?: ModelFailureRecord;
}

export type ContextCapacityResolver = (
    provider: string,
    model: string,
) => number | undefined;

export interface ReadSessionFactsOptions {
    readonly include: readonly SessionFactName[];
    readonly capacity?: ContextCapacityResolver;
}

export async function readSessionFacts(
    path: string,
    options: ReadSessionFactsOptions,
): Promise<SessionFacts> {
    const wantsUsage = options.include.includes("usage");
    const wantsContext = options.include.includes("context");
    const wantsModel = options.include.includes("model");
    if (!wantsUsage && !wantsContext && !wantsModel) return {};

    let rows: SessionModelUsageRow[] = [];
    let lastSource: SessionModelSelection | undefined;
    let lastUsage: ModelUsage | undefined;
    let lastAt: string | undefined;

    try {
        const lines = createInterface({
            input: createReadStream(path, { encoding: "utf8" }),
            crlfDelay: Infinity,
        });
        for await (const line of lines) {
            if (!line.includes('"assistant"')) continue;
            let record: Record<string, unknown>;
            try {
                record = JSON.parse(line) as Record<string, unknown>;
            } catch {
                continue;
            }
            if (record.type !== "message") continue;
            const message = record.message as Record<string, unknown> | undefined;
            if (message?.role !== "assistant") continue;
            const source = message.source as Record<string, unknown> | undefined;
            const usage = message.usage as ModelUsage | undefined;
            if (
                typeof source?.provider !== "string"
                || typeof source.model !== "string"
                || usage === undefined
            ) {
                continue;
            }
            lastSource = { provider: source.provider, model: source.model };
            lastUsage = usage;
            if (typeof record.timestamp === "string") lastAt = record.timestamp;
            if (wantsUsage) {
                rows = addUsageRow(
                    rows,
                    source.provider,
                    source.model,
                    usage,
                    typeof message.durationMs === "number"
                        ? message.durationMs
                        : 0,
                );
            }
        }
    } catch {
        return {};
    }

    const context = wantsContext && lastUsage !== undefined && lastSource !== undefined
        ? measureReportedUsage(
            lastUsage,
            options.capacity?.(lastSource.provider, lastSource.model),
        )
        : undefined;

    return {
        ...(wantsUsage ? { usage: { rows } } : {}),
        ...(context === undefined ? {} : { context }),
        ...(context === undefined || lastAt === undefined
            ? {}
            : { contextMeasuredAt: lastAt }),
        ...(wantsModel && lastSource !== undefined ? { model: lastSource } : {}),
    };
}

function addUsageRow(
    rows: readonly SessionModelUsageRow[],
    provider: string,
    model: string,
    usage: ModelUsage,
    durationMs: number,
): SessionModelUsageRow[] {
    const next = [...rows];
    const index = next.findIndex((row) =>
        row.provider === provider && row.model === model
    );
    const prior = next[index];
    const row: SessionModelUsageRow = {
        provider,
        model,
        calls: (prior?.calls ?? 0) + 1,
        durationMs: (prior?.durationMs ?? 0) + durationMs,
        inputTokens: (prior?.inputTokens ?? 0) + numeric(usage.inputTokens),
        outputTokens: (prior?.outputTokens ?? 0) + numeric(usage.outputTokens),
        cachedInputTokens: (prior?.cachedInputTokens ?? 0)
            + numeric(usage.cachedInputTokens),
        reasoningTokens: (prior?.reasoningTokens ?? 0)
            + numeric(usage.reasoningTokens),
        totalTokens: (prior?.totalTokens ?? 0) + numeric(usage.totalTokens),
        ...(usage.cost === undefined && prior?.cost === undefined
            ? {}
            : { cost: (prior?.cost ?? 0) + numeric(usage.cost) }),
        callsWithoutCost: (prior?.callsWithoutCost ?? 0)
            + (usage.cost === undefined ? 1 : 0),
    };
    if (index < 0) next.push(row);
    else next[index] = row;
    return next;
}

function numeric(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function latestFailureBySession(
    records: readonly ModelFailureRecord[],
): ReadonlyMap<string, ModelFailureRecord> {
    const latest = new Map<string, ModelFailureRecord>();
    for (const record of records) {
        const prior = latest.get(record.sessionId);
        if (prior === undefined || prior.at <= record.at) {
            latest.set(record.sessionId, record);
        }
    }
    return latest;
}
