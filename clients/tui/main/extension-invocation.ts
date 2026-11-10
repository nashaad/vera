import { focusedAgentClient } from "./agents-dials.ts";
import { abortError, hasEarlierHistory, loadEarlierHistory } from "./history-paging.ts";
import type { ExtensionInvocation, TuiRuntime } from "./runtime.ts";

/** Records the client an extension call runs against and the conversation it started in. */
export function captureExtensionInvocation(rt: TuiRuntime): ExtensionInvocation {
    return {
        target: focusedAgentClient(rt),
        conversationGeneration: rt.conversationGeneration,
    };
}

/** Focus moves do not end an invocation. Only a conversation change does. */
export function conversationChanged(rt: TuiRuntime, invocation: ExtensionInvocation): boolean {
    return rt.conversationGeneration !== invocation.conversationGeneration;
}

/** True when the running extension call started in a conversation that has since changed. */
export function invocationIsStale(rt: TuiRuntime): boolean {
    const invocation = rt.extensionAgentTarget.getStore();
    return invocation !== undefined && conversationChanged(rt, invocation);
}

/** A handled result appends nothing, so it is kept. Any other result that arrives after a conversation change is dropped. */
export function dropsLateResult(
    rt: TuiRuntime,
    invocation: ExtensionInvocation,
    bodyKind: string,
): boolean {
    return conversationChanged(rt, invocation) && bodyKind !== "handled";
}

export function threadHasEarlierForInvocation(rt: TuiRuntime): boolean {
    if (invocationIsStale(rt)) throw abortError();
    return hasEarlierHistory(rt);
}

export async function threadLoadEarlierForInvocation(
    rt: TuiRuntime,
    signal?: AbortSignal,
): Promise<void> {
    if (invocationIsStale(rt)) throw abortError();
    await loadEarlierHistory(rt, signal);
}
