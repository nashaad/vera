import { useEffect, useRef, useState } from "react";
import { openModelDefaults } from "../models/open-defaults.ts";
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
    const live = useRef(false);
    const sent = useRef(false);
    const answeredRef = useRef(answered);
    answeredRef.current = answered;
    useEffect(() => {
        live.current = true;
        return () => { live.current = false; };
    }, []);
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
                {request.destination === "provider" || (request.destination === "model_assignment" && request.assignment === "subagents") ? null : <p className="request-muted">This setup is available in the terminal.</p>}
            </div>
            <div className="request-actions">
                {request.destination === "provider" ? <button type="button" className="button" disabled={answered} onClick={() => setOpen(true)}>Connect provider</button> : null}
                {request.destination === "model_assignment" && request.assignment === "subagents" ? (
                    <button type="button" className="button" disabled={answered} onClick={(event) => openModelDefaults(event.currentTarget, () => {
                        if (!live.current || sent.current || answeredRef.current) return;
                        sent.current = true;
                        onRespond(setupResponse(request.requestId, "configured"));
                    })}>
                        Open model defaults
                    </button>
                ) : null}
                <span className="request-spacer" />
                <button
                    type="button"
                    className="button request-ghost"
                    disabled={answered}
                    onClick={() => { sent.current = true; onRespond(setupResponse(request.requestId, "unavailable")); }}
                >
                    Dismiss <kbd className="kbd">esc</kbd>
                </button>
            </div>
            {open ? <ProviderWizard {...(request.provider === undefined ? {} : { initialProvider: request.provider })}
                onClose={() => setOpen(false)} onComplete={() => onRespond(setupResponse(request.requestId, "configured"))} /> : null}
        </div>
    );
}
