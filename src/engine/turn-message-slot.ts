import type { InboundCommandRouter } from "./inbound-command-router.ts";

export interface TurnMessage {
    readonly text: string;
    readonly transcript: string;
}

export interface TurnMessageState {
    recorder?: (text: string, afterMessageId: string | null) => Promise<void>;
    slot?: {
        readonly signal: AbortSignal;
        message?: TurnMessage;
    };
}

export const TURN_MESSAGE_STATE = Symbol("turnMessageState");

export function openTurnMessageSlot(router: InboundCommandRouter, signal: AbortSignal): void {
    router[TURN_MESSAGE_STATE].slot = { signal };
}

export function offerTurnMessage(router: InboundCommandRouter, message: TurnMessage): boolean {
    const state = router[TURN_MESSAGE_STATE];
    const slot = state.slot;
    if (
        slot === undefined
        || state.recorder === undefined
        || slot.signal.aborted
        || slot.message !== undefined
    ) {
        return false;
    }
    slot.message = { ...message };
    return true;
}

export function setTurnMessageAnchorRecorder(
    router: InboundCommandRouter,
    recorder: (text: string, afterMessageId: string | null) => Promise<void>,
): void {
    router[TURN_MESSAGE_STATE].recorder = recorder;
}

export async function recordTurnMessage(
    router: InboundCommandRouter,
    text: string,
    afterMessageId?: string | null,
): Promise<void> {
    const recorder = router[TURN_MESSAGE_STATE].recorder;
    if (recorder !== undefined) await recorder(text, afterMessageId ?? null);
}

export function takeTurnMessage(router: InboundCommandRouter): TurnMessage | undefined {
    const slot = router[TURN_MESSAGE_STATE].slot;
    if (slot === undefined || slot.signal.aborted) return undefined;
    const message = slot.message;
    delete slot.message;
    return message;
}

export function closeTurnMessageSlot(router: InboundCommandRouter): void {
    delete router[TURN_MESSAGE_STATE].slot;
}
