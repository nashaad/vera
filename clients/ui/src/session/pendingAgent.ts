// An agent a new session starts on, held until its watch attaches. Keyed by agent id; take removes
// the entry so the choice is sent once.

const pending = new Map<string, string>();

export function setPendingAgent(agentId: string, name: string): void {
    pending.set(agentId, name);
}

export function takePendingAgent(agentId: string): string | undefined {
    const name = pending.get(agentId);
    pending.delete(agentId);
    return name;
}
