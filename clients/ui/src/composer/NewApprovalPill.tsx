import { useCallback, useRef, useState } from "react";

import { HandIcon } from "../components/Icons.tsx";
import { usePopoverPlacement } from "../components/usePopoverPlacement.ts";
import { useFullAccessOffered } from "../session/fullAccess.ts";
import { modeLabel, offeredModeOptions } from "../session/permissions.ts";
import { ApprovalMenu, modeChoices, type ApprovalChoice } from "./ApprovalMenu.tsx";
import { FULL_ACCESS_OFF, resolveModeArgument } from "./slash/args.ts";
import { PILL_DONE, usePillRequests } from "./slash/pillRequests.ts";
import { useMenuDismiss } from "./useMenuDismiss.ts";

export interface NewApprovalPillProps {
    // The mode picked for the new session; undefined leaves the host default in place.
    readonly mode: string | undefined;
    readonly onPick: (mode: string | undefined) => void;
    readonly disabled: boolean;
}

// The approval pill before a session exists. The choice goes to the host when the session is created.
export function NewApprovalPill({ mode, onPick, disabled }: NewApprovalPillProps) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useMenuDismiss(open, root, close);
    const placed = usePopoverPlacement(open, root);
    const fullAccess = useFullAccessOffered();

    const pick = (next: string | undefined): void => {
        onPick(next);
        setOpen(false);
    };
    usePillRequests("approval", (argument) => {
        if (disabled) return { done: false, message: "The approval mode cannot be changed right now" };
        if (argument.trim().length === 0) {
            setOpen(true);
            return PILL_DONE;
        }
        const resolved = resolveModeArgument([], argument, fullAccess);
        if (resolved.kind === "off") return { done: false, message: FULL_ACCESS_OFF };
        if (resolved.kind === "unknown") return { done: false, message: `Permission modes: ${resolved.modes.join(", ")}` };
        onPick(resolved.mode);
        return PILL_DONE;
    });
    const choices: readonly ApprovalChoice[] = [
        {
            key: "default",
            Icon: HandIcon,
            label: "Use the default",
            description: "The mode Vera starts new sessions in",
            warn: false,
            selected: mode === undefined,
            onSelect: () => pick(undefined),
        },
        ...modeChoices(offeredModeOptions([], fullAccess, mode), mode, (picked) => pick(picked)),
    ];

    const label = mode === undefined ? "Default approvals" : modeLabel(mode);
    return (
        <div className="approval-picker" ref={root}>
            <button
                type="button"
                className="pill-button"
                data-mode={mode}
                aria-haspopup="menu"
                aria-expanded={open}
                title={`${label}\nChoose how tool calls are approved`}
                disabled={disabled}
                onClick={() => setOpen(!open)}
            >
                <HandIcon className="pill-icon" />
                <span className="pill-label">{label}</span>
            </button>
            {open ? <ApprovalMenu choices={choices} style={placed} /> : null}
        </div>
    );
}
