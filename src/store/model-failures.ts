import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { veraRuntimeDirectory } from "../profile-paths.ts";
import type { AssistantMessage } from "../model/types.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";

/**
 * What went wrong, at the grain a user can act on. A provider serving a model
 * badly repeats one of these; the exact error text varies run to run and is
 * kept as a sample rather than as the identity of the failure.
 */
export type ModelFailureKind =
    | "no_visible_response"
    | "unavailable_tool_call"
    | "stream_error"
    | "provider_failure"
    | "other";

export interface ModelFailureRecord {
    readonly at: string;
    readonly provider: string;
    readonly model: string;
    readonly kind: ModelFailureKind;
    /** Sanitised failure text, kept as a sample of this signature. */
    readonly detail: string;
    readonly sessionId: string;
    readonly providerErrorType?: string;
    readonly providerName?: string;
    readonly statusCode?: number;
    /** Engine estimate for the refused request; this is not billed usage. */
    readonly requestTokens?: number;
    readonly requestTokensEstimated?: boolean;
    /** Provider-reported allowance at the instant the request was refused. */
    readonly allowance?: ProviderFailure["allowance"];
}

/**
 * The repeat unit. Provider and model both belong in it: the same model served
 * by two providers fails independently, and that difference is the one a user
 * can do something about.
 */
export function modelFailureSignature(
    record: Pick<ModelFailureRecord, "provider" | "model" | "kind">,
): string {
    return `${record.provider}/${record.model}::${record.kind}`;
}

export function modelFailureKind(
    message: AssistantMessage,
    failure?: ProviderFailure,
): ModelFailureKind {
    if (failure !== undefined) return "provider_failure";
    const detail = message.errorMessage ?? "";
    if (detail.startsWith("Model returned no visible response")) {
        return "no_visible_response";
    }
    if (detail.startsWith("Model returned a tool call when no tools")) {
        return "unavailable_tool_call";
    }
    return "other";
}

/** Records past this many are dropped oldest-first on the next append. */
const MAX_RECORDS = 500;

const MAX_DETAIL_LENGTH = 400;

export function defaultModelFailureLedgerPath(
    root: string = veraRuntimeDirectory(),
): string {
    return join(root, "failures", "ledger.jsonl");
}

/**
 * Append-only record of every model failure this machine has seen, across
 * sessions and restarts. Writes are synchronous so a client reading the ledger
 * to decide whether a failure is a repeat sees the failure that just happened.
 */
export class ModelFailureLedger {
    readonly path: string;
    private prepared = false;

    constructor(path: string = defaultModelFailureLedgerPath()) {
        this.path = path;
    }

    record(record: ModelFailureRecord): void {
        if (!this.prepared) {
            const directory = dirname(this.path);
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            chmodSync(directory, 0o700);
            this.prepared = true;
        }
        appendFileSync(
            this.path,
            `${JSON.stringify({
                ...record,
                detail: record.detail.slice(0, MAX_DETAIL_LENGTH),
            })}\n`,
            { encoding: "utf8", mode: 0o600 },
        );
        this.trim();
    }

    private trim(): void {
        const lines = readLedgerLines(this.path);
        if (lines.length <= MAX_RECORDS) return;
        writeFileSync(
            this.path,
            `${lines.slice(lines.length - MAX_RECORDS).join("\n")}\n`,
            { encoding: "utf8", mode: 0o600 },
        );
    }
}

export interface ModelFailureSignatureSummary {
    readonly signature: string;
    readonly provider: string;
    readonly model: string;
    readonly kind: ModelFailureKind;
    readonly count: number;
    readonly firstSeenAt: string;
    readonly lastSeenAt: string;
    readonly lastDetail: string;
    /** Distinct sessions this signature has appeared in. */
    readonly sessions: number;
    /** Latest refused request estimate; never presented as billed usage. */
    readonly lastRequestTokens?: number;
    readonly lastRequestTokensEstimated?: boolean;
    readonly lastAllowance?: ProviderFailure["allowance"];
}

export interface ModelFailureSummary {
    readonly total: number;
    readonly signatures: readonly ModelFailureSignatureSummary[];
}

