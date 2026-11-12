import { useCallback, useEffect, useReducer } from "react";

import { getModelSettingsCommand } from "../models/commands.ts";
import type { DesktopBridge, SessionPane } from "../protocol/bridge.ts";
import type { SessionWatch } from "./model.ts";
import { getPermissionsCommand } from "./permissions.ts";
import { beginOlder, canLoadOlder, initialWatch, reduceWatch, watchClosed } from "./transcript.ts";
import { historyPageRequest, parseSessionLine, type SessionMessage } from "./wire.ts";

type WatchAction =
    | { readonly type: "reset"; readonly agentId: string }
    | { readonly type: "message"; readonly message: SessionMessage }
    | { readonly type: "closed"; readonly reason: string }
    | { readonly type: "older" };

function reduce(state: SessionWatch, action: WatchAction): SessionWatch {
    switch (action.type) {
        case "reset":
            return initialWatch(action.agentId);
        case "message":
            return reduceWatch(state, action.message);
        case "closed":
            return watchClosed(state, action.reason);
        case "older":
            return beginOlder(state);
    }
}

export interface SessionWatchHandle {
    readonly watch: SessionWatch;
    readonly loadOlder: () => void;
    // Writes one command line on the watch connection; dropped until it is connected.
    readonly send: (line: string) => void;
}

let requestCount = 0;

// One watch connection per pane: opening another session in the pane closes this one in the shell.
// `connected` reopens the watch after the host connection comes back.
export function useSessionWatch(
    bridge: DesktopBridge,
    agentId: string,
    connected: boolean,
    pane: SessionPane = "main",
): SessionWatchHandle {
    const [watch, dispatch] = useReducer(reduce, agentId, initialWatch);
    useEffect(() => {
        dispatch({ type: "reset", agentId });
        if (!connected) return undefined;
        const off = bridge.onEvent((event) => {
            if (event.type === "session_frame" && event.pane === pane && event.agentId === agentId) {
                const message = parseSessionLine(event.text);
                if (message !== undefined) dispatch({ type: "message", message });
            } else if (event.type === "session_closed" && event.pane === pane && event.agentId === agentId) {
                dispatch({ type: "closed", reason: event.reason });
            }
        });
        bridge.watchSession(pane, agentId);
        return () => {
            off();
            bridge.unwatchSession(pane);
        };
    }, [bridge, agentId, connected, pane]);
    // The approval mode and the model are not part of history, so both are asked for on every attach.
    const attached = watch.phase === "attached";
    useEffect(() => {
        if (!attached) return;
        requestCount += 1;
        const stamp = `${Date.now().toString(36)}-${requestCount}`;
        bridge.sendSession(pane, getPermissionsCommand(`desktop-permissions-${stamp}`));
        bridge.sendSession(pane, getModelSettingsCommand(`desktop-models-${stamp}`));
    }, [bridge, attached, pane]);
    const ready = canLoadOlder(watch);
    const { olderBefore } = watch;
    const loadOlder = useCallback(() => {
        if (!ready || olderBefore === undefined) return;
        requestCount += 1;
        dispatch({ type: "older" });
        bridge.sendSession(pane, historyPageRequest(`page-${requestCount}`, olderBefore));
    }, [bridge, ready, olderBefore, pane]);
    const send = useCallback((line: string) => bridge.sendSession(pane, line), [bridge, pane]);
    return { watch, loadOlder, send };
}
