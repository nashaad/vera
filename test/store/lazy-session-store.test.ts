import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../../src/store/session-store.ts";
import type { ModelMessage } from "../../src/model/types.ts";

const directories: string[] = [];
const now = () => new Date("2026-11-19T12:00:00.000Z");

afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function pathFor(name: string): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-lazy-session-"));
    directories.push(directory);
    return join(directory, `${name}.jsonl`);
}

function setupRecord(type: "session_identity" | "permissions" | "model_settings", value = "x"): Record<string, unknown> {
    if (type === "session_identity") return { type, timestamp: now().toISOString(), name: value, key: "worker-key" };
    if (type === "permissions") return { type, timestamp: now().toISOString(), mode: "ask", origin: "user" };
    return {
        type,
        timestamp: now().toISOString(),
        settings: { provider: "test", model: value },
        origin: "user",
    };
}

async function lazy(name: string, extras: Record<string, unknown> = {}, onRecordAppended?: (line: number, record: Record<string, unknown>) => void) {
    return SessionStore.create(pathFor(name), {
        sessionId: name,
        cwd: "/work/vera",
        now,
        deferFile: true,
        ...extras,
        ...(onRecordAppended === undefined ? {} : { onRecordAppended }),
    });
}

function lines(path: string): Record<string, unknown>[] {
    return readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("@core lazy creation stays absent until a write and exposes setup reads", async () => {
    const path = pathFor("unused");
    const store = await SessionStore.create(path, { sessionId: "unused", cwd: "/work", deferFile: true, now });
    expect(existsSync(path)).toBe(false);
    expect(store.isMaterialized()).toBe(false);
    expect(store.pendingRecords()).toEqual([]);
    await store.appendForeignRecord(setupRecord("model_settings", "model-a"));
    expect(existsSync(path)).toBe(false);
    expect(await store.readModelSettingsHistory()).toHaveLength(1);
    expect(store.modelSettings()).toEqual({ provider: "test", model: "model-a" });
    await store.appendForeignRecord(setupRecord("model_settings", "model-b"));
    expect((await store.readModelSettingsHistory()).map((entry) => entry.settings.model)).toEqual(["model-a", "model-b"]);
    expect(store.pendingRecords()).toHaveLength(2);
});

test("@core pending setup is lost when its owning process exits before first use", async () => {
    const path = pathFor("owner-exited");
    const modulePath = new URL("../../src/store/session-store.ts", import.meta.url).href;
    const script = `
        import { SessionStore } from ${JSON.stringify(modulePath)};
        const store = await SessionStore.create(${JSON.stringify(path)}, {
            sessionId: "owner-exited", cwd: "/work", deferFile: true,
        });
        await store.appendApprovalMode("ask");
        if (store.pendingRecords().length !== 1) process.exit(24);
        process.exit(23);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ status, stderr }).toEqual({ status: 23, stderr: "" });
    expect(existsSync(path)).toBe(false);
    await expect(SessionStore.open(path)).rejects.toThrow();
});

test("@core setup record types stay pending, while session_name materializes immediately", async () => {
    for (const type of ["session_identity", "permissions", "model_settings"] as const) {
        const store = await lazy(type);
        await store.appendForeignRecord(setupRecord(type));
        expect(store.isMaterialized()).toBe(false);
        expect(existsSync(store.path)).toBe(false);
        expect(store.pendingRecords().map((record) => record.type)).toEqual([type]);
    }
    const named = await lazy("name");
    await named.appendForeignRecord({ type: "session_name", timestamp: now().toISOString(), name: "First" });
    expect(named.isMaterialized()).toBe(true);
    expect(lines(named.path).map((record) => record.type)).toEqual(["session", "session_name"]);
});

const flushCases: ReadonlyArray<readonly [string, (store: SessionStore) => Promise<unknown>]> = [
    ["user message", (store) => store.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] })],
    ["queued prompt", (store) => store.appendQueuedPrompt("q1", { content: "later" })],
    ["delivery", (store) => store.appendForeignRecord({ type: "delivery", id: "d1", sourceAgentId: "worker", content: "sent", timestamp: now().toISOString() })],
    ["known foreign type", (store) => store.appendForeignRecord({ type: "session_name", timestamp: now().toISOString(), name: "Foreign" })],
];

for (const [label, append] of flushCases) {
    test(`pending setup replays before ${label} without duplicate callbacks`, async () => {
        const callbacks: Array<{ line: number; type: unknown }> = [];
        const store = await lazy(label, {}, (line, record) => callbacks.push({ line, type: record.type }));
        await store.appendForeignRecord(setupRecord("model_settings", "before"));
        await store.appendForeignRecord(setupRecord("permissions"));
        expect(callbacks).toEqual([]);
        expect(existsSync(store.path)).toBe(false);
        await append(store);
        expect(store.isMaterialized()).toBe(true);
        expect(lines(store.path).map((record) => record.type)).toEqual([
            "session", "model_settings", "permissions",
            label === "user message" ? "message" : label === "queued prompt" ? "queued_prompt" : label === "delivery" ? "delivery" : "session_name",
        ]);
        const callbackTypes = label === "user message" || label === "queued prompt"
            ? [lines(store.path).at(-1)?.type]
            : [];
        expect(callbacks.map((entry) => entry.line)).toEqual(callbackTypes.length === 0 ? [] : [4]);
        expect(callbacks.map((entry) => entry.type)).toEqual(callbackTypes);
        expect(store.pendingRecords()).toEqual([]);
    });
}

test("accepted queued prompts and delivery receipts are immediately durable", async () => {
    const queued = await lazy("queued");
    await queued.appendQueuedPrompt("q1", { content: "later" });
    expect(lines(queued.path).map((record) => record.type)).toEqual(["session", "queued_prompt"]);

    const delivery = await lazy("delivery-record");
    await delivery.appendForeignRecord(setupRecord("permissions"));
    await delivery.appendForeignRecord({ type: "delivery", id: "d1", sourceAgentId: "worker", content: "sent", timestamp: now().toISOString() });
    expect(delivery.isMaterialized()).toBe(true);
    expect(lines(delivery.path).map((record) => record.type)).toEqual(["session", "permissions", "delivery"]);
});

test("@core archiving publishes pending setup before writing metadata", async () => {
    const store = await lazy("archive");
    await store.appendForeignRecord(setupRecord("permissions"));
    await store.setArchived(true);
    expect(store.isMaterialized()).toBe(true);
    expect((await SessionStore.open(store.path)).archived()).toBe(true);
    expect(lines(store.path).map((record) => record.type)).toEqual(["session", "permissions"]);
});

test("reopening sees setup records in original order", async () => {
    const store = await lazy("reopen");
    await store.appendForeignRecord(setupRecord("session_identity", "worker"));
    await store.appendForeignRecord(setupRecord("permissions"));
    await store.appendMessage({ role: "user", content: [{ type: "text", text: "go" }] });
    const reopened = await SessionStore.open(store.path);
    expect(reopened.identity()?.name).toBe("worker");
    expect(reopened.approvalMode()).toBe("ask");
    expect(lines(store.path).map((record) => record.type)).toEqual(["session", "session_identity", "permissions", "message"]);
});

test("@core the record limit materializes on exactly the 256th setup record", async () => {
    const store = await lazy("count-limit");
    for (let index = 0; index < 255; index += 1) {
        await store.appendForeignRecord(setupRecord("model_settings", `worker-${index}`));
    }
    expect(store.isMaterialized()).toBe(false);
    expect(store.pendingRecords()).toHaveLength(255);
    await store.appendForeignRecord(setupRecord("model_settings", "trigger"));
    expect(store.isMaterialized()).toBe(true);
    expect(lines(store.path)).toHaveLength(257);
    expect((lines(store.path).at(-1)?.settings as Record<string, unknown>).model).toBe("trigger");
});

test("the serialized byte limit includes the record that reaches it", async () => {
    const store = await lazy("byte-limit");
    const first = setupRecord("model_settings", "a".repeat(400_000));
    const second = setupRecord("model_settings", "b".repeat(400_000));
    const third = setupRecord("model_settings", "c".repeat(300_000));
    await store.appendForeignRecord(first);
    await store.appendForeignRecord(second);
    expect(store.isMaterialized()).toBe(false);
    await store.appendForeignRecord(third);
    expect(store.isMaterialized()).toBe(true);
    expect(lines(store.path).slice(1).map((record) => record.settings && (record.settings as Record<string, unknown>).model)).toEqual([
        "a".repeat(400_000), "b".repeat(400_000), "c".repeat(300_000),
    ]);
});

test("a record that exactly reaches the byte limit materializes", async () => {
    const store = await lazy("exact-byte-limit");
    const empty = setupRecord("model_settings", "");
    const remaining = 1024 * 1024 - Buffer.byteLength(`${JSON.stringify(empty)}\n`);
    const record = setupRecord("model_settings", "x".repeat(remaining));
    expect(Buffer.byteLength(`${JSON.stringify(record)}\n`)).toBe(1024 * 1024);
    await store.appendForeignRecord(record);
    expect(store.isMaterialized()).toBe(true);
    expect(lines(store.path)).toHaveLength(2);
});

test("an unrecognized record type materializes instead of remaining pending", async () => {
    const store = await lazy("future-record");
    await store.appendForeignRecord(setupRecord("permissions"));
    const internal = store as unknown as { appendRecord: (record: object) => Promise<void> };
    await internal.appendRecord({ type: "future_record", value: "saved" });
    expect(store.isMaterialized()).toBe(true);
    expect(lines(store.path).map((record) => record.type)).toEqual([
        "session", "permissions", "future_record",
    ]);
});

test("a single oversized setup record is written directly", async () => {
    const store = await lazy("oversize");
    await store.appendForeignRecord(setupRecord("model_settings", "z".repeat(1_100_000)));
    expect(store.isMaterialized()).toBe(true);
    expect(store.pendingRecords()).toEqual([]);
    expect(lines(store.path)).toHaveLength(2);
});

test("@core EEXIST preserves the foreign target and pending setup, then retries", async () => {
    const store = await lazy("collision");
    await store.appendForeignRecord(setupRecord("session_identity", "pending"));
    writeFileSync(store.path, "foreign target\n");
    const message: ModelMessage = { role: "user", content: [{ type: "text", text: "go" }] };
    await expect(store.appendMessage(message)).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(store.path, "utf8")).toBe("foreign target\n");
    expect(store.isMaterialized()).toBe(false);
    expect(store.pendingRecords().map((record) => record.name)).toEqual(["pending"]);
    rmSync(store.path);
    await store.appendMessage(message);
    expect(lines(store.path).map((record) => record.type)).toEqual(["session", "session_identity", "message"]);
});

test("eager creation remains eager and parent or origin disables deferral", async () => {
    const eager = await SessionStore.create(pathFor("eager"), { sessionId: "eager", cwd: "/work", now });
    expect(eager.isMaterialized()).toBe(true);
    expect(existsSync(eager.path)).toBe(true);

    const parent = await SessionStore.create(pathFor("parent"), { sessionId: "parent", cwd: "/work", parentId: "root", deferFile: true, now });
    expect(parent.isMaterialized()).toBe(true);
    expect(existsSync(parent.path)).toBe(true);
    const origin = await SessionStore.create(pathFor("origin"), { sessionId: "origin", cwd: "/work", origin: { sessionId: "root", entryId: null, position: "at" }, deferFile: true, now });
    expect(origin.isMaterialized()).toBe(true);
    expect(existsSync(origin.path)).toBe(true);
});
