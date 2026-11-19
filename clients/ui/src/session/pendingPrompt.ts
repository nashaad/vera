// A prompt typed on New Chat, held until the new session's watch attaches.
// Keyed by agent id; take removes the entry so the prompt is sent once.

import type { DraftCaptureRecipient } from "../composer/draft-capture-recipient.ts";
import type { DraftModel } from "../models/useDraftModels.ts";

export interface PendingPrompt {
    readonly text: string;
    readonly captureRecipient?: DraftCaptureRecipient;
    // Image files to attach before the prompt goes out.
    readonly images: readonly string[];
    readonly files?: readonly string[];
    // The agent the session is asked to switch to first; the prompt waits for the session to confirm it.
    readonly agent?: string;
    // Applied to the session before the prompt goes out.
    readonly model?: DraftModel;
    readonly slashCommand?: boolean;
}

const pending = new Map<string, PendingPrompt>();

export function setPendingPrompt(agentId: string, prompt: PendingPrompt): void {
    pending.set(agentId, prompt);
}

export function hasPendingPrompt(agentId: string): boolean {
    return pending.has(agentId);
}

export function takePendingPrompt(agentId: string): PendingPrompt | undefined {
    const prompt = pending.get(agentId);
    pending.delete(agentId);
    return prompt;
}
