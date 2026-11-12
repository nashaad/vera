import { useEffect, useRef } from "react";

import { CheckIcon, PinIcon } from "../components/Icons.tsx";
import type { ModelEntry } from "./settings.ts";

export const UNAVAILABLE = "Its provider no longer offers this model";

export interface ModelMenuRowProps {
    readonly entry: ModelEntry;
    readonly sub: string;
    readonly current: boolean;
    readonly focused: boolean;
    // The number key that picks this row, when it has one.
    readonly hint?: number;
    readonly onPick: () => void;
    readonly onPin?: () => void;
}

export function ModelMenuRow({ entry, sub, current, focused, hint, onPick, onPin }: ModelMenuRowProps) {
    const ref = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (focused) ref.current?.scrollIntoView({ block: "nearest" });
    }, [focused]);

    return (
        <div className="model-row">
            <button
                ref={ref}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                aria-disabled={!entry.available}
                className="menu-item model-item"
                data-focused={focused}
                title={entry.available ? undefined : UNAVAILABLE}
                onClick={entry.available ? onPick : undefined}
            >
                <span className="model-item-text">
                    <span className="model-item-name">{entry.label}</span>
                    <span className="model-item-sub">{sub}</span>
                </span>
                {current ? <CheckIcon className="menu-check model-check" /> : <span className="menu-check" />}
                {hint === undefined ? null : <span className="kbd">{hint}</span>}
            </button>
            {onPin === undefined ? null : (
                <button type="button" className="model-pin" title="Add to shortlist" aria-label="Add to shortlist" onClick={onPin}>
                    <PinIcon className="model-pin-icon" />
                </button>
            )}
        </div>
    );
}
