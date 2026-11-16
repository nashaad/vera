import { AgentBranchCommitError, AgentBranchError, branchAgentThroughHost, syncAgentContextThroughHost } from "../../../src/host/agent-start-client.ts";
import { decideSidekickSync, sidekickHostBranchOptions } from "../../../src/sidekick/branch.ts";
import type { HostRequestFailure, OpenSidekickResult, SyncSidekickResult } from "../../ui/src/protocol/bridge.ts";

const NOT_RUNNING: HostRequestFailure = { ok: false, reason: "The host is not running." };

const OPEN_WORDS: Readonly<Record<AgentBranchError["reason"], string>> = {
    unsupported_options: "This host cannot open a side chat.",
    source_unavailable: "That session is not available for a side chat.",
    failed: "Vera could not open a side chat.",
};

const SYNC_FAILED = "Vera could not catch the side chat up with the conversation.";

// Branches the whole conversation into the sidekick the terminal's /btw opens: same options, same hidden boundary.
export async function openSidekick(socketPath: string | undefined, primaryAgentId: string): Promise<OpenSidekickResult> {
    if (socketPath === undefined) return NOT_RUNNING;
    try {
        const branched = await branchAgentThroughHost(socketPath, primaryAgentId, "at", undefined, sidekickHostBranchOptions());
        return { ok: true, agentId: branched.id };
    } catch (error) {
        // The host made the branch but did not confirm it; the terminal attaches to it anyway.
        if (error instanceof AgentBranchCommitError) return { ok: true, agentId: error.agentId };
        if (error instanceof AgentBranchError) return { ok: false, reason: OPEN_WORDS[error.reason] };
        return { ok: false, reason: OPEN_WORDS.failed };
    }
}

// Catches the sidekick up with the primary's finished turns. `decision` is the shared module's reading of the host's outcome.
export async function syncSidekick(socketPath: string | undefined, sidekickAgentId: string): Promise<SyncSidekickResult> {
    if (socketPath === undefined) return NOT_RUNNING;
    let outcome: Awaited<ReturnType<typeof syncAgentContextThroughHost>>["outcome"];
    try {
        outcome = (await syncAgentContextThroughHost(socketPath, sidekickAgentId)).outcome;
    } catch {
        return { ok: false, reason: SYNC_FAILED };
    }
    try {
        return { ok: true, decision: decideSidekickSync(outcome) };
    } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : SYNC_FAILED };
    }
}
