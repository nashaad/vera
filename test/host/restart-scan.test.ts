import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recoverCrashedTurns } from "../../src/host/restart-scan.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { readSessionSeed } from "../../src/host/agent-registry/helpers.ts";
import { resumeOrFind, withSessionReservation, type RestoringSessions } from "../../src/host/session-host/storage.ts";
import { appendRestartRecord, listRestartRecords } from "../../src/store/restart-records.ts";
import { CRASHED_TOOL_RESULT, CRASH_CUT_MESSAGE, SessionStore, readSessionTurnState } from "../../src/store/session-store.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const source = { provider: "faux", api: "scripted", model: "test" };
const user: ModelMessage = {
    role: "user",
    content: [{ type: "text", text: "build the thing" }],
};

interface Scenario {
    readonly root: string;
    readonly sessions: string;
    readonly lockPath: string;
    readonly recordPath: string;
    readonly startedAt: Date;
}

async function scenario(): Promise<Scenario> {
    const root = await mkdtemp(join(tmpdir(), "vera-restart-scan-"));
    const sessions = join(root, "runtime", "sessions");
    await mkdir(sessions, { recursive: true });
    return {
        root,
        sessions,
        lockPath: join(root, "host.lock"),
        recordPath: join(root, "runtime", "restarts", "restarts.jsonl"),
        startedAt: new Date(Date.now() - 60_000),
    };
}

async function writeStaleLock(
    lockPath: string,
    startedAt: Date,
    pid = 424242,
): Promise<void> {
    await writeFile(lockPath, `${JSON.stringify({
        schema_version: 3,
        pid,
        started_at: startedAt.toISOString(),
        socket_path: join(lockPath, "..", "host.sock"),
        build_id: "build-a",
    }, null, 2)}\n`);
}

async function sessionWith(
    dir: string,
    id: string,
    messages: readonly ModelMessage[],
): Promise<string> {
    const path = join(dir, `${id}.jsonl`);
    const store = await SessionStore.create(path, { sessionId: id, cwd: dir });
    for (const message of messages) {
        await store.appendMessage(message);
    }
    return path;
}

function assistant(stopReason: "stop" | "tool_use" | "aborted"): ModelMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: "working" }],
        source,
        usage: emptyUsage(),
        stopReason,
    };
}

function toolUse(): ModelMessage {
    return {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call-1",
            name: "read",
            input: { path: "notes.md" },
        }],
        source,
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

test("a turn left open by a crash is recorded as a crash", async () => {
    const s = await scenario();
    await sessionWith(s.sessions, "crow-open", [user]);
    await writeStaleLock(s.lockPath, s.startedAt);

    const result = await recoverCrashedTurns({
        lockPath: s.lockPath,
        sessionDirectory: s.sessions,
        recordPath: s.recordPath,
        isProcessAlive: () => false,
    });

    expect(result.recorded).toEqual(["crow-open"]);
    expect(listRestartRecords(s.recordPath)).toMatchObject([
        { session_id: "crow-open", cause: "crash" },
    ]);
});

test("a turn waiting on a tool result is open too", async () => {
    const s = await scenario();
    await sessionWith(s.sessions, "crow-tool", [user, toolUse()]);
    await writeStaleLock(s.lockPath, s.startedAt);

    const result = await recoverCrashedTurns({
        lockPath: s.lockPath,
        sessionDirectory: s.sessions,
        recordPath: s.recordPath,
        isProcessAlive: () => false,
    });

    expect(result.recorded).toEqual(["crow-tool"]);
    const repaired = await SessionStore.open(join(s.sessions, "crow-tool.jsonl"));
    expect(repaired.messages().at(-1)).toMatchObject({
        role: "tool_result", toolCallId: "call-1", isError: true,
        content: [{ type: "text", text: CRASHED_TOOL_RESULT }],
    });
    expect((await readSessionTurnState(repaired.path)).turnOpen).toBe(false);
    const seed = await readSessionSeed(repaired.path);
    expect(seed.records.find((record) => record.text === CRASH_CUT_MESSAGE)).toMatchObject({
        type: "harness_message", tone: "soft",
    });
    expect(JSON.stringify(seed.records)).not.toContain("crashCut");
});

test("an existing ledger entry does not prevent an interrupted repair", async () => {
    const s = await scenario();
    const path = await sessionWith(s.sessions, "crow-open", [user, toolUse()]);
    await writeStaleLock(s.lockPath, s.startedAt);
    appendRestartRecord({ session_id: "crow-open", cause: "crash", at: new Date().toISOString() }, s.recordPath);
    const result = await recoverCrashedTurns({
        lockPath: s.lockPath, sessionDirectory: s.sessions, recordPath: s.recordPath,
        isProcessAlive: () => false,
    });
    expect(result.recorded).toEqual([]);
    expect((await readSessionTurnState(path)).turnOpen).toBe(false);
    expect(listRestartRecords(s.recordPath)).toHaveLength(1);
});

