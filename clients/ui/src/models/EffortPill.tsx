import { useCallback, useRef, useState } from "react";

import { ChevronDownIcon } from "../components/Icons.tsx";
import { usePopoverPlacement } from "../components/usePopoverPlacement.ts";
import { resolveEffortArgument } from "../composer/slash/args.ts";
import { PILL_DONE, usePillRequests } from "../composer/slash/pillRequests.ts";
import { useMenuDismiss } from "../composer/useMenuDismiss.ts";
import { findModel, modelName } from "./catalog.ts";
import type { ModelControls } from "./controls.ts";
import { EffortPopover } from "./EffortPopover.tsx";
import { effortText } from "./menuRows.ts";

export interface EffortPillProps {
    readonly controls: ModelControls;
}

// Hidden when the current model has no effort to choose.
export function EffortPill({ controls }: EffortPillProps) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const close = useCallback(() => setOpen(false), []);
    useMenuDismiss(open, root, close);
    const placed = usePopoverPlacement(open, root);

    const { settings, choice } = controls;
    const entry = settings === undefined || choice === undefined ? undefined : findModel(settings, choice);
    usePillRequests("effort", (argument) => {
        if (!controls.enabled) return { done: false, message: "The effort cannot be changed right now" };
        if (entry === undefined || entry.levels.length < 2) return { done: false, message: "This model has no effort levels to choose" };
        if (argument.trim().length === 0) {
            setOpen(true);
            return PILL_DONE;
        }
        const resolved = resolveEffortArgument(entry.levels, argument);
        if (resolved.kind === "unknown") return { done: false, message: `Effort levels: ${resolved.levels.join(", ")}, default` };
        controls.actions.setEffort(resolved.effort);
        return PILL_DONE;
    });
    if (settings === undefined || choice === undefined || entry === undefined || entry.levels.length < 2) return null;

    return (
        <div className="effort-picker" ref={root}>
            <button
                type="button"
                className="pill-button effort-pill"
                aria-haspopup="dialog"
                aria-expanded={open}
                title="Choose an effort level"
                disabled={!controls.enabled}
                onClick={() => setOpen(!open)}
            >
                <span className="pill-label effort-label">{effortText(entry, choice.effort)}</span>
                <ChevronDownIcon className="pill-chevron" />
            </button>
            {open ? <EffortPopover controls={controls} entry={entry} name={modelName(settings, choice)} style={placed} /> : null}
        </div>
    );
}
