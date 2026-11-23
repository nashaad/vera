import { expect, test } from "bun:test";

import { INITIAL_STATE, reduceConnection } from "../../clients/ui/src/state/connection.ts";
import type { SessionRow } from "../../clients/ui/src/protocol/sessions.ts";

const oldRows: SessionRow[] = [{ id: "old", name: "Old", workspace: "", status: "idle", live: false, chat: true }];
const freshRows: SessionRow[] = [{ id: "fresh", name: "Fresh", workspace: "", status: "idle", live: false, chat: true }];
const ready = { type: "ready" as const, pid: 1, socketPath: "/home-a/host.sock", buildId: null, home: "/home-a" };

test("@core cached sessions are stale only until fresh rows arrive", () => {
    const attached = reduceConnection(INITIAL_STATE, { type: "event", event: ready });
    const stale = reduceConnection(attached, { type: "cached-sessions", home: "/home-a", rows: oldRows });
    expect(stale.sessionRows).toEqual(oldRows);
    expect(stale.sessionRowsStale).toBe(true);
    const fresh = reduceConnection(stale, { type: "sessions", rows: freshRows, count: 1 });
    expect(fresh.sessionRows).toEqual(freshRows);
    expect(fresh.sessionRowsStale).toBe(false);
    expect(reduceConnection(fresh, { type: "cached-sessions", home: "/home-a", rows: oldRows })).toBe(fresh);
    expect(reduceConnection(attached, { type: "cached-sessions", home: "/home-b", rows: oldRows })).toBe(attached);
    const lost = reduceConnection(stale, { type: "lost", reason: "gone" });
    expect(lost.phase).toBe("disconnected");
    expect(lost.sessionRows).toBeUndefined();
    expect(reduceConnection(lost, { type: "cached-sessions", home: "/home-a", rows: oldRows })).toBe(lost);
});
