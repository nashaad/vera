import { closeAgentThroughHost } from "../../../src/host/agent-close-client.ts";
import { AgentBranchCommitError, AgentBranchError, branchAgentThroughHost } from "../../../src/host/agent-start-client.ts";
import type { BranchSessionResult, CloseSessionResult, HostRequestFailure } from "../../ui/src/protocol/bridge.ts";

const MAX_ID_CHARS = 256;

const NOT_RUNNING: HostRequestFailure = { ok: false, reason: "The host is not running." };

const BRANCH_REASONS: Readonly<Record<AgentBranchError["reason"], string>> = {
    unsupported_options: "This host cannot fork a session.",
    source_unavailable: "That session is not available to fork.",
    failed: "Vera could not fork the session.",
};

const CLOSE_REASONS: Readonly<Record<string, string>> = {
    not_found: "The host no longer has that session.",
    not_owned: "Another host owns that session.",
    busy: "That session is busy; try again in a moment.",
    failed: "Vera could not stop that session.",
};

export function idArgument(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_CHARS ? value : undefined;
}

export async function branchSession(
    socketPath: string | undefined,
    agentId: string,
    boundaryId: string,
): Promise<BranchSessionResult> {
    if (socketPath === undefined) return NOT_RUNNING;
    try {
        const branched = await branchAgentThroughHost(socketPath, agentId, "before", boundaryId);
        const prompt = (branched.prompt?.content ?? [])
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
        return { ok: true, agentId: branched.id, workspace: branched.workspace, prompt };
    } catch (error) {
        if (error instanceof AgentBranchError) return { ok: false, reason: BRANCH_REASONS[error.reason] };
        // The fork exists but the host did not confirm it; it shows up in the session list.
        if (error instanceof AgentBranchCommitError) return { ok: false, reason: "The host did not confirm the fork." };
        return { ok: false, reason: BRANCH_REASONS.failed };
    }
}

export async function closeSession(socketPath: string | undefined, agentId: string): Promise<CloseSessionResult> {
    if (socketPath === undefined) return NOT_RUNNING;
    const result = await closeAgentThroughHost(socketPath, agentId);
    if (result.status === "closed") return { ok: true, retained: result.sessionRetained };
    return { ok: false, reason: CLOSE_REASONS[result.reason] ?? CLOSE_REASONS.failed! };
}
