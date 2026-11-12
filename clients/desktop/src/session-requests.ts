import { closeAgentThroughHost } from "../../../src/host/agent-close-client.ts";
import { AgentBranchCommitError, AgentBranchError, branchAgentThroughHost } from "../../../src/host/agent-start-client.ts";
import type { BranchSessionResult, CloseSessionResult, HostRequestFailure } from "../../ui/src/protocol/bridge.ts";

const MAX_ID_CHARS = 256;

const NOT_RUNNING: HostRequestFailure = { ok: false, reason: "The host is not running." };

interface BranchWords extends Readonly<Record<AgentBranchError["reason"], string>> {
    // The host made the session but did not confirm it; it shows up in the session list.
    readonly unconfirmed: string;
}

const FORK_WORDS: BranchWords = {
    unsupported_options: "This host cannot fork a session.",
    source_unavailable: "That session is not available to fork.",
    failed: "Vera could not fork the session.",
    unconfirmed: "The host did not confirm the fork.",
};

const CLONE_WORDS: BranchWords = {
    unsupported_options: "This host cannot clone a session.",
    source_unavailable: "That session is not available to clone.",
    failed: "Vera could not clone the session.",
    unconfirmed: "The host did not confirm the clone.",
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

export function branchSession(
    socketPath: string | undefined,
    agentId: string,
    boundaryId: string,
): Promise<BranchSessionResult> {
    return branch(socketPath, agentId, "before", boundaryId, FORK_WORDS);
}

// A copy of the whole conversation, as the terminal's /clone makes. The copy has no prompt to hand back.
export function cloneSession(socketPath: string | undefined, agentId: string): Promise<BranchSessionResult> {
    return branch(socketPath, agentId, "at", undefined, CLONE_WORDS);
}

async function branch(
    socketPath: string | undefined,
    agentId: string,
    position: "before" | "at",
    boundaryId: string | undefined,
    words: BranchWords,
): Promise<BranchSessionResult> {
    if (socketPath === undefined) return NOT_RUNNING;
    try {
        const branched = await branchAgentThroughHost(socketPath, agentId, position, boundaryId);
        const prompt = (branched.prompt?.content ?? [])
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n");
        return { ok: true, agentId: branched.id, workspace: branched.workspace, prompt };
    } catch (error) {
        if (error instanceof AgentBranchError) return { ok: false, reason: words[error.reason] };
        if (error instanceof AgentBranchCommitError) return { ok: false, reason: words.unconfirmed };
        return { ok: false, reason: words.failed };
    }
}

export async function closeSession(socketPath: string | undefined, agentId: string): Promise<CloseSessionResult> {
    if (socketPath === undefined) return NOT_RUNNING;
    const result = await closeAgentThroughHost(socketPath, agentId);
    if (result.status === "closed") return { ok: true, retained: result.sessionRetained };
    return { ok: false, reason: CLOSE_REASONS[result.reason] ?? CLOSE_REASONS.failed! };
}
