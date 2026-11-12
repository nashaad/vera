import type { SessionRow } from "../protocol/sessions.ts";
import type { AgentCatalogReply, CatalogReply, SkillInfo, SourceInfo } from "./wire.ts";

// Customize reads catalogs through one session's watch connection, since the host has no catalog
// request of its own. The ids tie each reply to this read.
export interface ProbeIds {
    readonly skills: string;
    readonly agents: string;
    readonly sources: string;
}

export type ProbePhase = "idle" | "loading" | "ready" | "failed";

export interface ProbeState {
    readonly phase: ProbePhase;
    readonly agentId?: string;
    readonly skills?: readonly SkillInfo[];
    readonly agents?: AgentCatalogReply;
    readonly sources?: readonly SourceInfo[];
    readonly warnings: readonly string[];
    readonly error?: string;
}

export const IDLE_PROBE: ProbeState = { phase: "idle", warnings: [] };

export function probeIds(stamp: string): ProbeIds {
    return { skills: `customize-skills-${stamp}`, agents: `customize-agents-${stamp}`, sources: `customize-sources-${stamp}` };
}

export function startProbe(agentId: string): ProbeState {
    return { phase: "loading", agentId, warnings: [] };
}

export function probeFailed(state: ProbeState, error: string): ProbeState {
    return state.phase === "ready" ? state : { ...state, phase: "failed", error };
}

// Replies to other reads, and replies after the read ended, are ignored.
export function reduceProbe(state: ProbeState, ids: ProbeIds, reply: CatalogReply): ProbeState {
    if (state.phase !== "loading") return state;
    let next = state;
    if (reply.type === "skills" && reply.requestId === ids.skills) {
        next = { ...state, skills: reply.skills, warnings: [...state.warnings, ...reply.warnings] };
    } else if (reply.type === "agents" && reply.requestId === ids.agents) {
        next = { ...state, agents: reply, warnings: [...state.warnings, ...reply.notices] };
    } else if (reply.type === "sources" && reply.requestId === ids.sources) {
        next = { ...state, sources: reply.sources, warnings: [...state.warnings, ...reply.warnings] };
    }
    const complete = next.skills !== undefined && next.agents !== undefined && next.sources !== undefined;
    return complete ? { ...next, phase: "ready" } : next;
}

// The session to read through: a top-level session in the folder (any folder when none is
// given), live ones first since reading a parked one starts it again, then the newest.
export function probeTarget(rows: readonly SessionRow[], folder?: string): SessionRow | undefined {
    let best: SessionRow | undefined;
    for (const row of rows) {
        if (row.parentId !== undefined || row.workspace.length === 0) continue;
        if (folder !== undefined && row.workspace !== folder) continue;
        if (best === undefined || better(row, best)) best = row;
    }
    return best;
}

function better(row: SessionRow, than: SessionRow): boolean {
    if (row.live !== than.live) return row.live;
    return (row.updatedAt ?? -1) > (than.updatedAt ?? -1);
}
