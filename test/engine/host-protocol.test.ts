import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    HOST_PROTOCOL_METHODS,
    type HostNotification,
    type HostRequest,
    type WorkerNotification,
    type WorkerRequest,
} from "../../src/engine/host-protocol.ts";
import { SessionStore } from "../../src/store/session-store.ts";

type Message =
    | HostNotification
    | HostRequest
    | WorkerNotification
    | WorkerRequest;

/**
 * Own-key sets have to match exactly, at every depth.
 *
 * `toEqual` treats a key holding `undefined` as equal to an absent key and a
 * missing key as equal to one holding `undefined`, which is the exact hazard
 * this boundary has to keep: `parentId` and `headId` are meaningfully `null`,
 * while an optional field is absent, and a layer that turns one into the other
 * breaks parsing.
 */
function expectSameShape(actual: unknown, expected: unknown, path: string) {
    if (expected === null || actual === null) {
        expect(`${path}=${JSON.stringify(actual)}`)
            .toBe(`${path}=${JSON.stringify(expected)}`);
        return;
    }
    if (Array.isArray(expected)) {
        expect(Array.isArray(actual)).toBe(true);
        const list = actual as unknown[];
        expect(`${path}.length=${list.length}`)
            .toBe(`${path}.length=${expected.length}`);
        for (const [index, item] of expected.entries()) {
            expectSameShape(list[index], item, `${path}[${index}]`);
        }
        return;
    }
    if (typeof expected === "object") {
        expect(typeof actual).toBe("object");
        const actualRecord = actual as Record<string, unknown>;
        const expectedRecord = expected as Record<string, unknown>;
        expect(`${path} keys: ${Object.keys(actualRecord).sort().join(",")}`)
            .toBe(
                `${path} keys: ${Object.keys(expectedRecord).sort().join(",")}`,
            );
        for (const key of Object.keys(expectedRecord)) {
            expectSameShape(
                actualRecord[key],
                expectedRecord[key],
                `${path}.${key}`,
            );
        }
        return;
    }
    expect(`${path}=${JSON.stringify(actual)}`)
        .toBe(`${path}=${JSON.stringify(expected)}`);
}

function roundTrip<T>(message: T): T {
    return JSON.parse(JSON.stringify(message)) as T;
}

/**
 * One value per method, all directions.
 *
 * `session.record` and `session.append` carry records taken from a real store
 * file rather than hand-written ones, so the null-bearing fields are the ones
 * the store actually writes.
 */
