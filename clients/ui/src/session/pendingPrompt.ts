// A prompt typed on New Chat, held until the new session's watch attaches.
// Keyed by agent id; take removes the entry so the prompt is sent once.

import type { DraftModel } from "../models/useDraftModels.ts";

export interface PendingPrompt {
    readonly text: string;
    // Image files to attach before the prompt goes out.
    readonly images: readonly string[];
    // Applied to the session before the prompt goes out.
    readonly model?: DraftModel;
}

const pending = new Map<string, PendingPrompt>();

export function setPendingPrompt(agentId: string, prompt: PendingPrompt): void {
    pending.set(agentId, prompt);
}

export function takePendingPrompt(agentId: string): PendingPrompt | undefined {
    const prompt = pending.get(agentId);
    pending.delete(agentId);
    return prompt;
}
