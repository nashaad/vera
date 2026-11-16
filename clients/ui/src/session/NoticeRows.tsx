import { useState } from "react";

import { ChevronDownIcon, ChevronRightIcon, InboxIcon, RefreshIcon } from "../components/Icons.tsx";
import { useRouter } from "../pages/router.tsx";
import { sessionPlace } from "../pages/routes.ts";
import { openSubagents } from "../subagents/open.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { useActiveSession } from "./activeSession.ts";
import { deliverySender } from "./deliverySource.ts";
import type { DeliveryBlock, NoticeBlock, SubstitutionBlock } from "./model.ts";

const PREVIEW_LINES = 3;

function clockTime(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function SubstitutionRow({ block }: { readonly block: SubstitutionBlock }) {
    return (
        <div className="substitution" data-scope={block.scope}>
            <RefreshIcon className="substitution-icon" />
            <span className="substitution-text">{block.text}</span>
            {block.source === "subagent" ? <span className="substitution-tag">subagent</span> : null}
        </div>
    );
}

export function NoticeRow({ block }: { readonly block: NoticeBlock }) {
    const resets = block.resetsAt !== undefined && block.resetsAt > Date.now() ? clockTime(block.resetsAt) : undefined;
    return (
        <div className="transcript-notice" data-tone={block.tone}>
            {block.title === undefined ? null : <div className="notice-title">{block.title}</div>}
            <div>{block.text}</div>
            {resets === undefined ? null : <div className="notice-resets">Resets {resets}</div>}
        </div>
    );
}

export function DeliveryRow({ block }: { readonly block: DeliveryBlock }) {
    const { connection } = useViewEnvironment();
    const router = useRouter();
    const workbench = useWorkbench();
    const openSession = useActiveSession()?.agentId;
    const [showAll, setShowAll] = useState(false);
    const row = block.fromExtension ? undefined : connection.sessionRows?.find((candidate) => candidate.id === block.sourceAgentId);
    const sender = deliverySender(block, row?.name);
    const lines = block.text.split("\n");
    const collapsed = !showAll && lines.length > PREVIEW_LINES;
    const text = collapsed ? lines.slice(0, PREVIEW_LINES).join("\n") : block.text;
    return (
        <div className="inbox-banner" data-kind={block.deliveryKind}>
            <InboxIcon className="inbox-icon" />
            <div className="inbox-body">
                <div className="inbox-title">{sender} has something for you</div>
                <div className="inbox-text">{text}</div>
                {lines.length > PREVIEW_LINES ? (
                    <button type="button" className="inbox-toggle" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
                        {showAll ? "Show less" : "Show all"}
                        {showAll ? <ChevronDownIcon className="inbox-chev" /> : <ChevronRightIcon className="inbox-chev" />}
                    </button>
                ) : null}
            </div>
            {row === undefined ? null : (
                <button
                    type="button"
                    className="inbox-open"
                    onClick={() => {
                        // The tab lists the open session's subagents, so a delivery to any other transcript still navigates.
                        if (openSession !== undefined && row.parentId === openSession) {
                            openSubagents(workbench, openSession, row.id);
                            return;
                        }
                        router.navigate({ kind: "session", agentId: row.id, title: row.name, ...sessionPlace(row.workspace, row.chat) });
                    }}
                >
                    Open it
                </button>
            )}
        </div>
    );
}
