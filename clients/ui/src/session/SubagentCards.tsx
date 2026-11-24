import { createContext, memo, useContext, useMemo, useRef, type ReactNode } from "react";

import { AgentIcon, ChevronRightIcon } from "../components/Icons.tsx";
import type { SessionRow } from "../protocol/sessions.ts";
import { openSubagents } from "../subagents/open.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import type { Block, ToolCall } from "./model.ts";
import { callChildId, callDescription, callStatusWord, isCardCall, matchSubagentCalls, runSegments } from "./subagentCards.ts";
import { isRunningRow, statusWord } from "./subagents.ts";
import { RunLine } from "./ToolRuns.tsx";

interface CardMatches {
    readonly parentId: string;
    readonly matches: ReadonlyMap<ToolCall, SessionRow>;
}

const CardContext = createContext<CardMatches | undefined>(undefined);

function sameMatches(left: ReadonlyMap<ToolCall, SessionRow>, right: ReadonlyMap<ToolCall, SessionRow>): boolean {
    if (left.size !== right.size) return false;
    for (const [call, row] of left) {
        const other = right.get(call);
        if (other === undefined || other.id !== row.id || other.status !== row.status) return false;
    }
    return true;
}

// Matches the open session's subagent calls to its children. Without it, as in a Chat tab, a run of
// calls stays one line, because a card opens the Subagents tab of the session on the page.
export function SubagentCardsProvider({ parentId, blocks, enabled, children }: {
    readonly parentId: string;
    readonly blocks: readonly Block[];
    readonly enabled: boolean;
    readonly children: ReactNode;
}) {
    const rows = useViewEnvironment().connection.sessionRows;
    const calls = useMemo(
        () => (enabled ? blocks.flatMap((block) => (block.kind === "tools" ? block.calls.filter(isCardCall) : [])) : []),
        [enabled, blocks],
    );
    const previous = useRef<CardMatches | undefined>(undefined);
    const value = useMemo<CardMatches>(() => {
        const matches = matchSubagentCalls(calls, rows ?? [], parentId);
        const last = previous.current;
        return last !== undefined && last.parentId === parentId && sameMatches(last.matches, matches) ? last : { parentId, matches };
    }, [calls, rows, parentId]);
    previous.current = value;
    return enabled ? <CardContext.Provider value={value}>{children}</CardContext.Provider> : <>{children}</>;
}

export interface RunSegmentsProps {
    readonly calls: readonly ToolCall[];
    // The run still being made: its status line names the current call, so only the cards are drawn.
    readonly cardsOnly: boolean;
}

// A run of calls with each subagent call as a card of its own and the calls between them as run lines.
export const RunSegments = memo(function RunSegments({ calls, cardsOnly }: RunSegmentsProps) {
    const cards = useContext(CardContext);
    const segments = useMemo(() => runSegments(calls), [calls]);
    if (cards === undefined) return cardsOnly ? null : <RunLine calls={calls} />;
    return (
        <>
            {segments.map((segment, index) => {
                if (segment.kind === "card") {
                    return <SubagentCard key={index} call={segment.call} child={cards.matches.get(segment.call)} parentId={cards.parentId} />;
                }
                return cardsOnly ? null : <RunLine key={index} calls={segment.calls} />;
            })}
        </>
    );
});

function SubagentCard({ call, child, parentId }: {
    readonly call: ToolCall;
    readonly child: SessionRow | undefined;
    readonly parentId: string;
}) {
    const workbench = useWorkbench();
    const title = callDescription(call) ?? child?.name ?? "Subagent";
    const word = child === undefined ? callStatusWord(call.state) : statusWord(child.status);
    const running = child === undefined ? call.state === "running" : isRunningRow(child);
    const failed = child === undefined && call.state === "failed";
    return (
        <button
            type="button"
            className="subagent-card"
            data-find-entry={call.entryId}
            data-running={running}
            data-failed={failed}
            title={title}
            onClick={() => openSubagents(workbench, parentId, callChildId(call, child))}
        >
            <AgentIcon className="subagent-card-icon" />
            <span className="subagent-card-title">{title}</span>
            <span className="session-dot" data-running={running} data-failed={failed} aria-hidden="true" />
            <span className="subagent-card-status">{word}</span>
            <ChevronRightIcon className="chev" />
        </button>
    );
}
