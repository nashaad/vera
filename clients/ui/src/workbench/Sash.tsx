import { useRef, type KeyboardEvent, type PointerEvent } from "react";

export interface SashProps {
    readonly orientation: "vertical" | "horizontal";
    readonly label: string;
    readonly value: number;
    readonly min: number;
    readonly max: number;
    // Which way a drag toward the end of the screen changes the size: +1 grows, -1 shrinks.
    readonly direction: 1 | -1;
    readonly onResize: (size: number) => void;
    readonly onReset: () => void;
}

const KEY_STEP = 16;

// A vertical sash is a column edge dragged sideways; a horizontal one is a row edge dragged up and down.
export function Sash({ orientation, label, value, min, max, direction, onResize, onReset }: SashProps) {
    const drag = useRef<{ readonly start: number; readonly size: number } | undefined>(undefined);
    const axis = (event: { clientX: number; clientY: number }): number =>
        orientation === "vertical" ? event.clientX : event.clientY;

    const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { start: axis(event), size: value };
        event.preventDefault();
    };
    const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
        const current = drag.current;
        if (current === undefined) return;
        onResize(current.size + (axis(event) - current.start) * direction);
    };
    const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
        drag.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    };
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        const grow = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
        const shrink = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
        if (event.key !== grow && event.key !== shrink) return;
        const step = (event.key === grow ? 1 : -1) * direction * KEY_STEP;
        onResize(value + step);
        event.preventDefault();
    };

    return (
        <div
            className="sash"
            data-orientation={orientation}
            data-sash={label}
            role="separator"
            aria-orientation={orientation}
            aria-label={`Resize ${label}`}
            aria-valuenow={value}
            aria-valuemin={min}
            aria-valuemax={max}
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
            onDoubleClick={onReset}
        />
    );
}
