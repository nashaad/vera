import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionReplica } from "../../src/store/session-replica.ts";
import {
    SessionStore,
    type SessionImageAttachmentMetadata,
} from "../../src/store/session-store.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("a replica answers every read as a store opened at the same record", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "sessions", "session.jsonl");
    await writeRichSession(path);
    const lines = readLines(path);

    const replica = SessionReplica.seed(path, lines[0] as Record<string, unknown>);
    expect(replica.path).toBe(path);
    expect(reads(replica)).toEqual(reads(await openPrefix(directory, lines, 1)));

    for (let index = 1; index < lines.length; index += 1) {
        replica.apply(index + 1, lines[index] as Record<string, unknown>);
        expect(replica.appliedThrough()).toBe(index + 1);
        const store = await openPrefix(directory, lines, index + 1);
        expect(reads(replica)).toEqual(reads(store));
    }
});

test("a replica refuses every write", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "sessions", "session.jsonl");
    await writeRichSession(path);
    const before = readFileSync(path, "utf8");
    const lines = readLines(path);
    const replica = SessionReplica.seed(path, lines[0] as Record<string, unknown>);
    replica.apply(2, lines[1] as Record<string, unknown>);

    const refused = /cannot write to the session file/;
    expect(replica.appendMessage(userMessage("no"))).rejects.toThrow(refused);
    expect(replica.appendName("no")).rejects.toThrow(refused);
    expect(replica.appendApprovalMode("ask")).rejects.toThrow(refused);
    expect(replica.appendHarnessMessage("no", "soft")).rejects.toThrow(refused);
    expect(replica.appendAgentFailure("id", "detail")).rejects.toThrow(refused);
    expect(replica.recordDelivery({
        id: "delivery-2",
        sourceAgentId: "agent",
        content: "hello",
    })).rejects.toThrow(refused);

    await Promise.resolve();
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(replica.messages().length).toBe(1);
});

test("a replica rejects a record the file would reject, with the same message", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "sessions", "session.jsonl");
    await writeRichSession(path);
    const lines = readLines(path);
    const stray = { ...(lines[1] as Record<string, unknown>), type: "nonsense" };

    const replica = SessionReplica.seed(path, lines[0] as Record<string, unknown>);
    const live = (await parseFailure(directory, [lines[0], stray]))
        .replace(prefixPath(directory, 2), path);
    expect(() => replica.apply(2, stray)).toThrow(live);

    // Rejection is terminal: the replica no longer matches the file, so it
    // refuses the record it would otherwise have accepted next.
    expect(() => replica.apply(2, lines[1] as Record<string, unknown>))
        .toThrow(live);
});

test("a replica rejects a missing record and a swapped pair", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "sessions", "session.jsonl");
    await writeRichSession(path);
    const lines = readLines(path);

    const skipping = SessionReplica.seed(path, lines[0] as Record<string, unknown>);
    expect(() => skipping.apply(3, lines[2] as Record<string, unknown>))
        .toThrow("expected record on line 2 but received line 3");

    const swapping = SessionReplica.seed(path, lines[0] as Record<string, unknown>);
    swapping.apply(2, lines[1] as Record<string, unknown>);
    expect(() => swapping.apply(4, lines[3] as Record<string, unknown>))
        .toThrow("expected record on line 3 but received line 4");
    expect(swapping.appliedThrough()).toBe(2);
});

test("a replica seeded with something other than a header is refused", () => {
    const path = join(temporaryDirectory(), "session.jsonl");
    expect(() => SessionReplica.seed(path, { type: "message" }))
        .toThrow("line 1 is not a valid session header");
});

/** Every read the store answers, in one comparable shape. */
function reads(store: SessionStore): Record<string, unknown> {
    return {
        header: store.header,
        entries: store.entries(),
        activeEntries: store.activeEntries(),
        messages: store.messages(),
        activeMessageIds: [...store.activeMessageIds().values()],
        activeHeadId: store.activeHeadId(),
        pendingDeliveries: store.pendingDeliveries(),
        hasUnansweredDeliveryTurn: store.hasUnansweredDeliveryTurn(),
        modelSettings: store.modelSettings(),
        modelSettingsOrigin: store.modelSettingsOrigin(),
        modelSettingsHistory: store.modelSettingsHistory(),
        selectedAgent: store.selectedAgent(),
        approvalMode: store.approvalMode(),
        approvalModeOrigin: store.approvalModeOrigin(),
        name: store.name(),
        permissionGrants: store.permissionGrants(),
        attachmentRecords: store.attachmentRecords(),
        agentFailure: store.agentFailure(),
        projectedHarnessMessages: store.projectedHarnessMessages(),
        latestCompaction: store.latestCompaction(),
        unprojectedModelContext: store.unprojectedModelContext(),
        modelContext: store.modelContext(),
    };
}

