/** A user prompt that has been accepted but has not started yet. */
export interface PromptQueueItem {
    readonly content: string;
    readonly attachmentIds?: readonly string[];
    readonly state: "held" | "released";
}

/**
 * The live session's prompt queue as clients should present it.
 *
 * `draining` stays true while a released prompt is active, even when there are
 * no more released items in this snapshot. That distinction lets a client say
 * the queue is sending rather than merely waiting.
 */
export interface PromptQueueState {
    readonly prompts: readonly PromptQueueItem[];
    readonly draining: boolean;
}
