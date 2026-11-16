import { useCallback, useState } from "react";

import { useChatEntry, type ChatEntry } from "../chat/store.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { Conversation, type ConversationState } from "../session/Conversation.tsx";
import { usePaneTab, usePublishTabTitle } from "../workbench/tab-context.tsx";
import type { ViewProps } from "./env.tsx";

const NO_CHAT = "This tab holds no chat. Open one from Help or with /btw.";

// One session's conversation in a right pane tab. The tab's id picks the chat it shows.
export function ChatView(_props: ViewProps) {
    const entry = useChatEntry(usePaneTab());
    const bridge = window.veraDesktop as DesktopBridge | undefined;
    if (entry === undefined) return <p className="view-empty">{NO_CHAT}</p>;
    if (bridge === undefined) return <p className="view-empty">This window has no host bridge.</p>;
    return <ChatBody bridge={bridge} entry={entry} />;
}

function ChatBody({ bridge, entry }: { readonly bridge: DesktopBridge; readonly entry: ChatEntry }) {
    const [named, setNamed] = useState<string | undefined>(undefined);
    const onState = useCallback((state: ConversationState) => setNamed(state.title), []);
    // A sidekick keeps its own name: its session inherits the title of the conversation it branched from.
    usePublishTabTitle(entry.kind === "help" ? named ?? entry.title : entry.title);
    return (
        <div className="chat-view" data-chat={entry.kind}>
            <Conversation
                bridge={bridge}
                agentId={entry.agentId}
                pane={entry.pane}
                title={entry.title}
                workspace={entry.folder}
                chat={entry.chat}
                onState={onState}
            />
        </div>
    );
}
