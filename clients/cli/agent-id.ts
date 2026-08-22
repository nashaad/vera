import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";

export interface ResolvedAgentId {
    readonly status: "resolved";
    /** The full id every host request takes. */
    readonly id: string;
    /** What the listing shows for it, which is what the operator typed. */
    readonly label: string;
}

export interface AmbiguousAgentId {
    readonly status: "ambiguous";
    readonly candidates: readonly string[];
}

export type AgentIdResolution = ResolvedAgentId | AmbiguousAgentId;

/**
 * Turn what `vera ls` prints into the id the host answers to.
 *
 * The listing's AGENT column is the identity name when a session has one, so an
 * operator who copies a row hands us `slug:hex4`, which is not an id and does
 * not even pass the id character guard. A uuid prefix is accepted for the same
 * reason: nothing on screen is the whole uuid.
 *
 * An input that matches nothing is passed through unchanged rather than
 * refused here, so a stored session the live listing cannot see still resolves,
 * and an id nobody has ever used still reaches the host's `not_found`.
 */
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