export function readModelFailures(
    path: string = defaultModelFailureLedgerPath(),
): readonly ModelFailureRecord[] {
    return readLedgerLines(path).flatMap((line) => {
        try {
            const parsed = JSON.parse(line) as ModelFailureRecord;
            return typeof parsed?.provider === "string"
                    && typeof parsed?.model === "string"
                ? [parsed]
                : [];
        } catch {
            return [];
        }
    });
}

/** Signatures most repeated first, so the worst offender reads first. */
export function summariseModelFailures(
    records: readonly ModelFailureRecord[],
): ModelFailureSummary {
    const bySignature = new Map<string, {
        readonly record: ModelFailureRecord;
        count: number;
        firstSeenAt: string;
        lastSeenAt: string;
        lastDetail: string;
        lastRecord: ModelFailureRecord;
        readonly sessions: Set<string>;
    }>();
    for (const record of records) {
        const signature = modelFailureSignature(record);
        const existing = bySignature.get(signature);
        if (existing === undefined) {
            bySignature.set(signature, {
                record,
                count: 1,
                firstSeenAt: record.at,
                lastSeenAt: record.at,
                lastDetail: record.detail,
                lastRecord: record,
                sessions: new Set([record.sessionId]),
            });
            continue;
        }
        existing.count += 1;
        existing.lastSeenAt = record.at;
        existing.lastDetail = record.detail;
        existing.lastRecord = record;
        existing.sessions.add(record.sessionId);
    }
    const signatures = [...bySignature.entries()]
        .map(([signature, entry]) => ({
            signature,
            provider: entry.record.provider,
            model: entry.record.model,
            kind: entry.record.kind,
            count: entry.count,
            firstSeenAt: entry.firstSeenAt,
            lastSeenAt: entry.lastSeenAt,
            lastDetail: entry.lastDetail,
            sessions: entry.sessions.size,
            ...(entry.lastRecord.requestTokens === undefined
                ? {}
                : { lastRequestTokens: entry.lastRecord.requestTokens }),
            ...(entry.lastRecord.requestTokensEstimated === undefined
                ? {}
                : {
                    lastRequestTokensEstimated:
                        entry.lastRecord.requestTokensEstimated,
                }),
            ...(entry.lastRecord.allowance === undefined
                ? {}
                : { lastAllowance: entry.lastRecord.allowance }),
        }))
        .sort((left, right) =>
            right.count - left.count
            || right.lastSeenAt.localeCompare(left.lastSeenAt)
        );
    return { total: records.length, signatures };
}

export function countModelFailureSignature(
    records: readonly ModelFailureRecord[],
    signature: string,
): number {
    return records.filter((record) => modelFailureSignature(record) === signature)
        .length;
}

/** Below this a failure is noise; at it, a pattern is worth naming once. */
export const MODEL_FAILURE_NUDGE_THRESHOLD = 2;

const LATEST_FAILURE_WINDOW_MS = 30_000;

export interface ModelFailureNudge {
    readonly signature: string;
    readonly text: string;
}

/**
 * The line to show after a failure that has now happened more than once.
 * Names what repeated and where to look, and stops there: which model to run
 * instead is not Vera's call to make for someone.
 *
 * Returns nothing for a first occurrence, or for a signature already raised,
 * so a persistently broken model is mentioned once rather than every turn.
 */
export function modelFailureNudge(
    records: readonly ModelFailureRecord[],
    raised: ReadonlySet<string>,
    now: Date = new Date(),
): ModelFailureNudge | undefined {
    const latest = records.at(-1);
    if (latest === undefined) return undefined;
    // The failure on screen has to be the one the ledger just recorded. An
    // older entry means this failure was not a model's fault and was never
    // recorded, so the pattern being reported is not the one being seen.
    const age = now.getTime() - new Date(latest.at).getTime();
    if (!Number.isFinite(age) || age < 0 || age > LATEST_FAILURE_WINDOW_MS) {
        return undefined;
    }
    const signature = modelFailureSignature(latest);
    if (raised.has(signature)) return undefined;
    const count = countModelFailureSignature(records, signature);
    if (count < MODEL_FAILURE_NUDGE_THRESHOLD) return undefined;
    return {
        signature,
        text: `${latest.provider}/${latest.model} has failed this way`
            + ` ${count} times. /diagnostics lists every model failure;`
            + ` otherwise try another model.`,
    };
}

function readLedgerLines(path: string): string[] {
    if (!existsSync(path)) return [];
    try {
        return readFileSync(path, "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0);
    } catch {
        return [];
    }
}
