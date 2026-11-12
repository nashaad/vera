import { useEffect, useMemo } from "react";

import { Composer } from "../composer/Composer.tsx";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { clearActiveSession, publishActiveSession } from "../session/activeSession.ts";
import { CompanionPane } from "../session/CompanionPane.tsx";
import { MAX_HISTORY_BLOCKS } from "../session/model.ts";
import { usePaneLayout } from "../session/paneLayout.ts";
import { QueueStrip } from "../session/QueueStrip.tsx";
import { RequestCards } from "../session/RequestCards.tsx";
import { SessionRail } from "../session/SessionRail.tsx";
import { companionFor } from "../session/subagents.ts";
import { Transcript } from "../session/Transcript.tsx";
import { usePinnedScroll } from "../session/usePinnedScroll.ts";
import { useSessionWatch } from "../session/useSessionWatch.ts";
import { releaseQueuedCommand } from "../session/wire.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { useIsShown } from "../workbench/context.tsx";
import type { SessionRoute } from "./routes.ts";

export interface SessionPageProps {
    readonly route: SessionRoute;
}

export function SessionPage({ route }: SessionPageProps) {
    const bridge = window.veraDesktop as DesktopBridge | undefined;
    if (bridge === undefined) {
        return <SessionMessage title={route.title} text="This window has no host bridge." />;
    }
    return <SessionView bridge={bridge} route={route} />;
}

function SessionView({ bridge, route }: { readonly bridge: DesktopBridge; readonly route: SessionRoute }) {
    const { connection } = useViewEnvironment();
    const connected = connection.phase === "attached";
    const { watch, loadOlder, send } = useSessionWatch(bridge, route.agentId, connected);
    const panes = usePaneLayout();
    const rightPaneShown = useIsShown("rightPane");
    const row = connection.sessionRows?.find((candidate) => candidate.id === route.agentId);
    const folder = row === undefined || row.workspace.length === 0 ? route.workspace : row.workspace;
    const scroller = usePinnedScroll();
    const blocks = useMemo(() => [...watch.history, ...watch.live], [watch.history, watch.live]);
    const companion = panes.layout === "single" ? undefined : companionFor(route.agentId, panes.companion, connection.sessionRows);
    const running = watch.status !== "idle";
    const title = watch.title ?? row?.name ?? route.title;

    useEffect(() => {
        publishActiveSession({ bridge, agentId: route.agentId, title, folder, watch, send });
    }, [bridge, route.agentId, title, folder, watch, send]);
    useEffect(() => () => clearActiveSession(route.agentId), [route.agentId]);


    const showMessage = blocks.length === 0 && (watch.phase === "failed" || watch.phase === "closed" || watch.phase === "attaching");
    const body = showMessage ? (
        <SessionMessage
            title={route.title}
            text={watch.phase === "attaching" ? "Opening the session." : watch.error ?? "The session closed."}
        />
    ) : (
        <div className="transcript-scroll" ref={scroller.ref} onScroll={scroller.onScroll} data-session={route.agentId} data-phase={watch.phase}>
            <div className="transcript">
                <div className="transcript-inner">
                    {watch.hasOlder && watch.history.length >= MAX_HISTORY_BLOCKS ? (
                        <p className="trim-strip" data-limit="true">Earlier messages are past what this view keeps loaded.</p>
                    ) : watch.hasOlder ? (
                        <button type="button" className="trim-strip" disabled={watch.loadingOlder} onClick={loadOlder}>
                            {watch.loadingOlder ? "Loading earlier messages" : "Show earlier messages"}
                        </button>
                    ) : null}
                    {blocks.length === 0 ? (
                        <p className="transcript-empty">Nothing has been said in this session yet.</p>
                    ) : (
                        <Transcript blocks={blocks} running={running} {...(folder === undefined ? {} : { folder })} />
                    )}
                    {watch.phase === "closed" || watch.phase === "failed" ? (
                        <div className="transcript-notice" data-tone="warning">{watch.error ?? "The session closed."}</div>
                    ) : null}
                    <RequestCards requests={watch.requests} send={send} />
                    <QueueStrip queue={watch.queue} onRelease={() => send(releaseQueuedCommand("one"))} />
                </div>
            </div>
        </div>
    );

    return (
        <div className="session-page">
            <div className="session-body">
                <div className="agent-panes" data-layout={companion === undefined ? "single" : panes.layout}>
                    {body}
                    {companion === undefined ? null : (
                        <CompanionPane key={companion} bridge={bridge} agentId={companion} connected={connected} />
                    )}
                </div>
                {rightPaneShown ? null : <SessionRail />}
            </div>
            <div className="composer-wrap">
                <Composer
                    key={route.agentId}
                    mode="session"
                    bridge={bridge}
                    agentId={route.agentId}
                    watch={watch}
                    send={send}
                    folder={folder}
                />
            </div>
        </div>
    );
}

function SessionMessage({ title, text }: { readonly title: string; readonly text: string }) {
    return (
        <div className="transcript-scroll">
            <div className="transcript">
                <div className="transcript-inner">
                    <div className="session-message">
                        <h2 className="empty-state-title">{title}</h2>
                        <p className="empty-state-text">{text}</p>
                    </div>
                </div>
            </div>
        </div>
    );
}
