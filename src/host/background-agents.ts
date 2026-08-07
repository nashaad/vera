import type { RegisteredAgentSummary } from "./agent-registry.ts";

/**
 * What an attached client is told about background work, and nothing else.
 *
 * The whole agent list used to be pulled once a second to derive these three
 * facts. They are pushed instead, so the wire carries the derived facts rather
 * than the list they came from: a client that wants the list still asks for it.
 */
export interface BackgroundAgentsSnapshot {
    /** Background agents working or waiting anywhere in this host. */
    readonly running: number;
    /**
     * Display names of the running background children of the attached agent,
     * newest listing order, already resolved to a title or an id.
     */
    readonly children: readonly string[];
    /** Whether the attached agent is itself a background child of a session. */
    readonly has_parent: boolean;
}

export const NO_BACKGROUND_AGENTS: BackgroundAgentsSnapshot = {
    running: 0,
    children: [],
    has_parent: false,
};

export function backgroundAgentsSnapshot(
    agents: readonly RegisteredAgentSummary[],
    attachedAgentId: string,
): BackgroundAgentsSnapshot {
    // Running, not merely present and not merely live: every background
    // session the host restored at startup is present, and one being read
    // through an attachment is live, but neither is doing anything.
    const running = agents.filter(isRunningBackgroundAgent);
    return {
        running: running.length,
        children: running
            .filter((agent) => agent.parent_id === attachedAgentId)
            .map((agent) => agent.title ?? agent.id),
        has_parent: agents.some((agent) =>
            agent.id === attachedAgentId && agent.parent_id !== undefined
        ),
    };
}

export function sameBackgroundAgents(
    left: BackgroundAgentsSnapshot,
    right: BackgroundAgentsSnapshot,
): boolean {
    return left.running === right.running
        && left.has_parent === right.has_parent
        && left.children.length === right.children.length
        && left.children.every((name, index) => name === right.children[index]);
}

function isRunningBackgroundAgent(agent: RegisteredAgentSummary): boolean {
    return agent.kind === "background"
        && (agent.status === "working" || agent.status === "waiting");
}
