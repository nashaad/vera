import { SessionStore, WORKER_EXIT_TURN_MESSAGE, type SessionMessageEntry } from "../../store/session-store.ts";

export function prepareWorkerExit(store: SessionStore): void {
    const append = store.appendMessage.bind(store);
    let recorded: SessionMessageEntry | undefined;
    // Closing an agent normally removes queued prompts before crash recovery can capture them.
    store.removeQueuedPrompt = async () => {};
    store.appendMessage = async (message, options) => {
        if (message.role === "assistant" && message.stopReason !== "tool_use") {
            if (recorded !== undefined) return recorded;
            if (await store.repairCrashedTurn({ workerExited: true })) {
                const headId = store.activeHeadId();
                const entry = headId === null ? undefined : await store.readMessageEntry(headId);
                if (entry?.message.role === "assistant" && entry.message.errorMessage === WORKER_EXIT_TURN_MESSAGE) {
                    recorded = entry;
                    return entry;
                }
            }
        }
        return await append(message, options);
    };
}
