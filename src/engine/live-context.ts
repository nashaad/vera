import type { ModelMessage } from "../model/types.ts";

export interface LiveMessageSource {
    messages(): readonly ModelMessage[];
}

// Keeps the loop to the store's live branch: what a compaction left behind is read from disk when needed.
// Acts only when the held tail is the live branch itself, so a message the store does not hold yet stays.
export function dropMessagesBehindLiveContext(
    messages: ModelMessage[],
    store: LiveMessageSource,
): void {
    const live = store.messages();
    const behind = messages.length - live.length;
    if (live.length === 0 || behind <= 0) return;
    if (live.every((message, index) => messages[behind + index] === message)) messages.splice(0, behind);
}
