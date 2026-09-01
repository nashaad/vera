import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { veraRuntimeDirectory } from "../profile-paths.ts";
import type { AssistantMessage } from "../model/types.ts";
import type { ProviderFailure } from "../model/provider-failure.ts";
import { readRegularFileTextSync } from "./regular-file.ts";

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
    readonly detail: string;
    readonly sessionId: string;
    readonly providerErrorType?: string;
    readonly providerName?: string;
    readonly statusCode?: number;
    readonly requestTokens?: number;
    readonly requestTokensEstimated?: boolean;
    readonly allowance?: ProviderFailure["allowance"];
}

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

const MAX_RECORDS = 500;

const MAX_DETAIL_LENGTH = 400;

export function defaultModelFailureLedgerPath(
    root: string = veraRuntimeDirectory(),
): string {
    return join(root, "failures", "ledger.jsonl");
}

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
    readonly sessions: number;
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

export const MODEL_FAILURE_NUDGE_THRESHOLD = 2;

const LATEST_FAILURE_WINDOW_MS = 30_000;

export interface ModelFailureNudge {
    readonly signature: string;
    readonly text: string;
}

export function modelFailureNudge(
    records: readonly ModelFailureRecord[],
    raised: ReadonlySet<string>,
    now: Date = new Date(),
): ModelFailureNudge | undefined {
    const latest = records.at(-1);
    if (latest === undefined) return undefined;
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
        return readRegularFileTextSync(path)
            .split("\n")
            .filter((line) => line.trim().length > 0);
    } catch {
        return [];
    }
}
