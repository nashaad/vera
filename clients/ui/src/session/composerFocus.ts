// A request to put the keyboard in a session's reply field, kept until that session's composer is mounted.
const pending = new Set<string>();
const listeners = new Map<string, Set<() => void>>();

export function requestComposerFocus(agentId: string): void {
    const set = listeners.get(agentId);
    if (set !== undefined && set.size > 0) {
        for (const listener of set) listener();
        return;
    }
    pending.add(agentId);
}

export function subscribeComposerFocus(agentId: string, listener: () => void): () => void {
    let set = listeners.get(agentId);
    if (set === undefined) {
        set = new Set();
        listeners.set(agentId, set);
    }
    set.add(listener);
    if (pending.delete(agentId)) listener();
    return () => {
        set?.delete(listener);
        if (set?.size === 0) listeners.delete(agentId);
    };
}
