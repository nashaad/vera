import type { ModelMessage } from "../../src/model/types.ts";
import type {
    SessionMessageStore,
    StoredMessage,
} from "../../src/store/session-store.ts";

export class InMemorySessionStore implements SessionMessageStore {
    readonly messages: ModelMessage[] = [];

    private nextId = 1;

    // Mirrors the real store: what is retained is a snapshot, not the caller's
    // object, and the append reports the ID the entry was given.
    async appendMessage(message: ModelMessage): Promise<StoredMessage> {
        const snapshot = structuredClone(message);
        this.messages.push(snapshot);
        return { id: `memory-${this.nextId++}`, message: snapshot };
    }
}
