import { ArrowLeftIcon, AgentIcon, CheckIcon } from "../components/Icons.tsx";
import { useRouter } from "../pages/router.tsx";
import { sessionPlace } from "../pages/routes.ts";
import type { ActiveSession } from "../session/activeSession.ts";
import { QueueStrip } from "../session/QueueStrip.tsx";
import { RequestCards } from "../session/RequestCards.tsx";
import { SubagentTranscript } from "../session/SubagentTranscript.tsx";
import { isRunningRow, statusWord } from "../session/subagents.ts";
import { useSessionWatch } from "../session/useSessionWatch.ts";
import { useStopSubagent } from "../session/useStopSubagent.ts";
import { releaseQueuedCommand } from "../session/wire.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { subagentsTab } from "./store.ts";
import { SubagentMessageBox } from "./SubagentMessageBox.tsx";

export interface SubagentDetailProps {
    readonly session: ActiveSession;
    readonly childId: string;
    readonly visible: boolean;
}

// One child's conversation and a box to message it. The watch is held only while the tab shows.
export function SubagentDetail({ session, childId, visible }: SubagentDetailProps) {
    if (!visible) return null;
    return <DetailBody session={session} childId={childId} />;
}

function DetailBody({ session, childId }: { readonly session: ActiveSession; readonly childId: string }) {
    const { connection } = useViewEnvironment();
    const router = useRouter();
    const { stopping, failures, stop } = useStopSubagent(session.bridge);
    const { watch, send } = useSessionWatch(session.bridge, childId, connection.phase === "attached", "subagent");
    const row = connection.sessionRows?.find((candidate) => candidate.id === childId);
    const title = row?.name ?? watch.title ?? "Subagent";
    const status = row?.status ?? watch.status;
    const running = row === undefined ? watch.status !== "idle" : isRunningRow(row);
    const failure = failures[childId];

    const goTo = (): void => {
        router.navigate({ kind: "session", agentId: childId, title, ...(row === undefined ? {} : sessionPlace(row.workspace, row.chat)) });
    };

    return (
        <section className="subagent-detail" aria-label={title} data-subagent={childId} data-phase={watch.phase}>
            <header className="subagent-head">
                <button
                    type="button"
                    className="header-button"
                    aria-label="Back to subagents"
                    title="Back to subagents"
                    onClick={() => subagentsTab.show(session.agentId)}
                >
                    <ArrowLeftIcon />
                </button>
                <AgentIcon className="subagent-icon" />
                <span className="subagent-title" title={title}>{title}</span>
                {status === "completed" ? (
                    <span className="subagent-state" data-completed="true" role="img" aria-label="Done" title="Done"><CheckIcon /></span>
                ) : (
                    <span className="subagent-state" data-running={running}>{statusWord(status)}</span>
                )}
                <span className="spacer" />
                <button type="button" className="subagent-action" onClick={goTo}>Open chat</button>
                {running ? (
                    <button type="button" className="subagent-action" disabled={stopping.has(childId)} onClick={() => void stop(childId)}>
                        Stop
                    </button>
                ) : null}
            </header>
            {failure === undefined ? null : <p className="subagent-error" role="alert">{failure}</p>}
            <SubagentTranscript
                sessionId={childId}
                watch={watch}
                folder={row?.workspace}
                after={(
                    <>
                        <RequestCards key={childId} requests={watch.requests} send={send} running={watch.status !== "idle"} />
                        <QueueStrip queue={watch.queue} onRelease={() => send(releaseQueuedCommand("one"))} />
                    </>
                )}
            />
            <SubagentMessageBox key={childId} sessionId={childId} watch={watch} send={send} />
        </section>
    );
}
