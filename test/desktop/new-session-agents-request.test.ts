import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseNewSessionAgents, readNewSessionAgents } from "../../clients/desktop/src/agent-requests.ts";
import { socketTest } from "../support/socket-probe.ts";

const LISTING = {
    type: "new_session_agents",
    starts_on: "default",
    agents: [
        { name: "default", scope: "extension", writable: false },
        { name: "plan", scope: "project", writable: true, description: "Plans before it edits", posture: "readonly" },
    ],
    notices: ["Skipped broken.md"],
};

describe("the host's answer", () => {
    test("@core a listing is read with the agents, the name a new session starts on and the notices", () => {
        expect(parseNewSessionAgents(LISTING)).toEqual({
            ok: true,
            startsOn: "default",
            agents: [
                { name: "default", scope: "extension", writable: false },
                { name: "plan", scope: "project", writable: true, description: "Plans before it edits", posture: "readonly" },
            ],
            notices: ["Skipped broken.md"],
        });
    });

    test("a listing with no notices is still a listing, and entries this window cannot read are dropped", () => {
        const { notices: _notices, ...bare } = LISTING;
        const parsed = parseNewSessionAgents({ ...bare, agents: [...LISTING.agents, { name: 7 }, "crow"] });
        expect(parsed).toMatchObject({ ok: true, notices: [] });
        expect(parsed?.ok && parsed.agents.map((entry) => entry.name)).toEqual(["default", "plan"]);
    });

    test("@core anything else is refused", () => {
        for (const reply of [
            undefined,
            null,
            "agents",
            [],
            { type: "protocol_error" },
            { ...LISTING, type: "agent_catalog" },
            { ...LISTING, starts_on: "" },
            { ...LISTING, starts_on: 3 },
            { ...LISTING, agents: "plan" },
            { type: "new_session_agents", agents: [] },
        ]) {
            expect(parseNewSessionAgents(reply)).toBeUndefined();
        }
    });
});

describe("asking the host", () => {
    test("no host socket means no list", async () => {
        expect(await readNewSessionAgents(undefined, "/nest")).toEqual({ ok: false, reason: "The host is not running." });
    });

    socketTest("@core a host that closes the connection on this request, as an older one does, reads as not offered", async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-old-host-"));
        const socketPath = join(root, "old.sock");
        const server = createServer((socket) => {
            socket.on("data", () => socket.destroy());
        });
        try {
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(socketPath, resolve);
            });
            const result = await readNewSessionAgents(socketPath, undefined);
            expect(result.ok).toBe(false);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(root, { recursive: true, force: true });
        }
    });
});
