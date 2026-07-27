import type {
    AgentUpdate,
    UiRequestUpdate,
} from "../../src/engine/protocol.ts";

export function applyTuiUiRequestUpdate(
    current: UiRequestUpdate | undefined,
    queued: UiRequestUpdate[],
    update: AgentUpdate,
): UiRequestUpdate | undefined {
    if (update.type === "ui_request") {
        if (current === undefined) {
            return update;
        }
        if (
            current.requestId !== update.requestId
            && !queued.some((request) => request.requestId === update.requestId)
        ) {
            queued.push(update);
        }
        return current;
    }
    if (update.type === "ui_request_closed") {
        if (current?.requestId === update.requestId) {
            return queued.shift();
        }
        const index = queued.findIndex(
            (request) => request.requestId === update.requestId,
        );
        if (index >= 0) {
            queued.splice(index, 1);
        }
    }
    return current;
}
