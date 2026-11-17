import { createContext, useContext } from "react";

import type { UiState } from "../state/connection.ts";
import type { OutputLog } from "../state/outputLog.ts";
import type { AgentListFacts, ListAgentsOptions } from "../protocol/client.ts";

export interface ViewEnvironment {
    readonly connection: UiState;
    readonly log: OutputLog;
    readonly listAgents: (options?: ListAgentsOptions) => Promise<AgentListFacts>;
}

export const ViewEnvContext = createContext<ViewEnvironment | undefined>(undefined);

export function useViewEnvironment(): ViewEnvironment {
    const environment = useContext(ViewEnvContext);
    if (environment === undefined) throw new Error("A view needs a ViewEnvContext.");
    return environment;
}

// What a view is told about itself: whether it is showing, never where it sits.
export interface ViewProps {
    readonly visible: boolean;
}
