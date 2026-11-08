import { randomUUID } from "node:crypto";

import { withSessionReservations, type RestoringSessions } from "../session-host/storage.ts";
import type { ControlPeer } from "./control.ts";

interface HeldReservation {
    readonly release: () => void;
}

export class ControlReservations {
    private readonly held = new Map<string, HeldReservation>();

    constructor(private readonly reservations: RestoringSessions) {}

    async acquire(paths: readonly string[], signal: AbortSignal): Promise<string> {
        signal.throwIfAborted();
        const token = randomUUID();
        const acquired = Promise.withResolvers<void>();
        const hold = Promise.withResolvers<void>();
        this.held.set(token, { release: hold.resolve });
        const abort = (): void => hold.resolve();
        signal.addEventListener("abort", abort, { once: true });
        void withSessionReservations(paths, this.reservations, async () => {
            acquired.resolve();
            await hold.promise;
        }).catch((error: unknown) => acquired.reject(error)).finally(() => {
            signal.removeEventListener("abort", abort);
            this.held.delete(token);
        });
        await acquired.promise;
        signal.throwIfAborted();
        return token;
    }

    release(token: string): void { this.held.get(token)?.release(); }

    close(): void {
        for (const reservation of this.held.values()) reservation.release();
        this.held.clear();
    }
}

export function remoteReservations(peer: ControlPeer): RestoringSessions {
    const reservations: RestoringSessions = new Map();
    reservations.withReservations = async <T>(paths: readonly string[], run: () => Promise<T>): Promise<T> => {
        const token = await peer.request<string>("reservation.acquire", [paths]);
        try {
            return await run();
        } finally {
            await peer.request("reservation.release", [token]).catch(() => {});
        }
    };
    return reservations;
}
