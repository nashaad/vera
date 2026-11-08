import { randomUUID } from "node:crypto";

import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import { HOST_CAPABILITY_PROMPT_QUEUE_WITHDRAW } from "../../../src/host/capabilities.ts";
import { anyOverlayOpen, focusActiveSurface, renderState, reportConnectionError, showStatusNotice } from "../main.ts";
import { focusedAgentClient, focusedAgentState } from "./agents-dials.ts";
import type { TuiRuntime } from "./runtime.ts";

// Takes over Up on an empty composer while a prompt is held; returns false so Up falls back to submitted-text history.
export function recallNewestQueuedPrompt(rt: TuiRuntime): boolean {
    const held = focusedAgentState(rt).queuedPrompts.some((prompt) => prompt.state === "held");
    if (
        !held
        || rt.pendingQueueRecall !== undefined
        || rt.sessionSwitchPending
        || anyOverlayOpen(rt)
        || rt.pendingImages.length > 0
    ) {
        return false;
    }
    const target = focusedAgentClient(rt);
    if (target.supportsHostCapability?.(HOST_CAPABILITY_PROMPT_QUEUE_WITHDRAW) === false) {
        showStatusNotice(rt, "Recalling a queued prompt needs the current resident host");
        return true;
    }
    const requestId = randomUUID();
    rt.pendingQueueRecall = requestId;
    void target.send({ type: "withdraw_queued_prompt", requestId }).catch((error: unknown) => {
        rt.pendingQueueRecall = undefined;
        reportConnectionError(rt, error);
    });
    return true;
}

// Only the client that asked acts on the answer; every attached client receives it.
export function settleQueueRecall(rt: TuiRuntime, update: AgentUpdate): void {
    if (update.type === "notice" && (update.key === "queue_withdraw_empty" || update.key === "queue_withdraw_failed")) {
        rt.pendingQueueRecall = undefined;
        return;
    }
    if (update.type !== "prompt_withdrawn" || update.requestId !== rt.pendingQueueRecall) {
        return;
    }
    rt.pendingQueueRecall = undefined;
    const draft = rt.composer.plainText;
    rt.composer.setComposerText(
        draft.length === 0 ? update.content : `${update.content}\n${draft}`,
    );
    for (const id of update.attachmentIds ?? []) {
        const requestId = randomUUID();
        rt.pendingImages.push({ requestId, id });
        rt.composer.attachImageChip(requestId);
    }
    focusActiveSurface(rt);
    renderState(rt);
}
