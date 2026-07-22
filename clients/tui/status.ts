import { homedir } from "node:os";

import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import type { ApprovalMode } from "../../src/engine/permissions.ts";

export function renderTuiStatusLine(
    settings: ModelTurnSettings | undefined,
    approvalMode: ApprovalMode | undefined,
    contextInputTokens: number | undefined,
    workspace: string,
    message: string,
): string {
    const model = settings?.model ?? "loading";
    const thinking = settings === undefined
        ? "loading"
        : settings.reasoningEffort ?? "default";
    const permissions = approvalMode === "full_access"
        ? "FULL ACCESS · RED ZONE"
        : approvalMode === "approve_for_me"
            ? "approve for me"
            : approvalMode ?? "permissions loading";
    const context = renderContextUsage(contextInputTokens, settings?.contextWindow);
    return `${message} · ${model} · reasoning ${thinking} · ${compactWorkspace(workspace)} · ${permissions}${context}`;
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
