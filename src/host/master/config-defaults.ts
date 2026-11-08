import type { VeraConfig } from "../../config.ts";
import type { AgentRegistry } from "../agent-registry.ts";

export function applyConfigDefaults(registry: AgentRegistry, config: VeraConfig): void {
    registry.defaultProvider = config.provider;
    registry.defaultModel = config.model;
    registry.defaultReasoningEffort = config.reasoning_effort;
    registry.defaultApprovalMode = config.approval_mode;
}
