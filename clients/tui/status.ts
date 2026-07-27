import { homedir } from "node:os";

import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";

export function renderTuiStatusDetailsLine(
    settings: ModelTurnSettings | undefined,
    approvalMode: ApprovalMode | undefined,
    contextInputTokens: number | undefined,
    workspace: string,
    runningBackgroundAgents = 0,
): string {
    const model = settings?.model ?? "loading";
    const thinking = settings === undefined
        ? "loading"
        : settings.reasoningEffort ?? "default";
    const permissions = approvalMode === "full_access"
        ? "FULL ACCESS · RED ZONE"
        : approvalMode === "auto"
            ? "auto"
            : approvalMode ?? "permissions loading";
    const context = renderContextUsage(contextInputTokens, settings?.contextWindow);
    const background = runningBackgroundAgents === 0
        ? ""
        : `${runningBackgroundAgents} background agent${
            runningBackgroundAgents === 1 ? "" : "s"
        } running · `;
    return `${background}${model} · reasoning ${thinking} · ${compactWorkspace(workspace)} · ${permissions}${context}`;
}

export function countRunningBackgroundAgents(
    agents: readonly RegisteredAgentSummary[],
): number {
    return agents.filter((agent) =>
        agent.kind === "background"
        && agent.status !== "completed"
        && agent.status !== "closed"
        && agent.status !== "failed"
    ).length;
}

function compactWorkspace(workspace: string): string {
    const home = homedir();
    return workspace === home
        ? "~"
        : workspace.startsWith(`${home}/`)
            ? `~/${workspace.slice(home.length + 1)}`
            : workspace;
}

function renderContextUsage(
    inputTokens: number | undefined,
    contextWindow: number | undefined,
): string {
    if (contextWindow === undefined) return "";
    const percent = Math.min(
        100,
        Math.round((inputTokens ?? 0) / contextWindow * 100),
    );
    return ` · ctx ${percent}%`;
}
