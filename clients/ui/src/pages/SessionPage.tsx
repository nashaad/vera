import { useEffect, useRef } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";
import { MAX_HISTORY_BLOCKS } from "../session/model.ts";
import { Transcript } from "../session/Transcript.tsx";
import { useSessionWatch } from "../session/useSessionWatch.ts";
import { useViewEnvironment } from "../views/env.tsx";
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
    const { watch, loadOlder } = useSessionWatch(bridge, route.agentId, connection.phase === "attached");
    const scroller = useRef<HTMLDivElement>(null);
    const blocks = [...watch.history, ...watch.live];
    const running = watch.status !== "idle";
    const pinned = useRef(true);

    // Stays at the bottom while new blocks arrive, unless the reader scrolled up.
    useEffect(() => {
        const element = scroller.current;
        if (element !== null && pinned.current) element.scrollTop = element.scrollHeight;
    }, [blocks.length, watch.live]);

    const onScroll = (): void => {
        const element = scroller.current;
        if (element === null) return;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    };

    if (watch.phase === "failed" || watch.phase === "closed") {
        if (blocks.length === 0) return <SessionMessage title={route.title} text={watch.error ?? "The session closed."} />;
    }
    if (watch.phase === "attaching" && blocks.length === 0) {
        return <SessionMessage title={route.title} text="Opening the session." />;
    }
    return (
        <div className="transcript-scroll" ref={scroller} onScroll={onScroll} data-session={route.agentId} data-phase={watch.phase}>
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
                        <Transcript blocks={blocks} running={running} />
                    )}
                    {watch.phase === "closed" || watch.phase === "failed" ? (
                        <div className="transcript-notice" data-tone="warning">{watch.error ?? "The session closed."}</div>
                    ) : null}
                </div>
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
