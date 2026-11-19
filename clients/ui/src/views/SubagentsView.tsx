import { useActiveSession } from "../session/activeSession.ts";
import { SubagentDetail } from "../subagents/SubagentDetail.tsx";
import { SubagentsList } from "../subagents/SubagentsList.tsx";
import { openChild, useSubagentsFocus } from "../subagents/store.ts";
import type { ViewProps } from "./env.tsx";

// One tab for the open session's subagents: the list, or one child's conversation.
export function SubagentsView({ visible }: ViewProps) {
    const session = useActiveSession();
    const focus = useSubagentsFocus();
    if (session === undefined) return <p className="view-empty">Open a session to see its subagents.</p>;
    const childId = openChild(focus, session.agentId);
    if (childId === undefined) return <SubagentsList session={session} />;
    return <SubagentDetail key={childId} session={session} childId={childId} visible={visible} />;
}
