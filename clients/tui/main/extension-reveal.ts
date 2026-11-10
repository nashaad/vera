import type { TuiPendingSearchTarget, TuiRuntime } from "./runtime.ts";

export interface PendingExtensionReveal {
    readonly controller: AbortController;
    readonly result: PromiseWithResolvers<boolean>;
    searchTarget?: TuiPendingSearchTarget;
}

export function beginExtensionReveal(rt: TuiRuntime): PendingExtensionReveal {
    cancelExtensionReveal(rt);
    const pending: PendingExtensionReveal = {
        controller: new AbortController(),
        result: Promise.withResolvers<boolean>(),
    };
    rt.pendingExtensionReveal = pending;
    return pending;
}

export function finishExtensionReveal(
    rt: TuiRuntime,
    pending: PendingExtensionReveal,
    result: boolean,
): void {
    if (rt.pendingExtensionReveal !== pending) return;
    rt.pendingExtensionReveal = undefined;
    if (rt.pendingSearchTarget === pending.searchTarget) rt.pendingSearchTarget = undefined;
    pending.result.resolve(result);
}

export function failExtensionReveal(
    rt: TuiRuntime,
    pending: PendingExtensionReveal,
    error: unknown,
): void {
    if (rt.pendingExtensionReveal !== pending) return;
    rt.pendingExtensionReveal = undefined;
    if (rt.pendingSearchTarget === pending.searchTarget) rt.pendingSearchTarget = undefined;
    pending.controller.abort();
    pending.result.reject(error);
}

export function cancelExtensionReveal(rt: TuiRuntime): void {
    const pending = rt.pendingExtensionReveal;
    if (pending === undefined) return;
    pending.controller.abort();
    finishExtensionReveal(rt, pending, false);
}