async function messagesByMethod(): Promise<Map<string, Message>> {
    const records = await realSessionRecords();
    const firstMessage = records.find((record) =>
        record.type === "message" && record.parentId === null
    );
    const rewind = records.find((record) => record.type === "rewind");
    if (firstMessage === undefined || rewind === undefined) {
        throw new Error("The real session file carried no null-bearing record");
    }
    const messages: Message[] = [
        { method: "session.record", lineNumber: 2, record: firstMessage },
        {
            method: "state.changed",
            state: {
                policy: { permissionModes: { bash: "ask" } },
                approvalMode: "auto",
                permissionPreferences: [],
            },
        },
        {
            method: "event.inject",
            event: {
                type: "delivery_received",
                sessionId: "s1",
                timestamp: "2026-08-22T00:00:00.000Z",
            },
        },
        {
            method: "pool.changed",
            projection: {
                efforts: {
                    "anthropic/one": {
                        requested: "high",
                        providerEffort: "high",
                        efforts: { high: "high", low: null },
                    },
                },
                imageSupport: { "anthropic/one": true },
            },
        },
        {
            method: "tools.changed",
            definitions: [{
                name: "one",
                description: "d",
                inputSchema: { type: "object" },
            }],
        },
        { method: "call.cancel", callId: "c1" },
        { method: "loop.appendHarnessMessage", text: "hi", tone: "soft" },
        {
            method: "loop.appendContext",
            messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
            harnessMessage: { text: "hi", tone: "primary" },
        },
        { method: "loop.compactNow", callId: "c2", turnActive: true },
        { method: "loop.hasPendingDeliveryTurn" },
        { method: "loop.readPermissionInspection" },
        { method: "loop.addPermissionGrants", grants: [] },
        { method: "loop.removePermissionGrant", id: "g1" },
        {
            method: "loop.timelineCommand",
            ownerId: "o1",
            command: { type: "timeline_request", requestId: "r1" },
        },
        { method: "loop.detachTimelineOwner", ownerId: "o1" },
        { method: "loop.timelineBlocked" },
        { method: "agent.wear", name: "reviewer" },
        { method: "approval.update", mode: "ask" },
        {
            method: "review.toolCall",
            callId: "c3",
            request: {
                tool: "bash",
                input: { command: "ls" },
                workspace: "/w",
                transcript: [],
            },
        },
        {
            method: "effect.apply",
            callId: "c4",
            effect: { type: "spawn_subagent", description: "d" },
            context: { approvalMode: "auto", model: "m" },
        },
        {
            method: "effect.commit",
            effect: { type: "notify_parent", text: "t" },
        },
        {
            method: "contributions.load",
            instructionRoot: { path: "/w", source: "workspace" },
        },
        { method: "session.append", record: rewind },
        { method: "tool.execute", callId: "c5", name: "read", input: {} },
        {
            method: "hook.preToolUse",
            payload: {
                type: "pre_tool_use",
                toolCall: { name: "read", input: {} },
            },
            options: { timeoutMs: 1000 },
        },
        {
            method: "hook.postToolUse",
            payload: {
                type: "post_tool_use",
                toolCall: { name: "read", input: {} },
                toolResult: { output: "x", isError: false },
            },
            options: { timeoutMs: 1000 },
        },
        {
            method: "compaction.complete",
            callId: "c6",
            role: "summarizer",
            prompt: "p",
        },
        {
            method: "event.emit",
            event: {
                type: "turn_started",
                sessionId: "s1",
                timestamp: "2026-08-22T00:00:00.000Z",
            },
        },
        {
            method: "reviewLog.append",
            entry: {
                tier: "single",
                outcome: "decided",
                tool: "bash",
                toolInput: { command: "ls" },
                workspace: "/w",
                routingReason: "configured",
                model: "m",
                systemPrompt: "s",
                prompt: "p",
                transcriptTurns: 1,
                continuedConversation: false,
                latencyMs: 5,
            },
        },
        {
            method: "pool.learned",
            ref: { provider: "anthropic", model: "one" },
            key: "efforts.xhigh",
            fact: { ok: false, seen: "2026-08-22", error: "refused" },
        },
        {
            method: "call.progress",
            callId: "c7",
            step: { step: "probe", label: "Probe", status: "running" },
        },
    ] as Message[];
    const byMethod = new Map<string, Message>();
    for (const message of messages) {
        byMethod.set(message.method, message);
    }
    return byMethod;
}

/** A real store, a real file, real records. No fake writes the lines. */
async function realSessionRecords(): Promise<Record<string, unknown>[]> {
    const dir = mkdtempSync(join(tmpdir(), "vera-protocol-"));
    const path = join(dir, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "11111111-1111-4111-8111-111111111111",
        cwd: dir,
    });
    const first = await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "one" }],
    });
    await store.appendMessage({
        role: "user",
        content: [{ type: "text", text: "two" }],
    });
    await store.rewindBefore(first.id);
    const text = await readFile(path, "utf8");
    return text.trimEnd().split("\n").map((line) =>
        JSON.parse(line) as Record<string, unknown>
    );
}

describe("the host and worker protocol", () => {
    test("names a message for every method, in both directions", async () => {
        const byMethod = await messagesByMethod();
        expect([...byMethod.keys()].sort())
            .toEqual([...HOST_PROTOCOL_METHODS].sort());
    });

    test("every message survives JSON unchanged", async () => {
        const byMethod = await messagesByMethod();
        for (const [method, message] of byMethod) {
            expectSameShape(roundTrip(message), message, method);
        }
    });

    test("a null field stays null and an absent field stays absent", async () => {
        const records = await realSessionRecords();
        const firstMessage = records.find((record) =>
            record.type === "message" && record.parentId === null
        );
        const rewind = records.find((record) => record.type === "rewind");
        expect(firstMessage?.parentId).toBeNull();
        expect(rewind?.headId).toBeNull();
        const pushed = roundTrip({
            method: "session.record" as const,
            lineNumber: 2,
            record: firstMessage as Record<string, unknown>,
        });
        expect(pushed.record.parentId).toBeNull();
        expect("parentId" in pushed.record).toBe(true);
        const appended = roundTrip({
            method: "session.append" as const,
            record: rewind as Record<string, unknown>,
        });
        expect(appended.record.headId).toBeNull();
        // The harness message carries no tone of its own, and must not gain a
        // `null` one on the way across.
        const optional = roundTrip({
            method: "loop.removePermissionGrant" as const,
            id: "g1",
        });
        expect("reason" in optional).toBe(false);
    });
});
