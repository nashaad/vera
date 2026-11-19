import { useState } from "react";
import { ProviderWizard } from "../pages/settings/ProviderWizard.tsx";
import { GearIcon } from "../components/Icons.tsx";
import { setupResponse, type SetupRequest } from "./requests.ts";

export interface SetupCardProps {
    readonly request: SetupRequest;
    readonly answered: boolean;
    readonly onRespond: (line: string) => void;
}

export function SetupCard({ request, answered, onRespond }: SetupCardProps) {
    const [open, setOpen] = useState(false);
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
                {request.destination === "provider" ? null : <p className="request-muted">This setup is available in the terminal.</p>}
            </div>
            <div className="request-actions">
                {request.destination === "provider" ? <button type="button" className="button" disabled={answered} onClick={() => setOpen(true)}>Connect provider</button> : null}
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
            {open ? <ProviderWizard {...(request.provider === undefined ? {} : { initialProvider: request.provider })}
                onClose={() => setOpen(false)} onComplete={() => onRespond(setupResponse(request.requestId, "configured"))} /> : null}
        </div>
    );
}
