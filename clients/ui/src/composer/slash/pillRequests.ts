import { useEffect, useRef } from "react";

import type { PillTarget } from "./model.ts";

// A pill answers with nothing when it did what was asked, or with a sentence for the person.
export type PillResult = { readonly done: true } | { readonly done: false; readonly message: string };

export type PillHandler = (argument: string) => PillResult;

export const PILL_DONE: PillResult = { done: true };

const handlers = new Map<PillTarget, Set<PillHandler>>();

// Asks the mounted pill to open or to apply a typed choice. The pills own their popovers and state.
export function requestPill(pill: PillTarget, argument: string): PillResult {
    let refusal: PillResult | undefined;
    for (const handler of handlers.get(pill) ?? []) {
        const result = handler(argument);
        if (result.done) return result;
        refusal ??= result;
    }
    return refusal ?? { done: false, message: "That control is not available here" };
}

// Registers the latest handler for as long as the pill is mounted.
export function usePillRequests(pill: PillTarget, handler: PillHandler): void {
    const latest = useRef(handler);
    latest.current = handler;
    useEffect(() => {
        const entry: PillHandler = (argument) => latest.current(argument);
        const set = handlers.get(pill) ?? new Set<PillHandler>();
        set.add(entry);
        handlers.set(pill, set);
        return () => {
            set.delete(entry);
        };
    }, [pill]);
}
