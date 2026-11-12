import { useState } from "react";

import { ChevronDownIcon, ChevronRightIcon, InboxIcon, RefreshIcon } from "../components/Icons.tsx";
import { useRouter } from "../pages/router.tsx";
import { sessionPlace } from "../pages/routes.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { useActiveSession } from "./activeSession.ts";
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
    const [showAll, setShowAll] = useState(false);
    const row = connection.sessionRows?.find((candidate) => candidate.id === block.sourceAgentId);
    const lines = block.text.split("\n");
    const collapsed = !showAll && lines.length > PREVIEW_LINES;
    const text = collapsed ? lines.slice(0, PREVIEW_LINES).join("\n") : block.text;
    return (
        <div className="inbox-banner" data-kind={block.deliveryKind}>
            <InboxIcon className="inbox-icon" />
            <div className="inbox-body">
                <div className="inbox-title">{row?.name ?? "A subagent"} has something for you</div>
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
                    onClick={() => router.navigate({
                        kind: "session",
                        agentId: row.id,
                        title: row.name,
                        ...sessionPlace(row.workspace, row.chat),
                    })}
                >
                    Open it
                </button>
            )}
        </div>
    );
}

// Shown under the last turn while a failed model request waits for its next attempt.
export function RetryLine() {
    const retry = useActiveSession()?.watch.retry;
    if (retry === undefined) return null;
    const when = retry.retryAt === undefined ? "" : ` at ${clockTime(retry.retryAt)}`;
    return (
        <div className="transcript-notice retry-line" data-tone="warning">
            <RefreshIcon className="retry-icon" />
            Retrying {retry.model}, attempt {retry.nextAttempt} of {retry.maxAttempts}{when}
        </div>
    );
}
