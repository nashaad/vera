export interface PromptQueueItem {
    readonly content: string;
    readonly attachmentIds?: readonly string[];
    readonly state: "held" | "released";
}

export interface PromptQueueState {
    readonly prompts: readonly PromptQueueItem[];
    readonly draining: boolean;
}
