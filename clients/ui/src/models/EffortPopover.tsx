import { useEffect, useState } from "react";

import { BoltIcon, RefreshIcon } from "../components/Icons.tsx";
import type { ModelControls } from "./controls.ts";
import { effortIndex, effortText, sliderLevels } from "./menuRows.ts";
import type { ModelEntry } from "./settings.ts";

export interface EffortPopoverProps {
    readonly controls: ModelControls;
    readonly entry: ModelEntry;
    readonly name: string;
}

// The slider keeps the dragged position until the host echoes the new effort, so the knob does not snap back between steps.
export function EffortPopover({ controls, entry, name }: EffortPopoverProps) {
    const effort = controls.choice?.effort;
    const [dragged, setDragged] = useState<number | undefined>(undefined);
    useEffect(() => setDragged(undefined), [effort]);

    const levels = sliderLevels(entry.levels);
    const last = levels.length - 1;
    const index = dragged ?? effortIndex(entry, effort);
    const level = levels[index];
    const percent = `${(index / last) * 100}%`;
    const atDefault = effort === undefined || effort === entry.defaultLevel;

    return (
        <div className="effort-pop" role="dialog" aria-label="Effort">
            <div className="effort-head">
                <BoltIcon className="effort-bolt" />
                <span className="effort-level">{effortText(entry, effort)}</span>
                <button
                    type="button"
                    className="effort-reset"
                    title="Back to this model's default"
                    aria-label="Back to this model's default"
                    disabled={atDefault}
                    onClick={() => controls.actions.setEffort(null)}
                >
                    <RefreshIcon className="effort-reset-icon" />
                </button>
            </div>
            <div className="effort-model">{name}</div>
            <div className="effort-track">
                <span className="effort-rail" />
                <span className="effort-fill" style={{ width: percent }} />
                {levels.map((stop, i) => (
                    <span key={stop.id} className="effort-stop" title={stop.label} style={{ left: `${(i / last) * 100}%` }} />
                ))}
                <span className="effort-knob" style={{ left: percent }} />
                <input
                    type="range"
                    className="effort-input"
                    min={0}
                    max={last}
                    step={1}
                    value={index}
                    aria-label="Effort"
                    onChange={(event) => {
                        const next = Number(event.target.value);
                        const picked = levels[next];
                        if (picked === undefined) return;
                        setDragged(next);
                        controls.actions.setEffort(picked.id);
                    }}
                />
            </div>
            {level?.description === undefined ? null : <p className="effort-desc">{level.description}</p>}
        </div>
    );
}
