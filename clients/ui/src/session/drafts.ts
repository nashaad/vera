// Text handed to a session's composer to edit, such as the prompt a rewind or fork gave back.
// Keyed by agent id; take removes the entry so the text lands once.

const MAX_DRAFTS = 16;

const drafts = new Map<string, string>();
const listeners = new Set<(agentId: string) => void>();

export function offerDraft(agentId: string, text: string): void {
    drafts.delete(agentId);
    drafts.set(agentId, text);
    const oldest = drafts.keys().next().value;
    if (drafts.size > MAX_DRAFTS && oldest !== undefined) drafts.delete(oldest);
    for (const listener of listeners) listener(agentId);
}

export function takeDraft(agentId: string): string | undefined {
    const text = drafts.get(agentId);
    drafts.delete(agentId);
    return text;
}

export function subscribeDrafts(listener: (agentId: string) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
