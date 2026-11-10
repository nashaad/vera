import type { SessionCompactionBilled, SessionMessageEntry, SessionStore } from "../../src/store/session-store.ts";
import type { AssistantMessage } from "../../src/model/types.ts";

export async function collectSessionEntries(store: SessionStore): Promise<SessionMessageEntry[]> {
    const entries: SessionMessageEntry[] = [];
    for await (const entry of store.walkEntries()) entries.push(entry);
    return entries;
}

export async function collectSessionBranch(store: SessionStore): Promise<SessionMessageEntry[]> {
    const entries: SessionMessageEntry[] = [];
    const head = store.activeHeadId();
    if (head !== null) for await (const entry of store.walkMessageBranch(head)) entries.push(entry);
    return entries;
}

export async function collectSessionUsage(store: SessionStore): Promise<AssistantMessage[]> {
    const messages: AssistantMessage[] = [];
    for await (const entry of store.walkEntries()) {
        if (entry.message.role === "assistant" && entry.message.source.api !== "none") messages.push(entry.message);
    }
    for (const [kind, api] of [["compaction", "compaction"], ["session_ask", "ask"]] as const) {
        for await (const { record } of store.walkRecords(kind)) {
            const billed = record.billed as SessionCompactionBilled | undefined;
            if (billed === undefined) continue;
            messages.push({ role: "assistant", content: [], stopReason: "stop",
                source: { provider: billed.provider, model: billed.model, api }, usage: billed.usage });
        }
    }
    return messages;
}
