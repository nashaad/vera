import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";

export interface ResolvedAgentId {
    readonly status: "resolved";
    readonly id: string;
    readonly label: string;
}

export interface AmbiguousAgentId {
    readonly status: "ambiguous";
    readonly candidates: readonly string[];
}

export type AgentIdResolution = ResolvedAgentId | AmbiguousAgentId;

export function resolveAgentIdentifier(
    input: string,
    agents: readonly RegisteredAgentSummary[],
): AgentIdResolution {
    const exactId = agents.find((agent) => agent.id === input);
    if (exactId !== undefined) {
        return resolved(exactId);
    }
    const byName = agents.filter((agent) => agent.name === input);
    if (byName.length === 1 && byName[0] !== undefined) {
        return resolved(byName[0]);
    }
    if (byName.length > 1) {
        return { status: "ambiguous", candidates: byName.map(candidateLabel) };
    }
    const byPrefix = agents.filter((agent) => agent.id.startsWith(input));
    if (byPrefix.length === 1 && byPrefix[0] !== undefined) {
        return resolved(byPrefix[0]);
    }
    if (byPrefix.length > 1) {
        return { status: "ambiguous", candidates: byPrefix.map(candidateLabel) };
    }
    return { status: "resolved", id: input, label: input };
}

function resolved(agent: RegisteredAgentSummary): ResolvedAgentId {
    return { status: "resolved", id: agent.id, label: agent.name ?? agent.id };
}

function candidateLabel(agent: RegisteredAgentSummary): string {
    return agent.name === undefined ? agent.id : `${agent.name} (${agent.id})`;
}
