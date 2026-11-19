import { useSyncExternalStore } from "react";

import type { DesktopBridge } from "../protocol/bridge.ts";
import { INITIAL_UPDATE_STATE, type UpdateAction, type UpdateState } from "../protocol/updates.ts";

export type UpdateBridge = Pick<DesktopBridge, "onEvent" | "updateState" | "updateAct">;

export interface UpdateStore {
    current(): UpdateState;
    subscribe(listener: () => void): () => void;
    act(action: UpdateAction): void;
}

// Holds the shell's update state for the page. It listens to the shell while something is subscribed.
export function createUpdateStore(bridgeOf: () => UpdateBridge | undefined): UpdateStore {
    let state: UpdateState = INITIAL_UPDATE_STATE;
    const listeners = new Set<() => void>();
    let stopListening: (() => void) | undefined;

    const publish = (next: UpdateState): void => {
        state = next;
        for (const listener of listeners) listener();
    };

    const attach = (): void => {
        const bridge = bridgeOf();
        if (bridge === undefined) return;
        let heard = false;
        const off = bridge.onEvent((event) => {
            if (event.type !== "update_state") return;
            heard = true;
            publish(event.state);
        });
        let attached = true;
        stopListening = () => {
            attached = false;
            off();
        };
        // An event that arrives before the first answer is newer than the answer.
        void bridge.updateState().then((initial) => {
            if (attached && !heard && initial !== undefined) publish(initial);
        }, () => undefined);
    };

    return {
        current: () => state,
        subscribe: (listener) => {
            if (listeners.size === 0) attach();
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
                if (listeners.size === 0) {
                    stopListening?.();
                    stopListening = undefined;
                }
            };
        },
        act: (action) => bridgeOf()?.updateAct(action),
    };
}

const store = createUpdateStore(() => (typeof window === "undefined" ? undefined : window.veraDesktop));

export function useUpdateState(): UpdateState {
    return useSyncExternalStore(store.subscribe, store.current);
}

export function actOnUpdate(action: UpdateAction): void {
    store.act(action);
}
