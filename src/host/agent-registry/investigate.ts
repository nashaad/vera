import type { VeraInvestigateResult } from "../../sdk/extensions.ts";
import type { AgentRegistry } from "../agent-registry.ts";

export const INVESTIGATE_AGENT = "explorer";

export interface SessionInvestigateCall {
    readonly question: string;
    readonly timeoutMs: number;
}

/**
 * Runs the explorer agent as a hidden child of an open session, on
 * `readonly`, and waits for its final reply.
 */
export async function investigateSession(
    reg: AgentRegistry,
    id: string,
    call: SessionInvestigateCall,
    signal: AbortSignal,
): Promise<VeraInvestigateResult> {
    const entry = reg.agents.get(id);
    if (
        entry === undefined
        || entry.ephemeral
        || entry.agent.closed
        || entry.agent.failed
    ) {
        throw new Error(`Session ${id} is not open`);
    }
    const spawn = entry.spawnSubagent;
    if (spawn === undefined) {
        throw new Error(`Session ${id} cannot start agents`);
    }
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(call.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const ended = (): VeraInvestigateResult | undefined => {
        if (signal.aborted) return { outcome: "cancelled", text: "" };
        if (timeout.aborted) return { outcome: "timed_out", text: "" };
        return undefined;
    };
    try {
        const outcome = await spawn(
            {
                type: "spawn_subagent",
                agent: INVESTIGATE_AGENT,
                description: call.question,
            },
            combined,
            {
                sessionId: id,
                // Never the session's own mode: an extension cannot widen what the run may do.
                approvalMode: "readonly",
                ...(entry.modelSettings.provider === undefined
                    ? {}
                    : { provider: entry.modelSettings.provider }),
                model: entry.modelSettings.model,
                ...(entry.modelSettings.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: entry.modelSettings.reasoningEffort }),
                ...(entry.selectedAgent === undefined
                    ? {}
                    : { selectedAgent: entry.selectedAgent }),
            },
        );
        if (!outcome.ok) {
            return ended() ?? { outcome: "failed", text: "", error: outcome.error };
        }
        const run = { runSessionId: outcome.result.sessionId };
        const stopped = ended();
        if (stopped !== undefined) return { ...stopped, ...run };
        if (outcome.result.isError) {
            return { outcome: "failed", text: "", error: outcome.result.text, ...run };
        }
        return { outcome: "answered", text: outcome.result.text, ...run };
    } catch (error) {
        const stopped = ended();
        if (stopped !== undefined) return stopped;
        return {
            outcome: "failed",
            text: "",
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
