import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { connectHost } from "../../src/host/connection.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { startHostServer } from "../../src/host/server.ts";
import { UserFacingError } from "../../src/user-facing-error.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function temporaryHostDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-locate-"));
    temporaryDirectories.push(directory);
    return directory;
}

test("locate names this host's socket for a resident session", async () => {
    const directory = temporaryHostDirectory();
    const socketPath = join(directory, "host.sock");
    const agent = new ResidentAgent("agent-1", "/work/one");
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        buildId: "vera-locate-test",
        findAgent: (agentId) => agentId === agent.id ? agent : undefined,
    });
    try {
        const connection = await connectHost({ socketPath });
        await connection.send({ type: "locate_agent", agent_id: agent.id });
        expect(await connection.receive()).toEqual({
            type: "agent_location",
            socket_path: socketPath,
            worker_id: "host",
            worker_generation: 1,
            build_id: "vera-locate-test",
        });
        connection.close();
    } finally {
        agent.close();
        await server.close();
    }
});

test("locate reports not_found for an id this host does not have", async () => {
    const directory = temporaryHostDirectory();
    const socketPath = join(directory, "host.sock");
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        findAgent: () => undefined,
    });
    try {
        const connection = await connectHost({ socketPath });
        await connection.send({ type: "locate_agent", agent_id: "missing" });
        expect(await connection.receive()).toEqual({
            type: "agent_location_failed",
            reason: "not_found",
            message: expect.any(String),
        });
        connection.close();
    } finally {
        await server.close();
    }
});

test("locate reports worker_unavailable when the session cannot be loaded", async () => {
    const directory = temporaryHostDirectory();
    const socketPath = join(directory, "host.sock");
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        findAgent: (agentId) => {
            if (agentId === "unreadable") {
                throw new UserFacingError("Session file is unreadable.");
            }
            throw new Error("internal detail");
        },
    });
    try {
        const first = await connectHost({ socketPath });
        await first.send({ type: "locate_agent", agent_id: "unreadable" });
        expect(await first.receive()).toEqual({
            type: "agent_location_failed",
            reason: "worker_unavailable",
            message: "Session file is unreadable.",
        });
        first.close();

        const second = await connectHost({ socketPath });
        await second.send({ type: "locate_agent", agent_id: "other" });
        expect(await second.receive()).toEqual({
            type: "agent_location_failed",
            reason: "worker_unavailable",
            message: "The session could not be loaded.",
        });
        second.close();
    } finally {
        await server.close();
    }
});

test("locate reports worker_unavailable for a closed session", async () => {
    const directory = temporaryHostDirectory();
    const socketPath = join(directory, "host.sock");
    const agent = new ResidentAgent("agent-1", "/work/one");
    agent.close();
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        findAgent: () => agent,
    });
    try {
        const connection = await connectHost({ socketPath });
        await connection.send({ type: "locate_agent", agent_id: agent.id });
        expect(await connection.receive()).toEqual({
            type: "agent_location_failed",
            reason: "worker_unavailable",
            message: "The session is closed.",
        });
        connection.close();
    } finally {
        await server.close();
    }
});
