import { AgentIcon, XIcon } from "../components/Icons.tsx";
import { SubagentList, useEscapeClose, type SheetProps } from "./TasksSheet.tsx";

export function SubagentsSheet({ session, onClose }: SheetProps) {
    useEscapeClose(onClose);
    return (
        <div
            className="sheet-scrim"
            onClick={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
        >
            <div className="sheet subagents-sheet" role="dialog" aria-modal="true" aria-label="Subagents">
                <div className="sheet-head">
                    <AgentIcon className="tasks-head-icon" />
                    <span className="sheet-title">Subagents</span>
                    <button type="button" className="sheet-x" onClick={onClose} aria-label="Close">
                        <XIcon />
                    </button>
                </div>
                <div className="sheet-body tasks-body">
                    <p className="tasks-intro">
                        Work this session handed off. Each subagent is its own session with its own transcript, and
                        returns only its conclusion here.
                    </p>
                    <SubagentList session={session} onClose={onClose} />
                </div>
            </div>
        </div>
    );
}
