import { createHash } from "node:crypto";

import type { ModelInputMessage } from "../model/types.ts";

// The stored messages behind a projected history. A new compaction or a
// rewind changes this, and the history is then allowed to change with it.
export interface HistoryLineage {
    readonly compactionId?: string;
    readonly messageIds: readonly string[];
}

export interface PromptHistoryChange {
    readonly index: number;
    readonly role: ModelInputMessage["role"];
    readonly kind: "content_changed" | "removed";
}

export interface PromptHistoryDrift {
    readonly cause: "unexplained";
    readonly changes: readonly PromptHistoryChange[];
}

interface ObservedMessage {
    readonly role: ModelInputMessage["role"];
    readonly toolCallId?: string;
    readonly sha256: string;
}

export class PromptHistoryTracker {
    private previous: readonly ObservedMessage[] | undefined;
    private previousLineage: HistoryLineage | undefined;
    private readonly hashes = new WeakMap<object, string>();

    observe(
        messages: readonly ModelInputMessage[],
        lineage?: HistoryLineage,
    ): PromptHistoryDrift | undefined {
        const current = messages.map((message) => this.describe(message));
        const previous = this.previous;
        const previousLineage = this.previousLineage;
        this.previous = current;
        this.previousLineage = lineage;
        if (previous === undefined || lineageMoved(previousLineage, lineage)) {
            return undefined;
        }

        const changes: PromptHistoryChange[] = [];
        for (let index = 0; index < previous.length; index += 1) {
            const before = previous[index]!;
            const after = current[index];
            if (after === undefined) {
                changes.push({ index, role: before.role, kind: "removed" });
                continue;
            }
            if (before.sha256 === after.sha256) continue;
            // Aging and the result budget rewrite a tool result in place; that is expected.
            if (
                before.role === "tool_result"
                && after.role === "tool_result"
                && before.toolCallId === after.toolCallId
            ) {
                continue;
            }
            changes.push({ index, role: after.role, kind: "content_changed" });
        }
        return changes.length === 0
            ? undefined
            : { cause: "unexplained", changes };
    }

    private describe(message: ModelInputMessage): ObservedMessage {
        let sha256 = this.hashes.get(message);
        if (sha256 === undefined) {
            sha256 = hashMessage(message);
            this.hashes.set(message, sha256);
        }
        return {
            role: message.role,
            ...(message.role === "tool_result"
                ? { toolCallId: message.toolCallId }
                : {}),
            sha256,
        };
    }
}

function lineageMoved(
    previous: HistoryLineage | undefined,
    current: HistoryLineage | undefined,
): boolean {
    if (previous === undefined || current === undefined) {
        return previous !== current;
    }
    if (previous.compactionId !== current.compactionId) return true;
    if (previous.messageIds.length > current.messageIds.length) return true;
    return previous.messageIds.some((id, index) => current.messageIds[index] !== id);
}

function hashMessage(message: ModelInputMessage): string {
    const hash = createHash("sha256");
    // Reads the raw value: a Buffer's toJSON runs before the replacer and spells out every byte.
    hash.update(JSON.stringify(message, function (
        this: Record<string, unknown>,
        key: string,
        value: unknown,
    ) {
        const raw = this[key];
        return raw instanceof Uint8Array
            ? createHash("sha256").update(raw).digest("hex")
            : value;
    }));
    return hash.digest("hex");
}
