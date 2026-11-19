import type { VeraClientAgentRef } from "../../src/sdk/extensions.ts";
import type { TuiState } from "./state.ts";

export interface TuiContextAgent {
    readonly agentId: string | undefined;
    readonly state: TuiState;
}

export function tuiContextStateForAgent(
    agent: VeraClientAgentRef,
    primary: TuiContextAgent,
    sidebar?: TuiContextAgent,
): TuiState | undefined {
    if (agent.agentId === primary.agentId) return primary.state;
    if (sidebar !== undefined && agent.agentId === sidebar.agentId) return sidebar.state;
    return undefined;
}
