import { useCallback, useEffect, useReducer } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";
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

// One watch connection at a time: opening another session closes this one in the shell.
// `connected` reopens the watch after the host connection comes back.
export function useSessionWatch(
    bridge: DesktopBridge,
    agentId: string,
    connected: boolean,
): SessionWatchHandle {
    const [watch, dispatch] = useReducer(reduce, agentId, initialWatch);
    useEffect(() => {
        dispatch({ type: "reset", agentId });
        if (!connected) return undefined;
        const off = bridge.onEvent((event) => {
            if (event.type === "session_frame" && event.agentId === agentId) {
                const message = parseSessionLine(event.text);
                if (message !== undefined) dispatch({ type: "message", message });
            } else if (event.type === "session_closed" && event.agentId === agentId) {
                dispatch({ type: "closed", reason: event.reason });
            }
        });
        bridge.watchSession(agentId);
        return () => {
            off();
            bridge.unwatchSession();
        };
    }, [bridge, agentId, connected]);
    // The approval mode is not part of history, so it is asked for on every attach.
    const attached = watch.phase === "attached";
    useEffect(() => {
        if (!attached) return;
        requestCount += 1;
        bridge.sendSession(getPermissionsCommand(`desktop-permissions-${Date.now().toString(36)}-${requestCount}`));
    }, [bridge, attached]);
    const ready = canLoadOlder(watch);
    const { olderBefore } = watch;
    const loadOlder = useCallback(() => {
        if (!ready || olderBefore === undefined) return;
        requestCount += 1;
        dispatch({ type: "older" });
        bridge.sendSession(historyPageRequest(`page-${requestCount}`, olderBefore));
    }, [bridge, ready, olderBefore]);
    const send = useCallback((line: string) => bridge.sendSession(line), [bridge]);
    return { watch, loadOlder, send };
}
