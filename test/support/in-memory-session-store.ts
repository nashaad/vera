import type { ModelMessage } from "../../src/model/types.ts";
import type { SessionMessageStore } from "../../src/store/session-store.ts";

export class InMemorySessionStore implements SessionMessageStore {
    readonly messages: ModelMessage[] = [];

    async appendMessage(message: ModelMessage): Promise<void> {
        this.messages.push(message);
    }
}
