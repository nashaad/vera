import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseNewSessionAgents, readNewSessionAgents } from "../../clients/desktop/src/agent-requests.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
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

    socketTest("@core a real host answers for a folder and for a chat, and the window reads both", async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-desktop-new-agents-"));
        const home = join(root, "home");
        const folder = join(root, "crow-nest");
        await mkdir(join(home, "agents"), { recursive: true });
        await mkdir(join(folder, ".vera", "agents"), { recursive: true });
        await writeFile(join(home, "agents", "scout.md"), "---\ndescription: Looks ahead\n---\nScout.");
        await writeFile(join(folder, ".vera", "agents", "plan.md"), "---\ndescription: Plans before it edits\n---\nPlan only.");
        const previousHome = process.env.VERA_HOME;
        process.env.VERA_HOME = home;
        const host = await startResidentHost({
            config: { schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "auto" },
            createAdapter: () => new FauxAdapter([]),
            home,
            socketPath: join(root, "host.sock"),
            lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"),
            eventLogDirectory: join(root, "logs"),
        });
        try {
            const inFolder = await readNewSessionAgents(host.server.socketPath, folder);
            if (!inFolder.ok) throw new Error(inFolder.reason);
            expect(inFolder.startsOn).toBe("default");
            expect(inFolder.agents.find((entry) => entry.name === "plan")).toMatchObject({
                scope: "project",
                description: "Plans before it edits",
            });
            expect(inFolder.agents.map((entry) => entry.name)).toContain("scout");

            const chat = await readNewSessionAgents(host.server.socketPath, undefined);
            if (!chat.ok) throw new Error(chat.reason);
            expect(chat.agents.map((entry) => entry.name)).toContain("scout");
            expect(chat.agents.map((entry) => entry.name)).not.toContain("plan");
        } finally {
            await host.close();
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            await rm(root, { recursive: true, force: true });
        }
    });
});
