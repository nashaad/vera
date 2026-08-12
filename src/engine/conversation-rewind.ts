import type { ModelMessage } from "../model/types.ts";
import {
    SessionStore,
    type SessionRewindEntry,
} from "../store/session-store.ts";
import type { ProtocolEncoder } from "./protocol.ts";

export interface ConversationRewindState {
    readonly messages: ModelMessage[];
    readonly store: SessionStore;
}

/**
 * Persist a conversation-only rewind, replace the live model context with the
 * store's active line, and publish one fresh canonical history snapshot.
 */
export async function rewindConversationBefore(
    state: ConversationRewindState,
    protocol: ProtocolEncoder,
    userMessageId: string,
): Promise<SessionRewindEntry> {
    const rewind = await state.store.rewindBefore(userMessageId);
    const activeMessages = state.store.messages();
    state.messages.splice(0, state.messages.length, ...activeMessages);
    protocol.checkpoint(state.messages, state.store.activeMessageIds());
    return rewind;
}
