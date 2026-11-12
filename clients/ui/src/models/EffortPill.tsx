import { useCallback, useRef, useState } from "react";

import { ChevronDownIcon } from "../components/Icons.tsx";
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

    const { settings, choice } = controls;
    const entry = settings === undefined || choice === undefined ? undefined : findModel(settings, choice);
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
            {open ? <EffortPopover controls={controls} entry={entry} name={modelName(settings, choice)} /> : null}
        </div>
    );
}
