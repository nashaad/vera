import { useEffect, useReducer, useRef } from "react";

import type { DesktopEvent } from "../protocol/bridge.ts";
import { HostProtocolClient } from "../protocol/client.ts";
import { INITIAL_STATE, reduceConnection, type UiState } from "./connection.ts";

const POLL_MS = 3_000;

export interface HostConnection {
    readonly state: UiState;
    reconnect(): void;
    answer(id: string, yes: boolean): void;
}

export function useHostConnection(): HostConnection {
    const [state, dispatch] = useReducer(reduceConnection, INITIAL_STATE);
    const clientRef = useRef<HostProtocolClient | undefined>(undefined);
    // Bumped whenever the connection changes, so a late reply never lands on a newer one.
    const generationRef = useRef(0);

    const dropClient = (reason: string): void => {
        generationRef.current += 1;
        clientRef.current?.failAll(reason);
        clientRef.current = undefined;
    };

    const refresh = (client: HostProtocolClient, generation: number): void => {
        const current = (): boolean => generationRef.current === generation;
        client.hostIdentity().then((identity) => {
            if (current()) dispatch({ type: "identity", identity });
        }).catch((error: unknown) => {
            if (!current()) return;
            dropClient(messageOf(error));
            dispatch({ type: "lost", reason: messageOf(error) });
        });
        client.countSessions().then((count) => {
            if (current()) dispatch({ type: "sessions", count });
        }).catch((error: unknown) => {
            if (current()) dispatch({ type: "notice", message: messageOf(error) });
        });
    };

    useEffect(() => {
        const bridge = window.veraDesktop;
        if (bridge === undefined) {
            dispatch({
                type: "event",
                event: { type: "failed", message: "This page runs only inside the desktop app." },
            });
            return;
        }
        const onEvent = (event: DesktopEvent): void => {
            if (event.type === "frame") {
                clientRef.current?.feed(event.text);
                return;
            }
            if (event.type === "ready") {
                dropClient("Reconnecting.");
                const client = new HostProtocolClient((text) => window.veraDesktop.send(text));
                clientRef.current = client;
                dispatch({ type: "event", event });
                refresh(client, generationRef.current);
                return;
            }
            if (event.type === "missing_cli" || event.type === "failed") {
                dropClient("Vera did not start.");
            } else if (event.type === "disconnected") {
                dropClient(event.reason);
            }
            dispatch({ type: "event", event });
        };
        const unsubscribe = bridge.onEvent(onEvent);
        bridge.start();
        return () => {
            unsubscribe();
            dropClient("The window closed.");
        };
    }, []);

    useEffect(() => {
        if (state.phase !== "attached") return;
        const timer = setInterval(() => {
            const client = clientRef.current;
            if (client !== undefined) refresh(client, generationRef.current);
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [state.phase]);

    return {
        state,
        reconnect: () => {
            dropClient("Reconnecting.");
            dispatch({ type: "reconnecting" });
            window.veraDesktop.reconnect();
        },
        answer: (id, yes) => {
            window.veraDesktop.answer(id, yes);
            dispatch({ type: "answered" });
        },
    };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
