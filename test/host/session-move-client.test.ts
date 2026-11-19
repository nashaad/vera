import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionMoveRejectedReason } from "../../src/host/protocol.ts";
import { moveSessionThroughHost, type MoveRejectionReason } from "../../src/host/session-move-client.ts";
import { startHostServer } from "../../src/host/server.ts";
import { socketTest } from "../support/socket-probe.ts";

// Fails to compile when the host and the client disagree on the reasons.
const sameReasons: [SessionMoveRejectedReason, MoveRejectionReason] = [
    "failed" as MoveRejectionReason,
    "failed" as SessionMoveRejectedReason,
];
void sameReasons;

socketTest(
    "session move client preserves typed host outcomes",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-session-move-client-"));
        const socketPath = join(root, "host.sock");
        const calls: unknown[][] = [];
        const host = await startHostServer({
            socketPath,
            lockPath: join(root, "host.json"),
            moveSession: async (targetId, request) => {
                calls.push([targetId, request]);
                if (targetId === "saved") return { status: "moved", workspace: request.workspace };
                if (targetId === "attached") return { status: "busy" };
                if (targetId === "taken") return { status: "collision" };
                if (targetId === "odd") return { status: "invalid" };
                if (targetId === "broken") throw new Error("disk gone");
                return { status: "not_found" };
            },
        });

        try {
            expect(await moveSessionThroughHost(socketPath, "saved", "/work/project"))
                .toEqual({ status: "moved", workspace: "/work/project" });
            expect(await moveSessionThroughHost(socketPath, "gone", "/work/project"))
                .toEqual({ status: "rejected", reason: "not_found" });
            expect(await moveSessionThroughHost(socketPath, "attached", "/work/project"))
                .toEqual({ status: "rejected", reason: "busy" });
            expect(await moveSessionThroughHost(socketPath, "taken", "/work/project"))
                .toEqual({ status: "rejected", reason: "collision" });
            expect(await moveSessionThroughHost(socketPath, "odd", "/work/project"))
                .toEqual({ status: "rejected", reason: "invalid" });
            expect(await moveSessionThroughHost(socketPath, "broken", "/work/project"))
                .toEqual({ status: "rejected", reason: "failed" });
            expect(calls).toEqual([
                ["saved", { workspace: "/work/project" }],
                ["gone", { workspace: "/work/project" }],
                ["attached", { workspace: "/work/project" }],
                ["taken", { workspace: "/work/project" }],
                ["odd", { workspace: "/work/project" }],
                ["broken", { workspace: "/work/project" }],
            ]);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
);

socketTest(
    "session move client normalizes transport failure",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-session-move-client-"));
        try {
            expect(await moveSessionThroughHost(join(root, "missing.sock"), "saved", "/work/project"))
                .toEqual({ status: "rejected", reason: "failed" });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    },
);
