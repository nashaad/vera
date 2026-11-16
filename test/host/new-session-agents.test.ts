import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectHost } from "../../src/host/connection.ts";
import { parseHostRequest } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { socketTest } from "../support/socket-probe.ts";

test("@core new_session_agents parses with and without a folder", () => {
    expect(parseHostRequest('{"type":"new_session_agents"}')).toEqual({ type: "new_session_agents" });
    expect(parseHostRequest('{"type":"new_session_agents","workspace":"/nest/crow"}')).toEqual({
        type: "new_session_agents",
        workspace: "/nest/crow",
    });
});

test("new_session_agents refuses a folder that is not an absolute path", () => {
    for (const workspace of ["", "nest/crow", "./crow", 7, null, ["/nest"], "/nest\0crow"]) {
        expect(parseHostRequest(JSON.stringify({ type: "new_session_agents", workspace }))).toBeUndefined();
    }
});

interface Listing {
    readonly type: string;
    readonly starts_on: string;
    readonly agents: readonly { readonly name: string; readonly scope: string; readonly description?: string }[];
    readonly notices: readonly string[];
}

async function ask(socketPath: string, request: Record<string, unknown>): Promise<Listing> {
    const connection = await connectHost({ socketPath });
    connection.expectPeerClose();
    try {
        await connection.send(request);
        return await connection.receiveWithin(5_000, "The host did not answer in time.") as Listing;
    } finally {
        connection.close();
    }
}

socketTest("@core a real host lists the agents a new session would offer, in a folder and for a chat, without starting one", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-new-session-agents-"));
    const home = join(root, "home");
    const folder = join(root, "crow-nest");
    const sessions = join(root, "sessions");
    await mkdir(join(home, "agents"), { recursive: true });
    await mkdir(join(folder, ".vera", "agents"), { recursive: true });
    await writeFile(join(home, "agents", "scout.md"), "---\ndescription: Looks ahead from the mast\n---\nScout the water.");
    await writeFile(join(folder, ".vera", "agents", "plan.md"), "---\ndescription: Plans before it edits\nposture: readonly\n---\nPlan only.");
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    const host = await startResidentHost({
        config: { schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "auto" },
        createAdapter: () => new FauxAdapter([]),
        home,
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        sessionDirectory: sessions,
        eventLogDirectory: join(root, "logs"),
    });
    try {
        const inFolder = await ask(host.server.socketPath, { type: "new_session_agents", workspace: folder });
        expect(inFolder.type).toBe("new_session_agents");
        expect(inFolder.starts_on).toBe("default");
        expect(inFolder.agents).toContainEqual(expect.objectContaining({
            name: "plan",
            scope: "project",
            description: "Plans before it edits",
            posture: "readonly",
            writable: true,
        }));
        expect(inFolder.agents).toContainEqual(expect.objectContaining({ name: "scout", scope: "user" }));
        expect(inFolder.agents.map((agent) => agent.name)).toContain("default");

        const chat = await ask(host.server.socketPath, { type: "new_session_agents" });
        expect(chat.starts_on).toBe("default");
        const chatNames = chat.agents.map((agent) => agent.name);
        expect(chatNames).toContain("scout");
        expect(chatNames).toContain("default");
        expect(chatNames).not.toContain("plan");

        const missing = await ask(host.server.socketPath, { type: "new_session_agents", workspace: join(root, "no-such-folder") });
        expect(missing.agents.map((agent) => agent.name)).not.toContain("plan");
        expect(missing.agents.map((agent) => agent.name)).toContain("scout");

        const stored = await readdir(sessions).catch(() => []);
        expect(stored.filter((name) => name.endsWith(".jsonl"))).toEqual([]);
    } finally {
        await host.close();
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        await rm(root, { recursive: true, force: true });
    }
});

socketTest("a malformed new_session_agents request gets no listing", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-new-session-agents-bad-"));
    const host = await startResidentHost({
        config: { schema_version: 1, provider: "openrouter", model: "faux/test", approval_mode: "auto" },
        createAdapter: () => new FauxAdapter([]),
        home: join(root, "home"),
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "logs"),
    });
    try {
        await expect(ask(host.server.socketPath, { type: "new_session_agents", workspace: "relative/folder" })).rejects.toThrow();
    } finally {
        await host.close();
        await rm(root, { recursive: true, force: true });
    }
});
