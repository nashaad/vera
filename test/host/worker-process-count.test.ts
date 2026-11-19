import { expect, test } from "bun:test";

import { createWorkerBoundaryServer } from "../../src/host/worker/boundary-server.ts";
import type { JsonPipe } from "../../src/host/worker/pipe.ts";
import type { SessionStore } from "../../src/store/session-store.ts";

test("@core worker boundary accepts only valid process count notifications", () => {
    const counts: Array<{ ownerId: string; count: number }> = [];
    const pipe: JsonPipe = {
        closed: new Promise<void>(() => {}),
        request: async () => { throw new Error("Unexpected pipe request"); },
        notify: () => { throw new Error("Unexpected pipe notification"); },
        close: () => {},
    };
    const server = createWorkerBoundaryServer({
        pipe,
        store: {} as SessionStore,
        services: {},
        onProcessCountChanged: (ownerId, count) => counts.push({ ownerId, count }),
    });

    server.handleNotification({ method: "process.count", ownerId: "session-a", count: 0 });
    server.handleNotification({ method: "process.count", ownerId: "session-b", count: 3 });
    for (const value of [
        { ownerId: "", count: 1 },
        { ownerId: "   ", count: 1 },
        { ownerId: 1, count: 1 },
        { ownerId: "session-c", count: -1 },
        { ownerId: "session-c", count: 0.5 },
        { ownerId: "session-c", count: Number.MAX_SAFE_INTEGER + 1 },
        { ownerId: "session-c", count: "1" },
    ]) {
        server.handleNotification({ method: "process.count", ...value });
    }

    expect(counts).toEqual([
        { ownerId: "session-a", count: 0 },
        { ownerId: "session-b", count: 3 },
    ]);
});
