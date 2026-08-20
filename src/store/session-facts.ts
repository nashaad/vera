import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import type { ContextMeasurement } from "../engine/context-measurement.ts";
import { measureReportedUsage } from "../engine/context-measurement.ts";
import type { SessionModelUsage, SessionModelUsageRow } from "../engine/protocol.ts";
import type { ModelUsage } from "../model/types.ts";
import type { ModelFailureRecord } from "./model-failures.ts";

/**
 * The optional facts a session listing can carry. Each name is a separate
 * cost: `usage` and `context` read the session file, `failure` reads the
 * profile-wide ledger once for the whole page. Nothing is computed for a name
 * the caller did not ask for, and an absent field means "not requested or not
 * available", never zero.
 */
export type SessionFactName = "usage" | "context" | "failure" | "model";

export interface SessionModelSelection {
    readonly provider: string;
    readonly model: string;
    readonly effort?: string;
}

export interface SessionFacts {
    readonly usage?: SessionModelUsage;
    /**
     * The provider's own count for the most recent request, which is the only
     * honest answer to "how big is this session's context". Never a transcript
     * size and never a message-only estimate.
     */
    readonly context?: ContextMeasurement;
    readonly contextMeasuredAt?: string;
    readonly model?: SessionModelSelection;
    readonly failure?: ModelFailureRecord;
}

/** Resolves a model's context window, or undefined for one Vera has no entry for. */
export type ContextCapacityResolver = (
    provider: string,
    model: string,
) => number | undefined;

export interface ReadSessionFactsOptions {
    readonly include: readonly SessionFactName[];
    readonly capacity?: ContextCapacityResolver;
}

/**
 * Folds one session file into the facts a listing can show.
 *
 * Streams rather than reading whole: a long session is tens of megabytes and
 * the caller is drawing a page of them. Only assistant records are parsed;
 * tool results are the bulk of a transcript and carry nothing needed here.
 */
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
            // Cheap reject before the parse: assistant records are a minority
            // of the file and JSON.parse over every tool result is the cost
            // this scan exists to avoid.
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
        // A session that cannot be read contributes no facts. It still lists:
        // dropping the row would make an unreadable file look like a deleted
        // session.
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

/**
 * Adds one call to the per-provider/model totals. Mirrors the engine's own
 * session usage fold; the engine folds live messages, this folds the same
 * records back off disk.
 */
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

/**
 * The most recent failure per session, from the profile-wide ledger. One read
 * serves a whole page, so this never scales with the number of rows drawn.
 */
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
