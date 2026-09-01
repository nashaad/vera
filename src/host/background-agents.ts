import type { RegisteredAgentSummary } from "./agent-registry.ts";

export interface BackgroundAgentsSnapshot {
    readonly running: number;
    readonly children: readonly string[];
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
