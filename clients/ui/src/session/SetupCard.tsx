import { GearIcon } from "../components/Icons.tsx";
import { setupResponse, type SetupRequest } from "./requests.ts";

export interface SetupCardProps {
    readonly request: SetupRequest;
    readonly answered: boolean;
    readonly onRespond: (line: string) => void;
}

export function SetupCard({ request, answered, onRespond }: SetupCardProps) {
    return (
        <div className="request-card" data-kind="setup" data-request-id={request.requestId} data-answered={answered}>
            <div className="request-head">
                <GearIcon />
                <span className="request-head-main">
                    <span className="request-title">Setup needed</span>
                </span>
            </div>
            <div className="request-body">
                <p>{request.reason}</p>
                {request.waiting > 1 ? <p>{request.waiting} actions are waiting on this</p> : null}
                <p className="request-muted">
                    This window cannot open this setup yet. Dismiss it here and finish the setup from the terminal.
                </p>
            </div>
            <div className="request-actions">
                <span className="request-spacer" />
                <button
                    type="button"
                    className="button request-ghost"
                    disabled={answered}
                    onClick={() => onRespond(setupResponse(request.requestId, "unavailable"))}
                >
                    Dismiss <kbd className="kbd">esc</kbd>
                </button>
            </div>
        </div>
    );
}
