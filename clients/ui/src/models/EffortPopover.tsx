import { useEffect, useId, useState, type CSSProperties } from "react";

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

// The slider keeps the dragged position until the host echoes the new effort, so the knob does not snap back between steps.
export function EffortPopover({ controls, entry, name, style }: EffortPopoverProps) {
    const effort = controls.choice?.effort;
    const [dragged, setDragged] = useState<number | undefined>(undefined);
    useEffect(() => setDragged(undefined), [effort]);
    const describedBy = useId();

    const levels = sliderLevels(entry.levels);
    const last = levels.length - 1;
    const index = dragged ?? effortIndex(entry, effort);
    const level = levels[index];
    const track: KnobStyle = { "--effort-at": index / last };
    const hasDescription = levels.some((stop) => stop.description !== undefined);
    const defaultName = entry.defaultLevel === undefined ? undefined : levelLabel(entry.levels, entry.defaultLevel);
    const atDefault = effort === undefined || effort === entry.defaultLevel;

    return (
        <div className="menu effort-pop" role="dialog" data-popover="above-end" style={style} aria-label="Effort">
            <div className="effort-head">
                <div className="effort-level">{level?.label}</div>
                <div className="effort-model" title={name}>{name}</div>
                {defaultName === undefined ? null : (
                    <button
                        type="button"
                        className="effort-reset"
                        title={`Back to ${defaultName}, this model's default`}
                        aria-label={`Reset to ${defaultName}, this model's default`}
                        disabled={atDefault}
                        onClick={() => controls.actions.setEffort(null)}
                    >
                        Reset
                    </button>
                )}
            </div>
            <div className="effort-track" style={track}>
                <div className="effort-rail">
                    <span className="effort-fill" />
                    {levels.map((stop, i) => {
                        const at: StopStyle = { "--stop-at": i / last };
                        return <span key={stop.id} className="effort-stop" data-reached={i <= index} style={at} aria-hidden="true" />;
                    })}
                    <span className="effort-knob" />
                </div>
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
                    aria-describedby={level?.description === undefined ? undefined : describedBy}
                    onChange={(event) => {
                        const next = Number(event.target.value);
                        const picked = levels[next];
                        if (picked === undefined) return;
                        setDragged(next);
                        controls.actions.setEffort(picked.id);
                    }}
                />
            </div>
            {hasDescription ? (
                <div className="effort-descs">
                    {levels.map((stop, i) => (
                        <p key={stop.id} id={i === index ? describedBy : undefined} className="effort-desc" data-current={i === index}>
                            {stop.description}
                        </p>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
