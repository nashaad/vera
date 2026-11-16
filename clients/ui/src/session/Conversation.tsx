import { useCallback, useEffect, useMemo, type KeyboardEvent, type ReactNode } from "react";

import { showTarget } from "../commands/show-target.ts";
import { Composer } from "../composer/Composer.tsx";
import type { DesktopBridge, SessionPane } from "../protocol/bridge.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import { CompactionStatus } from "./LiveStatus.tsx";
import { canStart, watchEnded } from "./liveSession.ts";
import { MAX_HISTORY_BLOCKS, type SessionWatch } from "./model.ts";
import type { PaneLayout } from "./paneLayout.ts";
import { QueueStrip } from "./QueueStrip.tsx";
import { RequestCards } from "./RequestCards.tsx";
import { holdsTurn } from "./requests.ts";
import { StartSessionButton } from "./StartSession.tsx";
import { Transcript } from "./Transcript.tsx";
import { watchOpening } from "./transcript.ts";
import { usePinnedScroll } from "./usePinnedScroll.ts";
import { useSessionWatch } from "./useSessionWatch.ts";
import { useSlowOpening } from "./useSlowOpening.ts";
import { useStartAgent } from "./useStartAgent.ts";
import { HELP_AGENT } from "../chat/help.ts";
import { abortCommand, releaseQueuedCommand } from "./wire.ts";

// What the page publishes about the session it shows.
export interface ConversationState {
    readonly title: string;
    readonly folder: string | undefined;
    readonly chat: boolean;
    readonly watch: SessionWatch;
    readonly send: (line: string) => void;
    readonly start: () => void;
}

export interface ConversationProps {
    readonly bridge: DesktopBridge;
    readonly agentId: string;
    // The connection this conversation reads and writes; each place that shows one has its own.
    readonly pane: SessionPane;
    // What the session is called and where it runs until the session list carries its row.
    readonly title: string;
    readonly workspace: string | undefined;
    readonly chat: boolean;
    // A subagent's conversation shown beside or below this one.
    readonly companion?: { readonly layout: PaneLayout; readonly node: ReactNode };
    readonly rail?: ReactNode;
    readonly onState?: (state: ConversationState) => void;
}

