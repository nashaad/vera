import { useEffect, useState, type CSSProperties } from "react";

import { BoltIcon, ChevronRightIcon, RefreshIcon } from "../components/Icons.tsx";
import type { ModelControls } from "./controls.ts";
import { effortIndex, levelLabel, sliderLevels } from "./menuRows.ts";
import type { ModelEntry } from "./settings.ts";

export interface EffortPopoverProps {
    readonly controls: ModelControls;
    readonly entry: ModelEntry;
    readonly name: string;
    readonly style?: CSSProperties;
}

// Positions are fractions of the track, 0 to 1; the stylesheet turns them into a length.
type KnobStyle = CSSProperties & { readonly "--effort-at": number };
type StopStyle = CSSProperties & { readonly "--stop-at": number };

export function EffortPopover({ controls, entry, name, style }: EffortPopoverProps) {
    const effort = controls.choice?.effort;
    const [dragged, setDragged] = useState<number | undefined>(undefined);
    const echoed = effortIndex(entry, effort);
    // A drag sends every step, and the echoes of earlier steps arrive after the knob has moved on.
    // Only the echo of the last step lets go of the dragged position, or the knob jumps back.
    useEffect(() => {
        if (dragged === echoed) setDragged(undefined);
    }, [dragged, echoed]);

    const levels = sliderLevels(entry.levels);
    const last = levels.length - 1;
    const index = dragged ?? echoed;
    const level = levels[index];
    const track: KnobStyle = { "--effort-at": index / last };
    const defaultName = entry.defaultLevel === undefined ? undefined : levelLabel(entry.levels, entry.defaultLevel);
    const atDefault = effort === undefined || effort === entry.defaultLevel;

    return (
        <div className="menu effort-pop" role="dialog" data-popover="above-end" style={style} aria-label="Effort">
            <div className="effort-head">
                <BoltIcon className="effort-bolt" />
                <span className="effort-level">
                    {level?.label}
                    <ChevronRightIcon className="effort-chevron" />
                </span>
                {/* Hidden rather than removed, so the level stays centered between the two icons. */}
                <button
                    type="button"
                    className="effort-reset"
                    title={defaultName === undefined ? undefined : `Back to ${defaultName}, this model's default`}
                    aria-label={defaultName === undefined ? undefined : `Reset to ${defaultName}, this model's default`}
                    aria-hidden={defaultName === undefined ? true : undefined}
                    data-absent={defaultName === undefined}
                    disabled={defaultName === undefined || atDefault}
                    onClick={() => controls.actions.setEffort(null)}
                >
                    <RefreshIcon />
                </button>
            </div>
            <div className="effort-model" title={name}>{name}</div>
            <div className="effort-track" style={track}>
                <span className="effort-rail" />
                <span className="effort-fill" />
                {levels.map((stop, i) => {
                    const at: StopStyle = { "--stop-at": i / last };
                    return <span key={stop.id} className="effort-stop" style={at} aria-hidden="true" />;
                })}
                <span className="effort-knob" />
                <input
                    type="range"
                    className="effort-input"
                    min={0}
                    max={last}
                    step={1}
                    value={index}
                    autoFocus
                    aria-label="Effort"
                    aria-valuetext={level?.label}
                    title={level?.description}
                    onChange={(event) => {
                        const next = Number(event.target.value);
                        const picked = levels[next];
                        if (picked === undefined || next === index) return;
                        setDragged(next);
                        controls.actions.setEffort(picked.id);
                    }}
                />
            </div>
        </div>
    );
}
