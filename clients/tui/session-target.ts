import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";

export interface CreateTuiTarget {
    readonly type: "create";
    readonly workspace: string;
}

export interface AttachTuiTarget {
    readonly type: "attach";
    readonly agentId: string;
}

export interface ResumeTuiTarget {
    readonly type: "resume";
    readonly sessionPath: string;
}

export type TuiStartTarget =
    | CreateTuiTarget
    | AttachTuiTarget
    | ResumeTuiTarget;

export function resolveResumeTarget(
    agents: readonly RegisteredAgentSummary[],
    selector: string,
): AttachTuiTarget | ResumeTuiTarget {
    const exact = agents.find((agent) => agent.id === selector);
    return exact === undefined
        ? { type: "resume", sessionPath: selector }
        : { type: "attach", agentId: exact.id };
}
