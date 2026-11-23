import { expect, spyOn, test } from "bun:test";
import { mkdtemp, open, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexStoredSession } from "../../src/host/session-host/storage.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry/support.ts";
import { readSessionPeerMetadata, sessionPeerMetadata, storedPeerFacts } from "../../src/store/session-peer-metadata.ts";
import { SessionStore } from "../../src/store/session-store.ts";

test("@core stored peer metadata keeps summaries unchanged and reads approval on demand", async () => {
    const root = await mkdtemp(join(tmpdir(), "peer-index-"));
    try {
        const path = join(root, "crow.jsonl");
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendIdentity({ name: "quiet-crow:1234", key: "quiet-crow:1234" });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "x".repeat(140_000) }] });
        await store.appendApprovalMode("auto");
        await store.appendApprovalMode("ask");
        const before = await readFile(path);
        const indexed = new Map<string, RegisteredAgentSummary>();
        await indexStoredSession(path, indexed);
        const row = indexed.get("crow")!;
        expect(row).toMatchObject({ status: "completed", live: false });
        expect(row.name).toBeUndefined();
        expect(storedPeerFacts(row)).toEqual({ name: "quiet-crow:1234", failed: false });
        expect(await sessionPeerMetadata(row, path)).toMatchObject({ name: "quiet-crow:1234", approvalMode: "ask", failed: false });
        expect(await readFile(path)).toEqual(before);

        await store.appendApprovalMode("full_access");
        expect((await sessionPeerMetadata(row, path)).approvalMode).toBe("full_access");
        await store.appendAgentFailure("failure-1", "failure ".repeat(12_000));
        expect((await readSessionPeerMetadata(path)).failed).toBe(true);
        await indexStoredSession(path, indexed);
        expect(indexed.get("crow")?.status).toBe("completed");
        expect(indexed.get("crow")?.name).toBeUndefined();
        expect(storedPeerFacts(indexed.get("crow")!)).toEqual({ name: "quiet-crow:1234", failed: true });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("@core indexing reads only the existing head scan and final record chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "peer-index-ranges-"));
    try {
        const path = join(root, "ranges.jsonl");
        const store = await SessionStore.create(path, { sessionId: "ranges", cwd: root });
        await store.appendIdentity({ name: "quiet-crow:1234", key: "quiet-crow:1234" });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
        await store.appendHarnessMessage("x".repeat(200_000), "soft");
        await store.appendApprovalMode("full_access");
        await store.appendHarnessMessage("y".repeat(200_000), "soft");
        await store.appendAgentFailure("failure", "z".repeat(90_000));
        const size = (await stat(path)).size;
        const handle = await open(path, "r");
        const prototype = Object.getPrototypeOf(handle);
        await handle.close();
        const original = prototype.read;
        const ranges: Array<{ position: number; length: number }> = [];
        const spy = spyOn(prototype, "read").mockImplementation(function (this: unknown, ...args: unknown[]) {
            const position = args[3];
            if (typeof position === "number") ranges.push({ position, length: args[2] as number });
            return original.apply(this, args);
        });
        try {
            const indexed = new Map<string, RegisteredAgentSummary>();
            await indexStoredSession(path, indexed);
            const row = indexed.get("ranges")!;
            expect(storedPeerFacts(row)).toEqual({ name: "quiet-crow:1234", failed: true });
            expect(storedPeerFacts(row)).not.toHaveProperty("approvalMode");
            expect(ranges).toEqual([
                { position: 0, length: 65_536 },
                { position: size - 65_536, length: 65_536 },
                { position: size - 131_072, length: 65_536 },
            ]);
        } finally {
            spy.mockRestore();
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("@core a peer tail-read failure does not remove a stored summary", async () => {
    const root = await mkdtemp(join(tmpdir(), "peer-index-tail-"));
    try {
        const path = join(root, "crow.jsonl");
        const store = await SessionStore.create(path, { sessionId: "crow", cwd: root });
        await store.appendIdentity({ name: "quiet-crow:1234", key: "quiet-crow:1234" });
        await store.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] });
        const handle = await open(path, "r");
        const prototype = Object.getPrototypeOf(handle);
        await handle.close();
        const original = prototype.read;
        let calls = 0;
        const spy = spyOn(prototype, "read").mockImplementation(function (this: unknown, ...args: unknown[]) {
            calls += 1;
            if (calls === 2) return Promise.reject(new Error("tail read failed"));
            return original.apply(this, args);
        });
        try {
            const indexed = new Map<string, RegisteredAgentSummary>();
            await indexStoredSession(path, indexed);
            const row = indexed.get("crow")!;
            expect(row).toMatchObject({ id: "crow", status: "completed", live: false, has_user_content: true });
            expect(storedPeerFacts(row)).toBeUndefined();
        } finally {
            spy.mockRestore();
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("@core old stored sessions retain their prior listing without a peer metadata scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "peer-index-old-"));
    try {
        const path = join(root, "old.jsonl");
        const store = await SessionStore.create(path, { sessionId: "old", cwd: root });
        await store.appendIdentity({ name: "old-crow:1234", key: "old-crow:1234" });
        const old = new Date(Date.now() - 11 * 24 * 60 * 60 * 1000);
        await utimes(path, old, old);
        const indexed = new Map<string, RegisteredAgentSummary>();
        await indexStoredSession(path, indexed);
        expect(indexed.get("old")).toMatchObject({ id: "old", status: "completed", live: false });
        expect(indexed.get("old")?.name).toBeUndefined();
        expect(storedPeerFacts(indexed.get("old")!)).toBeUndefined();
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
