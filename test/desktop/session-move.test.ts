import { expect, test } from "bun:test";

import { moveSessionToFolder } from "../../clients/desktop/src/session-move.ts";
import type { MoveSessionOutcome } from "../../clients/ui/src/protocol/sessionMove.ts";

interface MoveCall {
    readonly socketPath: string;
    readonly sessionId: string;
    readonly workspace: string;
}

function recorder(result: MoveSessionOutcome): { calls: MoveCall[]; move: (...args: [string, string, string]) => Promise<MoveSessionOutcome> } {
    const calls: MoveCall[] = [];
    return {
        calls,
        move: async (socketPath, sessionId, workspace) => {
            calls.push({ socketPath, sessionId, workspace });
            return result;
        },
    };
}

test("@core a picked folder is sent to the host and its answer comes back", async () => {
    const host = recorder({ status: "moved", workspace: "/work/alpha" });
    const outcome = await moveSessionToFolder({
        socketPath: "/run/host.sock",
        sessionId: "s1",
        chooseFolder: async () => "/work/alpha",
        move: host.move,
    });
    expect(outcome).toEqual({ status: "moved", workspace: "/work/alpha" });
    expect(host.calls).toEqual([{ socketPath: "/run/host.sock", sessionId: "s1", workspace: "/work/alpha" }]);
});

test("@core a cancelled picker sends nothing", async () => {
    const host = recorder({ status: "moved", workspace: "/unused" });
    const cancelled = await moveSessionToFolder({
        socketPath: "/run/host.sock",
        sessionId: "s1",
        chooseFolder: async () => undefined,
        move: host.move,
    });
    const empty = await moveSessionToFolder({
        socketPath: "/run/host.sock",
        sessionId: "s1",
        chooseFolder: async () => "",
        move: host.move,
    });
    expect(cancelled).toEqual({ status: "cancelled" });
    expect(empty).toEqual({ status: "cancelled" });
    expect(host.calls).toEqual([]);
});

test("@core each host refusal reaches the caller with its reason", async () => {
    for (const reason of ["invalid", "busy", "not_found", "collision", "failed"] as const) {
        const host = recorder({ status: "rejected", reason });
        const outcome = await moveSessionToFolder({
            socketPath: "/run/host.sock",
            sessionId: "s1",
            chooseFolder: async () => "/work/alpha",
            move: host.move,
        });
        expect(outcome).toEqual({ status: "rejected", reason });
    }
});

test("@core with no host the picker never opens and the move fails", async () => {
    let opened = false;
    const host = recorder({ status: "moved", workspace: "/unused" });
    const outcome = await moveSessionToFolder({
        socketPath: undefined,
        sessionId: "s1",
        chooseFolder: async () => {
            opened = true;
            return "/work/alpha";
        },
        move: host.move,
    });
    expect(outcome).toEqual({ status: "rejected", reason: "failed" });
    expect(opened).toBe(false);
    expect(host.calls).toEqual([]);
});

test("@core a picker that throws fails the move without contacting the host", async () => {
    const host = recorder({ status: "moved", workspace: "/unused" });
    const outcome = await moveSessionToFolder({
        socketPath: "/run/host.sock",
        sessionId: "s1",
        chooseFolder: async () => {
            throw new Error("dialog closed");
        },
        move: host.move,
    });
    expect(outcome).toEqual({ status: "rejected", reason: "failed" });
    expect(host.calls).toEqual([]);
});