/**
 * A store opened on the first `lineCount` lines of the session, which is what
 * a reader of the file would have seen when that many records were durable.
 */
async function openPrefix(
    directory: string,
    lines: readonly unknown[],
    lineCount: number,
): Promise<SessionStore> {
    const path = prefixPath(directory, lineCount);
    writeFileSync(
        path,
        lines.slice(0, lineCount).map((line) => `${JSON.stringify(line)}\n`)
            .join(""),
        { mode: 0o600 },
    );
    return SessionStore.open(path);
}

function prefixPath(directory: string, lineCount: number): string {
    return join(directory, `prefix-${lineCount}.jsonl`);
}

/** The message a parse of these records fails with. */
async function parseFailure(
    directory: string,
    lines: readonly unknown[],
): Promise<string> {
    try {
        await openPrefix(directory, lines, lines.length);
    } catch (error) {
        return (error as Error).message;
    }
    throw new Error("The records parsed cleanly");
}

/** A session holding one record of every kind the store can write. */
async function writeRichSession(path: string): Promise<void> {
    const store = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: "/work",
        now: counterDates(),
        createId: counterIds(),
    });
    await store.appendMessage(userMessage("first"));
    await store.appendMessage(assistantMessage("first answer"));
    await store.appendModelSettings({ model: "test-model" }, "user");
    await store.appendApprovalMode("ask", "user");
    await store.appendName("a named session");
    await store.appendSelectedAgent("worker", {
        name: "worker",
        instructions: "work",
        tools: [],
    });
    await store.appendHarnessMessage("compacted", "soft");
    const grants = await store.appendPermissionGrants([
        {
            kind: "action",
            when: { operation: "git.push" },
            scope: "session",
            lifetime: "session",
        },
        {
            kind: "action",
            when: { operation: "git.commit" },
            scope: "session",
            lifetime: "session",
        },
    ]);
    await store.revokePermissionGrant(grants.grants[1]!.id);
    await store.appendAttachment(imageAttachment());
    await store.recordDelivery({
        id: "delivery-1",
        sourceAgentId: "agent-1",
        content: "a subagent finished",
    });
    await store.appendDeliveryMessage(
        "delivery-1",
        { role: "user", internal: true, content: [{ type: "text", text: "d" }] },
    );
    await store.appendMessage(assistantMessage("second answer"));
    await store.appendMessage(userMessage("second"));
    await store.appendMessage(assistantMessage("third answer"));
    await store.appendCompaction({
        boundaryMessageId: "id-2",
        firstRetainedMessageId: "id-4",
        projection: [userMessage("summary of the start")],
        measured: { inputTokens: 40, contextWindow: 1_000, estimated: true },
    });
    await store.rewindBefore("id-6");
    await store.appendMessage(userMessage("after the rewind"));
    await store.appendAgentFailure("failure-1", "the worker died");
}

function userMessage(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function assistantMessage(text: string): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function imageAttachment(): SessionImageAttachmentMetadata {
    const sha256 = "a".repeat(64);
    return {
        id: `${sha256}.png`,
        name: "screenshot.png",
        mediaType: "image/png",
        bytes: 123,
        width: 10,
        height: 20,
        sha256,
    };
}

function counterDates(): () => Date {
    let second = 0;
    return () => {
        second += 1;
        return new Date(Date.UTC(2026, 6, 17, 12, 0, second));
    };
}

function counterIds(): () => string {
    let count = 0;
    return () => {
        count += 1;
        return `id-${count}`;
    };
}

function readLines(path: string): unknown[] {
    return readFileSync(path, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);
}

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-session-replica-"));
    temporaryDirectories.push(directory);
    return directory;
}
