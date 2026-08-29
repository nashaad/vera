import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    searchSessionsThroughHost,
    SessionSearchUnavailableError,
} from "../../src/host/session-search-client.ts";
import { startHostServer } from "../../src/host/server.ts";
import { searchSessions } from "../../src/store/session-search.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function root(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-search-wire-"));
    roots.push(directory);
    return directory;
}

function writeSession(
    directory: string,
    id: string,
    said: string | readonly string[],
): void {
    const messages = typeof said === "string" ? [said] : said;
    writeFileSync(join(directory, `${id}.jsonl`), [
        JSON.stringify({
            type: "session",
            version: 1,
            id,
            timestamp: "2026-08-01T00:00:00.000Z",
            cwd: "/work/one",
        }),
        ...messages.map((text, index) => JSON.stringify({
            type: "message",
            id: `m${index + 1}`,
            parentId: index === 0 ? null : `m${index}`,
            timestamp: "2026-08-01T00:00:00.000Z",
            message: { role: "user", content: [{ type: "text", text }] },
        })),
        "",
    ].join("\n"), "utf8");
}

const networked = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1"
    ? test.skip
    : test;

networked("a search over the socket returns the transcripts on disk", async () => {
    const directory = root();
    const sessions = join(directory, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeSession(sessions, "one", "does the provider fallback kick in");
    writeSession(sessions, "two", "nothing to do with it");

    const socketPath = join(directory, "host.sock");
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        searchSessions: (query) => searchSessions(sessions, query),
    });
    try {
        const found = await searchSessionsThroughHost(socketPath, {
            query: "provider fallback",
        });
        expect(found.results).toHaveLength(1);
        expect(found.results[0]?.session_id).toBe("one");
        expect(found.results[0]?.hits[0]?.kind).toBe("user_message");
        expect(found.results[0]?.hits[0]?.entry_id).toBe("m1");
        expect(found.truncated).toBe(false);
    } finally {
        await server.close();
    }
});

networked("a host with nothing to scan says unavailable, not empty", async () => {
    const directory = root();
    const socketPath = join(directory, "host.sock");
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
    });
    try {
        await expect(searchSessionsThroughHost(socketPath, { query: "x" }))
            .rejects.toBeInstanceOf(SessionSearchUnavailableError);
    } finally {
        await server.close();
    }
});

networked("a scan that throws is a refusal, never a wrong answer", async () => {
    const directory = root();
    const socketPath = join(directory, "host.sock");
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        searchSessions: () => Promise.reject(new Error("disk went away")),
    });
    try {
        await expect(searchSessionsThroughHost(socketPath, { query: "x" }))
            .rejects.toBeInstanceOf(SessionSearchUnavailableError);
    } finally {
        await server.close();
    }
});

networked("a query the host will not accept closes without answering", async () => {
    const directory = root();
    const socketPath = join(directory, "host.sock");
    let scanned = false;
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        searchSessions: async (query) => {
            scanned = true;
            return searchSessions(directory, query);
        },
    });
    try {
        // Past the host's query bound, so nothing reads a single transcript.
        await expect(searchSessionsThroughHost(
            socketPath,
            { query: "x".repeat(300) },
            1_000,
        )).rejects.toBeDefined();
        expect(scanned).toBe(false);
    } finally {
        await server.close();
    }
});

networked("a search naming one session carries the id across", async () => {
    const directory = root();
    const sessions = join(directory, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeSession(sessions, "one", "does the provider fallback kick in");
    writeSession(sessions, "two", "the provider fallback again");

    const socketPath = join(directory, "host.sock");
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        searchSessions: (query) => searchSessions(sessions, query),
    });
    try {
        const found = await searchSessionsThroughHost(socketPath, {
            query: "provider fallback",
            session_id: "two",
        });
        expect(found.results.map((result) => result.session_id)).toEqual(["two"]);
    } finally {
        await server.close();
    }
});

networked("a named session carries more than the list hit cap", async () => {
    const directory = root();
    const sessions = join(directory, "sessions");
    mkdirSync(sessions, { recursive: true });
    writeSession(
        sessions,
        "one",
        Array.from({ length: 5 }, (_, index) => `fallback ${index}`),
    );

    const socketPath = join(directory, "host.sock");
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        searchSessions: (query) => searchSessions(sessions, query),
    });
    try {
        const found = await searchSessionsThroughHost(socketPath, {
            query: "fallback",
            session_id: "one",
        });
        expect(found.results[0]?.hits).toHaveLength(5);
    } finally {
        await server.close();
    }
});

networked("a session id past the bound is refused, not scanned", async () => {
    const directory = root();
    const socketPath = join(directory, "host.sock");
    let scanned = false;
    const server = await startHostServer({
        socketPath,
        lockPath: join(directory, "host.json"),
        searchSessions: async (query) => {
            scanned = true;
            return searchSessions(directory, query);
        },
    });
    try {
        await expect(searchSessionsThroughHost(
            socketPath,
            { query: "fallback", session_id: "x".repeat(300) },
            1_000,
        )).rejects.toBeDefined();
        expect(scanned).toBe(false);
    } finally {
        await server.close();
    }
});
