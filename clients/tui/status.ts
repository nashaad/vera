import { homedir } from "node:os";

import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import type { ContextMeasurement } from "../../src/engine/context-measurement.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import type { TuiEffortSubstitution } from "./state.ts";
import { findProvider } from "../../src/providers/registry.ts";

export function renderTuiStatusDetailsLine(
    settings: ModelTurnSettings | undefined,
    approvalMode: ApprovalMode | undefined,
    context: ContextMeasurement | undefined,
    workspace: string,
    runningBackgroundAgents = 0,
    substitution: TuiEffortSubstitution | undefined = undefined,
): string {
    const providerLabel = settings?.provider === undefined
        ? undefined
        : findProvider(settings.provider)?.shortLabel;
    const model = settings?.model === undefined
        ? "loading"
        : providerLabel === undefined
            ? settings.model
            : `${providerLabel}/${settings.model}`;
    const requested = settings?.reasoningEffort ?? "default";
    // Requested → effective, and only while the evidence covers the model and
    // the level in effect. The setting itself is untouched: the arrow is what
    // says the two disagree, rather than the dial quietly moving.
    const substituted = substitution !== undefined
        && settings?.model === substitution.model
        && requested === substitution.requested;
    const thinking = settings === undefined
        ? "loading"
        : substituted
            ? `${requested} → ${substitution!.effective ?? "none"}`
            : requested;
    const permissions = approvalMode === "full_access"
        ? "FULL ACCESS · RED ZONE"
        : approvalMode === "auto"
            ? "auto"
            : approvalMode ?? "permissions loading";
    const usage = renderContextUsage(context);
    const background = runningBackgroundAgents === 0
        ? ""
        : `${runningBackgroundAgents} async subagent${
            runningBackgroundAgents === 1 ? "" : "s"
        } running · `;
    return `${background}${model} · reasoning ${thinking} · ${compactWorkspace(workspace)} · ${permissions}${usage}`;
}

export function countRunningBackgroundAgents(
    agents: readonly RegisteredAgentSummary[],
): number {
    // Running, not merely present and not merely live: every background
    // session the host restored at startup is present, and one being read
    // through an attachment is live, but neither is doing anything.
    return agents.filter((agent) =>
        agent.kind === "background"
        && (agent.status === "working" || agent.status === "waiting")
    ).length;
}

export function renderBackgroundAgentNames(
    agents: readonly RegisteredAgentSummary[],
    parentId: string | undefined,
): string {
    if (parentId === undefined) return "";
    return agents
        .filter((agent) =>
            agent.kind === "background"
            && agent.parent_id === parentId
            && (agent.status === "working" || agent.status === "waiting")
        )
        .map((agent) => `* ${agent.title ?? agent.id}`)
        .join("\n");
}

function compactWorkspace(workspace: string): string {
    const home = homedir();
    return workspace === home
        ? "~"
        : workspace.startsWith(`${home}/`)
            ? `~/${workspace.slice(home.length + 1)}`
            : workspace;
}

/**
 * Absent until the engine has measured something. A session that has not sent
 * a request has no honest percentage to show: its prompt and tool definitions
 * already occupy the window, so "0%" would be a number nobody measured.
 *
 * The tilde is the estimate label. Vera counts characters until a provider
 * reports its own total, and a percentage that hides which of the two it is
 * reads as precise when it is not.
 */
function renderContextUsage(context: ContextMeasurement | undefined): string {
    if (context?.capacity === undefined) return "";
    const percent = Math.min(
        100,
        Math.round(context.tokens / context.capacity * 100),
    );
    return ` · ctx ${context.estimated ? "~" : ""}${percent}%`;
}