// One session's transcript, request cards and composer. The page and each Chat tab show it.
export function Conversation({ bridge, agentId, pane, title: fallbackTitle, workspace, chat: fallbackChat, companion, rail, onState }: ConversationProps) {
    const { connection, refreshSessions } = useViewEnvironment();
    const connected = connection.phase === "attached";
    const { run } = useWorkbench();
    // The host asks the window to open a screen; an id it does not know is ignored.
    const onShow = useCallback((target: string) => {
        showTarget(target, run);
    }, [run]);
    const { watch, loadOlder, send, reattach, start } = useSessionWatch(bridge, agentId, connected, pane, onShow);
    const agentStart = useStartAgent(bridge, agentId, watch.phase === "attached", send, pane);
    const helpRefused = agentStart.name === HELP_AGENT ? agentStart.refused : undefined;
    // The host ended this session's watch while it moved; open it again and read the row's new folder.
    const onMoved = useCallback(() => {
        reattach();
        refreshSessions();
    }, [reattach, refreshSessions]);
    const row = connection.sessionRows?.find((candidate) => candidate.id === agentId);
    const folder = row === undefined || row.workspace.length === 0 ? workspace : row.workspace;
    const chat = row?.chat ?? fallbackChat;
    const scroller = usePinnedScroll();
    const blocks = useMemo(() => [...watch.history, ...watch.live], [watch.history, watch.live]);
    const running = watch.status !== "idle";
    const compacting = watch.compaction?.phase === "started" ? watch.compaction : undefined;
    // A running turn shows the compaction on its own status line; otherwise the line stands alone at the end.
    const liveTurn = running && blocks.length > 0;
    const title = watch.title ?? row?.name ?? fallbackTitle;
    const slowOpening = useSlowOpening(watch);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.defaultPrevented || event.key !== "Escape" || event.ctrlKey || event.metaKey
            || event.altKey || event.shiftKey || event.nativeEvent.isComposing || !running
            || watch.requests.length > 0) return;
        const target = event.target;
        if (!(target instanceof HTMLElement)
            || !target.matches(".composer-input, .transcript-scroll")) return;
        if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [data-popover]') !== null) return;
        event.preventDefault();
        const input = event.currentTarget.querySelector<HTMLTextAreaElement>(".composer-input");
        const hasDraft = (input?.value.trim().length ?? 0) > 0
            || event.currentTarget.querySelector(".chip-file") !== null;
        send(!hasDraft && watch.queue.length > 0 ? releaseQueuedCommand("one") : abortCommand());
    };

    useEffect(() => {
        onState?.({ title, folder, chat, watch, send, start });
    }, [onState, title, folder, chat, watch, send, start]);

    const ended = watchEnded(watch);
    const startable = canStart(watch);
    const showMessage = blocks.length === 0 && (ended || slowOpening);
    const body = showMessage ? (
        <SessionMessage
            title={title}
            text={ended ? watch.error ?? "The session closed." : "Opening the session."}
            {...(startable ? { onStart: start } : {})}
        />
    ) : (
        <div className="transcript-scroll" ref={scroller.ref} onScroll={scroller.onScroll} data-session={agentId} data-phase={watch.phase} tabIndex={0}
            onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
            onDrop={(event) => {
                if (event.dataTransfer.files.length === 0) return;
                event.preventDefault();
                window.dispatchEvent(new CustomEvent("vera-composer-drop", { detail: { agentId, files: [...event.dataTransfer.files] } }));
            }}>
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
                        watchOpening(watch) ? null : <p className="transcript-empty">Nothing has been said in this session yet.</p>
                    ) : (
                        <Transcript
                            blocks={blocks}
                            running={running}
                            status={watch.status !== "idle" && holdsTurn(watch.requests) ? "waiting" : watch.status}
                            {...(watch.retry === undefined ? {} : { retry: watch.retry })}
                            {...(folder === undefined ? {} : { folder })}
                            {...(compacting === undefined || !liveTurn ? {} : { compaction: compacting })}
                            replyMenu
                        />
                    )}
                    {compacting === undefined || liveTurn ? null : <CompactionStatus compaction={compacting} />}
                    {ended ? (
                        <div className="transcript-notice" data-tone="warning" data-start={startable}>
                            <span>{watch.error ?? "The session closed."}</span>
                            {startable ? <StartSessionButton onStart={start} /> : null}
                        </div>
                    ) : null}
                    {helpRefused === undefined ? null : (
                        <div className="transcript-notice" data-tone="warning">
                            <span>{`Help did not start. ${helpRefused}`}</span>
                        </div>
                    )}
                    <RequestCards
                        key={agentId}
                        requests={watch.requests}
                        send={send}
                        running={running}
                        {...(watch.approval === undefined
                            ? {}
                            : { mode: watch.approval.mode, modes: watch.approval.modes })}
                    />
                    <QueueStrip queue={watch.queue} onRelease={() => send(releaseQueuedCommand("one"))} />
                </div>
            </div>
        </div>
    );

    return (
        <div className="session-page" data-pane={pane} onKeyDown={onKeyDown}>
            <div className="session-body">
                <div className="agent-panes" data-layout={companion === undefined ? "single" : companion.layout}>
                    {body}
                    {companion?.node}
                </div>
                {rail}
            </div>
            <div className="composer-wrap">
                <Composer
                    key={agentId}
                    mode="session"
                    bridge={bridge}
                    agentId={agentId}
                    pane={pane}
                    watch={watch}
                    send={send}
                    folder={folder}
                    chat={chat}
                    onMoved={onMoved}
                    agentStart={agentStart}
                />
            </div>
        </div>
    );
}

interface SessionMessageProps {
    readonly title: string;
    readonly text: string;
    readonly onStart?: () => void;
}

export function SessionMessage({ title, text, onStart }: SessionMessageProps) {
    return (
        <div className="transcript-scroll">
            <div className="transcript">
                <div className="transcript-inner">
                    <div className="session-message">
                        <h2 className="empty-state-title">{title}</h2>
                        <p className="empty-state-text">{text}</p>
                        {onStart === undefined ? null : (
                            <div className="session-message-action">
                                <StartSessionButton onStart={onStart} />
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
