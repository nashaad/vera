import type { AgentInfo } from "../customize/wire.ts";
import { setPendingAgent } from "../session/pendingAgent.ts";
import { setPendingPrompt, type PendingPrompt } from "../session/pendingPrompt.ts";

// What the host says a session created in a folder, or a chat, would offer.
export interface NewSessionAgents {
    // The folder the list was read for; undefined for a chat.
    readonly folder: string | undefined;
    // The agent a session created there starts on.
    readonly startsOn: string;
    readonly agents: readonly AgentInfo[];
    readonly notices: readonly string[];
}

export interface PickOutcome {
    readonly pick: string | undefined;
    // Set when the pick was dropped because the list does not offer it.
    readonly notice?: string;
}

// The agent to switch a new session to once it attaches, or undefined when the session already starts on the pick.
export function agentToStart(pick: string | undefined, listing: NewSessionAgents | undefined): string | undefined {
    if (pick === undefined || listing === undefined) return undefined;
    return pick === listing.startsOn ? undefined : pick;
}

export function shownAgent(pick: string | undefined, listing: NewSessionAgents): string {
    return pick ?? listing.startsOn;
}

// Keeps a pick the list offers; otherwise falls back to the default and says so.
export function reconcilePick(pick: string | undefined, listing: NewSessionAgents): PickOutcome {
    if (pick === undefined || listing.agents.some((agent) => agent.name === pick)) return { pick };
    return { pick: undefined, notice: `The ${pick} agent is not offered here. This chat starts on ${listing.startsOn}.` };
}

// Holds the first prompt for the new session. A prompt with an agent also queues the switch, and waits for it to be confirmed.
export function holdFirstTurn(agentId: string, agent: string | undefined, prompt: PendingPrompt): void {
    if (agent !== undefined) setPendingAgent(agentId, agent);
    setPendingPrompt(agentId, agent === undefined ? prompt : { ...prompt, agent });
}
