import { surfaceCanShow, type ShowSurface, type ShowTarget } from "../help/show-targets.ts";

export interface SessionShowOutcome {
    /** Windows the target was sent to. */
    readonly window: number;
    /** Terminals the target was sent to. */
    readonly terminal: number;
    /** Terminals that are attached but have no screen for the target. */
    readonly terminalCannot: number;
}

export type SessionShowListener = (target: ShowTarget) => void;

/** Fans a one-shot show request out to the clients attached to one session. Nothing is replayed to a client that attaches later. */
export interface SessionShowHub {
    subscribe(agentId: string, surface: ShowSurface, listener: SessionShowListener): () => void;
    show(agentId: string, target: ShowTarget): SessionShowOutcome;
}

export function createSessionShowHub(): SessionShowHub {
    const subscribers = new Map<string, Set<{ readonly surface: ShowSurface; readonly listener: SessionShowListener }>>();
    return {
        subscribe(agentId, surface, listener) {
            const entry = { surface, listener };
            let set = subscribers.get(agentId);
            if (set === undefined) {
                set = new Set();
                subscribers.set(agentId, set);
            }
            set.add(entry);
            return () => {
                const current = subscribers.get(agentId);
                current?.delete(entry);
                if (current?.size === 0) subscribers.delete(agentId);
            };
        },
        show(agentId, target) {
            let window = 0;
            let terminal = 0;
            let terminalCannot = 0;
            for (const { surface, listener } of [...subscribers.get(agentId) ?? []]) {
                if (!surfaceCanShow(surface, target)) {
                    terminalCannot += 1;
                    continue;
                }
                try {
                    listener(target);
                } catch {
                    continue;
                }
                if (surface === "window") window += 1;
                else terminal += 1;
            }
            return { window, terminal, terminalCannot };
        },
    };
}
