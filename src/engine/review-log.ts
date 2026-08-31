import {
    appendFileSync,
    chmodSync,
    closeSync,
    fchmodSync,
    mkdirSync,
    openSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelUsage } from "../model/types.ts";
import { veraRuntimeDirectory } from "../profile-paths.ts";

export type ReviewLogTier = "single" | "fast" | "strong";

export type ReviewLogOutcome =
    | "decided"
    | "unreadable"
    | "failed"
    | "cancelled";

export interface ReviewLogEntry {
    readonly tier: ReviewLogTier;
    readonly outcome: ReviewLogOutcome;
    readonly tool: string;
    readonly toolInput: unknown;
    readonly workspace: string;
    readonly routingReason: string;
    readonly provider?: string;
    readonly model: string;
    readonly reasoningEffort?: string;
    readonly systemPrompt: string;
    readonly prompt: string;
    readonly transcriptTurns: number;
    readonly continuedConversation: boolean;
    readonly responseText?: string;
    readonly stopReason?: string;
    readonly decision?: string;
    readonly decisionReason?: string;
    readonly riskLevel?: string;
    readonly userAuthorization?: string;
    readonly latencyMs: number;
    readonly error?: string;
    readonly usage?: ModelUsage;
    readonly sessionId?: string;
}

export type ReviewLog = (entry: ReviewLogEntry) => void;

export function defaultReviewLogPath(): string {
    return join(veraRuntimeDirectory(), "logs", "reviewer.jsonl");
}

export interface ReviewLoggerOptions {
    readonly path?: string;
    readonly now?: () => Date;
}

/**
 * Append-only JSONL record of every reviewer model call, one line per call, so
 * a two-tier review writes two. It holds the exact prompt sent and the exact
 * text returned, because a decision cannot be judged after the fact from its
 * verdict alone. That makes the file as sensitive as the transcript it quotes:
 * it is written 0600 under a 0700 directory and never leaves the machine.
 * A failed write is swallowed, so diagnostics never block a review.
 */
export function createReviewLogger(options: ReviewLoggerOptions = {}): ReviewLog {
    const path = options.path ?? defaultReviewLogPath();
    const now = options.now ?? (() => new Date());
    let prepared = false;
    return (entry) => {
        try {
            if (!prepared) {
                prepareReviewLog(path);
                prepared = true;
            }
            appendFileSync(
                path,
                `${JSON.stringify({
                    timestamp: now().toISOString(),
                    type: "tool_review",
                    ...entry,
                })}\n`,
                { encoding: "utf8", mode: 0o600 },
            );
        } catch {
            // Nothing: an unwritable log loses the record, not the review.
        }
    };
}

function prepareReviewLog(path: string): void {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);

    const file = openSync(path, "a", 0o600);
    try {
        fchmodSync(file, 0o600);
    } finally {
        closeSync(file);
    }
}
