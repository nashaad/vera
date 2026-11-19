import { AgentIcon } from "../components/Icons.tsx";
import { OVERLAY_COMMANDS } from "../commands/overlay-ids.ts";
import { useWorkbench } from "../workbench/context.tsx";

export interface NewAgentPillProps {
    // The agent the new session will start on.
    readonly agent: string;
    readonly disabled: boolean;
}

// The agent pill before a session exists. It opens the Choose Agent sheet, which lists this folder's agents.
export function NewAgentPill({ agent, disabled }: NewAgentPillProps) {
    const { run } = useWorkbench();
    return (
        <button
            type="button"
            className="pill-button"
            data-agent={agent}
            title={`${agent}\nChoose the agent this session runs as`}
            disabled={disabled}
            onClick={() => run(OVERLAY_COMMANDS.agent.id)}
        >
            <AgentIcon className="pill-icon" />
            <span className="pill-label">{agent}</span>
        </button>
    );
}
