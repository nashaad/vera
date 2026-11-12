import { useCallback, useRef, useState } from "react";

import { HandIcon, WarningIcon } from "../components/Icons.tsx";
import { usePopoverPlacement } from "../components/usePopoverPlacement.ts";
import {
    defaultModeCommand,
    modeLabel,
    modeOptions,
    removeGrantCommand,
    removePreferenceCommand,
    sessionModeCommand,
    type ApprovalState,
    type StandingPermission,
} from "../session/permissions.ts";
import { ApprovalMenu, modeChoices } from "./ApprovalMenu.tsx";
import { ApprovalStanding } from "./ApprovalStanding.tsx";
import { freshRequestId } from "./requests.ts";
import { useMenuDismiss } from "./useMenuDismiss.ts";

export interface ApprovalPillProps {
    readonly approval: ApprovalState | undefined;
    // The requestId of the last permissions change the session refused.
    readonly refused: string | undefined;
    readonly send: (line: string) => void;
    readonly enabled: boolean;
    readonly running: boolean;
}

const REFUSED = "Vera refused that change.";
const PENDING = "The change applies when the running turn ends.";

// The approval mode of one session, with the menu that changes it and what it has allowed.
export function ApprovalPill({ approval, refused, send, enabled, running }: ApprovalPillProps) {
    const [open, setOpen] = useState(false);
    const [sentId, setSentId] = useState<string | undefined>(undefined);
    const root = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useMenuDismiss(open, root, close);
    const placed = usePopoverPlacement(open, root);

    const wasRefused = sentId !== undefined && refused === sentId;
    const waiting = running && approval?.pending === true && approval.requestId === sentId;
    const disabled = !enabled || approval === undefined;

    // A mode change closes the menu; removing a permission leaves it open so several can be removed.
    const dispatch = (kind: string, line: (requestId: string) => string, closeMenu: boolean): void => {
        const requestId = freshRequestId(kind);
        setSentId(requestId);
        send(line(requestId));
        if (closeMenu) setOpen(false);
    };

    const label = approval === undefined ? "Approvals" : modeLabel(approval.mode);
    const hint = wasRefused
        ? REFUSED
        : waiting
            ? PENDING
            : approval === undefined
                ? "The session has not reported its approval mode yet"
                : "Choose how tool calls are approved";

    return (
        <div className="approval-picker" ref={root}>
            <button
                type="button"
                className="pill-button"
                data-mode={approval?.mode}
                aria-haspopup="menu"
                aria-expanded={open}
                title={`${label}\n${hint}`}
                disabled={disabled}
                onClick={() => setOpen(!open)}
            >
                <HandIcon className="pill-icon" />
                <span className="pill-label">{label}</span>
                {waiting ? <span className="pill-sub">after this turn</span> : null}
            </button>
            {open && approval !== undefined ? (
                <ApprovalMenu style={placed} choices={modeChoices(modeOptions(approval.modes), approval.mode, (mode) => dispatch("mode", (id) => sessionModeCommand(id, mode), true))}>
                    <div className="menu-separator" />
                    <button
                        type="button"
                        role="menuitem"
                        className="menu-item approval-item"
                        onClick={() => dispatch("mode", (id) => defaultModeCommand(id, approval.mode), true)}
                    >
                        <span className="menu-check" />
                        <span className="approval-item-body">
                            <span className="approval-item-name">Make this the default for new sessions</span>
                        </span>
                    </button>
                    <ApprovalStanding
                        heading="This session allows"
                        entries={approval.grants}
                        onRemove={(entry: StandingPermission) => dispatch("permission", (id) => removeGrantCommand(id, entry.id), false)}
                    />
                    <ApprovalStanding
                        heading="Every session allows"
                        entries={approval.preferences}
                        onRemove={(entry: StandingPermission) => dispatch("permission", (id) => removePreferenceCommand(id, entry.id), false)}
                    />
                    {approval.warning === undefined ? null : (
                        <p className="approval-note">
                            <WarningIcon className="approval-note-icon" />
                            {approval.warning}
                        </p>
                    )}
                    {wasRefused ? <p className="approval-note approval-refused">{REFUSED}</p> : null}
                </ApprovalMenu>
            ) : null}
        </div>
    );
}
