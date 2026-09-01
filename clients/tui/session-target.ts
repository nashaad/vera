import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import type { StartupProfile } from "../../src/startup-profile.ts";

export interface CreateTuiTarget {
    readonly type: "create";
    readonly workspace: string;
    readonly startupProfile?: StartupProfile;
}

export interface AttachTuiTarget {
    readonly type: "attach";
    readonly agentId: string;
}

export interface ResumeTuiTarget {
    readonly type: "resume";
    readonly sessionPath: string;
}

export interface ContinueTuiTarget {
    readonly type: "continue";
}

export interface HomeTuiTarget {
    readonly type: "home";
    readonly workspace: string;
}

export type TuiStartTarget =
    | CreateTuiTarget
    | AttachTuiTarget
    | ContinueTuiTarget
    | HomeTuiTarget
    | ResumeTuiTarget;

export function resolveContinueTarget(
    agents: readonly RegisteredAgentSummary[],
    recentSessionId?: string,
): AttachTuiTarget {
    const interactive = agents.filter((agent) => agent.kind === "interactive");
    const recent = interactive.find((agent) => agent.id === recentSessionId);
    const latest = recent ?? interactive
        .toSorted((left, right) =>
            (right.updated_at ?? "").localeCompare(left.updated_at ?? "")
        )[0];
    if (latest === undefined) {
        throw new Error("No previous Vera session to continue");
    }
    return { type: "attach", agentId: latest.id };
}

export function renderResumeHint(agentId: string | undefined): string {
    return agentId === undefined
        ? ""
        : `\nTo continue this session, run: vera resume ${agentId}\n`;
}

export function resolveResumeTarget(
    agents: readonly RegisteredAgentSummary[],
    selector: string,
): AttachTuiTarget | ResumeTuiTarget {
    const exact = agents.find((agent) => agent.id === selector);
    return exact === undefined
        ? { type: "resume", sessionPath: selector }
        : { type: "attach", agentId: exact.id };
}
