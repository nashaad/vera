import { ClockIcon } from "../components/Icons.tsx";
import { useViewEnvironment } from "../views/env.tsx";
import type { ActiveSession } from "./activeSession.ts";
import { runningChildCount } from "./subagents.ts";

export interface TasksIndicatorProps {
    readonly session: ActiveSession;
    readonly onOpen: () => void;
}

export function TasksIndicator({ session, onOpen }: TasksIndicatorProps) {
    const { connection } = useViewEnvironment();
    const count = runningChildCount(connection.sessionRows ?? [], session.agentId, session.watch.background);
    if (count === 0) return null;
    return (
        <button
            type="button"
            className="tasks-pill"
            title="Background tasks"
            aria-label={`${count} background ${count === 1 ? "task" : "tasks"} running`}
            onClick={onOpen}
        >
            <ClockIcon className="tasks-pill-icon" />
            <span className="tasks-pill-count">{count}</span>
        </button>
    );
}
