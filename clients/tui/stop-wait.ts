import type { UiResponseCommand, UserQuestionUiRequestUpdate } from "../../src/engine/protocol.ts";
import type { HostStopWaitEvent } from "../../src/host/protocol.ts";
import type { StopWaitTarget } from "../../src/host/stop-when-idle.ts";

export type TuiStopWait =
    | { readonly kind: "stop"; readonly waitingOn: readonly StopWaitTarget[] }
    | {
        readonly kind: "update";
        readonly targetBuildId: string;
        readonly waitingOn: readonly StopWaitTarget[];
    };

// A restart clears the wait here; the relaunch on host_restarting is handled by the caller.
export function applyStopWaitEvent(
    current: TuiStopWait | undefined,
    event: HostStopWaitEvent | undefined,
): TuiStopWait | undefined {
    if (event === undefined) return current;
    if (event.type === "host_stop_wait") {
        if (event.kind === "stop") return { kind: "stop", waitingOn: event.waiting_on };
        if (event.target_build_id === undefined) return current;
        return {
            kind: "update",
            targetBuildId: event.target_build_id,
            waitingOn: event.waiting_on,
        };
    }
    return undefined;
}

export const STOP_WAIT_CARD_REQUEST_ID = "tui-local:stop-wait";
export const STOP_WAIT_KEEP_CHOICE = "keep";
export const STOP_WAIT_STOP_CHOICE = "stop";

// Shows the card for the wait it opened for. A new wait (new kind or build) opens it again.
export interface TuiStopWaitCard {
    readonly key: string;
    readonly open: boolean;
}

export function stopWaitKey(wait: TuiStopWait): string {
    return wait.kind === "update" ? `update:${wait.targetBuildId}` : "stop";
}

export function nextStopWaitCard(
    current: TuiStopWaitCard | undefined,
    wait: TuiStopWait | undefined,
): TuiStopWaitCard | undefined {
    if (wait === undefined) return undefined;
    const key = stopWaitKey(wait);
    if (current?.key === key) return current;
    return { key, open: true };
}

export function closeStopWaitCard(card: TuiStopWaitCard): TuiStopWaitCard {
    return { key: card.key, open: false };
}

function stopWaitCardTitle(wait: TuiStopWait): string {
    const first = wait.waitingOn[0];
    const waitingFor = first === undefined ? "" : ` Waiting for ${first.name ?? first.session_id}.`;
    return wait.kind === "update"
        ? `Updating to ${wait.targetBuildId}.${waitingFor}`
        : `Vera is stopping.${waitingFor}`;
}

// The card reuses the question view. Keep waiting is first and recommended, so Enter keeps the wait.
export function stopWaitCardUpdate(
    wait: TuiStopWait | undefined,
    card: TuiStopWaitCard | undefined,
): UserQuestionUiRequestUpdate | undefined {
    if (wait === undefined || card === undefined || !card.open) return undefined;
    return {
        type: "ui_request",
        requestId: STOP_WAIT_CARD_REQUEST_ID,
        seq: 0,
        request: {
            type: "user_question",
            question: stopWaitCardTitle(wait),
            choices: [
                {
                    id: STOP_WAIT_KEEP_CHOICE,
                    label: "Keep waiting",
                    recommended: true,
                },
                { id: STOP_WAIT_STOP_CHOICE, label: "Stop it now" },
            ],
        },
    };
}

export function isStopWaitCardUpdate(update: UserQuestionUiRequestUpdate): boolean {
    return update.requestId === STOP_WAIT_CARD_REQUEST_ID;
}

// Only an explicit "Stop it now" stops anything. Keep waiting, Escape, and any other answer do not.
export function stopWaitCardChoice(response: UiResponseCommand): "stop" | "keep" {
    const answer = response.response;
    return answer.type === "user_question"
        && answer.outcome === "selected"
        && answer.choiceId === STOP_WAIT_STOP_CHOICE
        ? "stop"
        : "keep";
}

export function stopWaitNoticeText(wait: TuiStopWait | undefined): string | undefined {
    if (wait === undefined || wait.waitingOn.length === 0) return undefined;
    const first = wait.waitingOn[0];
    if (first === undefined) return undefined;
    const firstName = first.name ?? first.session_id;
    const more = wait.waitingOn.length - 1;
    const waiting = more === 0
        ? `waiting for ${firstName}`
        : `waiting for ${firstName} and ${more} more`;
    const head = wait.kind === "update"
        ? `Updating to ${wait.targetBuildId}`
        : "Stopping";
    return `${head} · ${waiting}`;
}

export interface StopNowDependencies {
    readonly abort: (sessionId: string) => Promise<void>;
}

// Aborts every session the wait names. Refused or failed aborts are returned, not thrown,
// so the notice can show what was not stopped.
export async function stopNow(
    wait: TuiStopWait,
    dependencies: StopNowDependencies,
): Promise<readonly { readonly sessionId: string; readonly error?: string }[]> {
    const results: { readonly sessionId: string; readonly error?: string }[] = [];
    for (const target of wait.waitingOn) {
        try {
            await dependencies.abort(target.session_id);
            results.push({ sessionId: target.session_id });
        } catch (error) {
            results.push({
                sessionId: target.session_id,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return results;
}
