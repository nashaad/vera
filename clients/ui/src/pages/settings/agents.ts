import type { AgentInfo, AgentScope } from "../../customize/wire.ts";

export function scopeLabel(scope: AgentScope): string {
    if (scope === "project") return "This folder";
    if (scope === "user") return "Your home";
    return "Extension";
}

// The scope, then the default model and effort when the agent sets them.
export function agentMeta(agent: AgentInfo): string {
    const parts: string[] = [scopeLabel(agent.scope)];
    if (agent.defaultModel !== undefined && agent.defaultModel.length > 0) parts.push(agent.defaultModel);
    if (agent.defaultEffort !== undefined && agent.defaultEffort.length > 0) parts.push(`effort ${agent.defaultEffort}`);
    return parts.join(" · ");
}
