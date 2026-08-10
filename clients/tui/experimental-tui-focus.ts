import type { VeraExperimentalTuiSlot } from "../../src/sdk/experimental-tui.ts";

export interface TuiExperimentalFocusSpec {
    readonly slot: VeraExperimentalTuiSlot;
    readonly modal?: boolean;
    readonly focusable?: boolean;
}

export function findTuiExperimentalModal<T>(
    views: Iterable<T>,
    specFor: (view: T) => TuiExperimentalFocusSpec,
    visible: (view: T) => boolean,
): T | undefined {
    for (const view of views) {
        const spec = specFor(view);
        if (spec.slot === "overlay" && spec.modal === true && visible(view)) {
            return view;
        }
    }
    return undefined;
}

export function findTuiExperimentalFocusable<T>(
    views: Iterable<T>,
    specFor: (view: T) => TuiExperimentalFocusSpec,
    visible: (view: T) => boolean,
): T | undefined {
    for (const view of views) {
        const spec = specFor(view);
        if (spec.focusable === true && visible(view)) return view;
    }
    return undefined;
}

export function hasTuiExperimentalModal<T>(
    views: Iterable<T>,
    specFor: (view: T) => TuiExperimentalFocusSpec,
    visible: (view: T) => boolean,
): boolean {
    return findTuiExperimentalModal(views, specFor, visible) !== undefined;
}