test("a resume waits for the same session's scan while another session opens", async () => {
    const s = await scenario();
    const path = await sessionWith(s.sessions, "crow-open", [user, toolUse()]);
    const otherPath = await sessionWith(s.root, "crow-other", [user, assistant("stop")]);
    await writeStaleLock(s.lockPath, s.startedAt);
    const reservations: RestoringSessions = new Map();
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]), model: "faux/test", approvalMode: "auto",
    });
    let entered!: () => void;
    let release!: () => void;
    const scanning = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let resumed = false;
    const scan = recoverCrashedTurns({
        lockPath: s.lockPath, sessionDirectory: s.sessions, recordPath: s.recordPath,
        isProcessAlive: () => false,
        withSession: (file, recover) => withSessionReservation(file, reservations, async () => {
            entered();
            await gate;
            await recover();
        }),
    });
    try {
        await scanning;
        const waiting = resumeOrFind(registry, path, reservations).then((agent) => {
            resumed = true;
            return agent;
        });
        const other = await resumeOrFind(registry, otherPath, reservations);
        expect(other.id).toBe("crow-other");
        expect(resumed).toBe(false);
        release();
        await scan;
        const agent = await waiting;
        expect(agent.id).toBe("crow-open");
        expect(registry.agents.get(agent.id)?.store.messages().at(-1)).toMatchObject({
            role: "tool_result", toolCallId: "call-1", isError: true,
        });
        const repaired = await readFile(path, "utf8");
        expect((await readSessionTurnState(path)).turnOpen).toBe(false);
        expect(await (await SessionStore.open(path)).repairCrashedTurn()).toBe(false);
        expect(await readFile(path, "utf8")).toBe(repaired);
    } finally {
        release();
        await scan.catch(() => {});
        await registry.close();
        await rm(s.root, { recursive: true, force: true });
    }
});

test("a finished turn and a cut turn are not recorded", async () => {
    const s = await scenario();
    await sessionWith(s.sessions, "crow-done", [user, assistant("stop")]);
    await sessionWith(s.sessions, "crow-esc", [user, assistant("aborted")]);
    await writeStaleLock(s.lockPath, s.startedAt);

    const result = await recoverCrashedTurns({
        lockPath: s.lockPath,
        sessionDirectory: s.sessions,
        recordPath: s.recordPath,
        isProcessAlive: () => false,
    });

    expect(result.scanned).toBe(2);
    expect(result.recorded).toEqual([]);
    expect(listRestartRecords(s.recordPath)).toEqual([]);
});

test("a session last written before the stale lock is not read", async () => {
    const s = await scenario();
    const path = await sessionWith(s.sessions, "crow-old", [user]);
    const earlier = new Date(s.startedAt.getTime() - 3_600_000);
    await utimes(path, earlier, earlier);
    await writeStaleLock(s.lockPath, s.startedAt);

    const result = await recoverCrashedTurns({
        lockPath: s.lockPath,
        sessionDirectory: s.sessions,
        recordPath: s.recordPath,
        isProcessAlive: () => false,
    });

    expect(result.scanned).toBe(0);
    expect(result.recorded).toEqual([]);
});

test("without a lock file there is no scan", async () => {
    const s = await scenario();
    await sessionWith(s.sessions, "crow-open", [user]);

    const result = await recoverCrashedTurns({
        lockPath: s.lockPath,
        sessionDirectory: s.sessions,
        recordPath: s.recordPath,
        isProcessAlive: () => false,
    });

    expect(result).toEqual({ scanned: 0, recorded: [] });
    expect(listRestartRecords(s.recordPath)).toEqual([]);
});

test("a lock whose process is still alive is not stale, so nothing is scanned", async () => {
    const s = await scenario();
    await sessionWith(s.sessions, "crow-open", [user]);
    await writeStaleLock(s.lockPath, s.startedAt);

    const result = await recoverCrashedTurns({
        lockPath: s.lockPath,
        sessionDirectory: s.sessions,
        recordPath: s.recordPath,
        isProcessAlive: () => true,
    });

    expect(result).toEqual({ scanned: 0, recorded: [] });
});

test("a second scan of the same stale lock adds no duplicate record", async () => {
    const s = await scenario();
    await sessionWith(s.sessions, "crow-open", [user]);
    await writeStaleLock(s.lockPath, s.startedAt);
    const options = {
        lockPath: s.lockPath,
        sessionDirectory: s.sessions,
        recordPath: s.recordPath,
        isProcessAlive: () => false,
    };

    await recoverCrashedTurns(options);
    const again = await recoverCrashedTurns(options);

    expect(again.recorded).toEqual([]);
    expect(listRestartRecords(s.recordPath)).toHaveLength(1);
});

test("a live pid whose identity mismatches the lock is a reused pid, so the scan runs", async () => {
    const s = await scenario();
    await sessionWith(s.sessions, "crow-open", [user]);
    await writeStaleLock(s.lockPath, s.startedAt);

    const result = await recoverCrashedTurns({
        lockPath: s.lockPath,
        sessionDirectory: s.sessions,
        recordPath: s.recordPath,
        isProcessAlive: () => true,
        recordIdentity: () => "mismatch",
    });

    expect(result.recorded).toEqual(["crow-open"]);
});
