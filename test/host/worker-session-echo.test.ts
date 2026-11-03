import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { readSessionSeed } from "../../src/host/agent-registry/helpers.ts";
import { createWorkerBoundaryServer } from "../../src/host/worker/boundary-server.ts";
import { startSeededWorker, startWorker } from "../../src/host/worker/handle.ts";
import { createJsonPipe } from "../../src/host/worker/pipe.ts";
import { createRemoteHostBoundary } from "../../src/host/worker/remote-boundary.ts";
import { WorkerSessionStore } from "../../src/host/worker/session.ts";
import type { WorkerSessionSeed } from "../../src/host/worker/start.ts";
import type { ModelMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const SESSION_START_ADAPTER = fileURLToPath(
    new URL("./fixtures/worker-session-start-adapter.ts", import.meta.url),
);

const directories: string[] = [];

afterAll(() => {
    for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function workspace(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-worker-echo-"));
    directories.push(directory);
    return directory;
}

function user(text: string): ModelMessage {
    return { role: "user", content: [{ type: "text", text }] };
}

function texts(messages: readonly ModelMessage[]): string[] {
    return messages.map((message) => JSON.stringify(message.content));
}

async function waitFor(
    predicate: () => boolean,
    timeoutMs = 4_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error("Timed out waiting");
        }
        await Bun.sleep(5);
    }
}

interface Link {
    readonly host: SessionStore;
    readonly worker: WorkerSessionStore;
    readonly diverged: Error[];
    readonly pushRecord: (
        line: number,
        record: Record<string, unknown>,
    ) => void;
}

/** A host store and a worker replica joined by real pipes and the real boundary server. */
async function link(
    prepare: (
        host: SessionStore,
        link: (seed: WorkerSessionSeed) => Link,
    ) => Promise<Link>,
): Promise<Link> {
    const directory = workspace();
    const host = await SessionStore.create(join(directory, "session.jsonl"), {
        sessionId: "echo",
        cwd: directory,
    });
    const connect = (seed: WorkerSessionSeed): Link => {
        const toWorker = new PassThrough();
        const toHost = new PassThrough();
        const diverged: Error[] = [];
        const server = createWorkerBoundaryServer({
            pipe: createJsonPipe(
                { input: toHost, output: toWorker },
                {
                    onRequest: (body) => server.handleRequest(body),
                    onNotification: (body) => server.handleNotification(body),
                },
            ),
            store: host,
            services: {},
        });
        const remote = createRemoteHostBoundary({
            pipe: createJsonPipe(
                { input: toWorker, output: toHost },
                { onNotification: (body) => remote.acceptNotification(body) },
            ),
            session: seed,
            offers: {
                approvalModeRead: false,
                modelSettings: false,
                selectedAgent: false,
            },
            capabilities: {
                updateApprovalMode: false,
                reviewToolCall: false,
                applyHostToolEffect: false,
                requestMissingSubagentConfiguration: false,
                applyCommittedToolEffect: false,
                loadContextualContributions: false,
                checkSkillFile: false,
                hooks: false,
                reviewLog: false,
                hasPendingDeliveryTurn: false,
                selectAgent: false,
                listSkills: false,
                invokeSkill: false,
            },
            state: { policy: {} },
            onReplicaDiverged: (error) => diverged.push(error),
        });
        const worker = remote.boundary.owned?.sessionStore;
        if (!(worker instanceof WorkerSessionStore)) {
            throw new Error("The worker boundary has no worker session store");
        }
        return { host, worker, diverged, pushRecord: server.pushRecord };
    };
    return prepare(host, connect);
}

test("a record written between the seed and the watch is reported as a gap, not waited for", async () => {
    const joined = await link(async (host, connect) => {
        const seed = await readSessionSeed(host.path);
        await host.appendMessage(user("lost between seed and watch"));
        const linked = connect(seed);
        host.watchRecords(linked.pushRecord);
        await host.appendMessage(user("echoed"));
        return linked;
    });

    await waitFor(() => joined.diverged.length > 0);
    expect(joined.diverged[0]?.message).toContain("line 2");
    expect(joined.worker.appliedThrough()).toBe(1);
    expect(joined.worker.appendMessage(user("after"))).rejects.toThrow(
        joined.diverged[0]!.message,
    );
});

test("the worker applies its own writes and the host's, each once and in file order", async () => {
    const joined = await link(async (host, connect) => {
        const linked = connect(await readSessionSeed(host.path));
        host.watchRecords(linked.pushRecord);
        return linked;
    });

    for (let round = 0; round < 25; round += 1) {
        await joined.worker.appendMessage(user(`worker ${round}`));
        await joined.host.appendMessage(user(`host ${round}`));
        await waitFor(
            () => joined.worker.appliedThrough()
                === joined.host.appendedLineCount(),
        );
    }

    expect(joined.diverged).toEqual([]);
    expect(joined.worker.messages()).toHaveLength(50);
    expect(texts(joined.worker.messages())).toEqual(
        texts(joined.host.messages()),
    );
});

test("host records that arrive while the worker's own write is unanswered are not a gap", async () => {
    const joined = await link(async (host, connect) => {
        const linked = connect(await readSessionSeed(host.path));
        host.watchRecords(linked.pushRecord);
        return linked;
    });

    for (let round = 0; round < 50; round += 1) {
        await Promise.all([
            joined.worker.appendName(`worker ${round}`),
            joined.host.appendName(`host ${round}`),
            joined.worker.appendName(`worker again ${round}`),
            joined.host.appendName(`host again ${round}`),
        ]);
    }
    await waitFor(
        () => joined.worker.appliedThrough() === joined.host.appendedLineCount(),
    );

    expect(joined.diverged).toEqual([]);
    expect(joined.worker.appliedThrough()).toBe(201);
});

test("the replica refuses a hole, a repeat, and everything after the first failure", async () => {
    const directory = workspace();
    const host = await SessionStore.create(join(directory, "session.jsonl"), {
        sessionId: "echo-unit",
        cwd: directory,
    });
    await host.appendMessage(user("a"));
    await host.appendMessage(user("b"));
    await host.appendMessage(user("c"));
    const seed = await readSessionSeed(host.path);
    const [a, b, c] = seed.records as [
        Record<string, unknown>,
        Record<string, unknown>,
        Record<string, unknown>,
    ];

    const hole = WorkerSessionStore.seed(host.path, seed.header);
    hole.applyHostRecord(2, a);
    expect(() => hole.applyHostRecord(4, c)).toThrow(
        /expected line 3 but received line 4/,
    );
    expect(() => hole.applyHostRecord(3, b)).toThrow(
        /expected line 3 but received line 4/,
    );
    expect(hole.appliedThrough()).toBe(2);

    const repeat = WorkerSessionStore.seed(host.path, seed.header);
    repeat.applyHostRecord(2, a);
    expect(() => repeat.applyHostRecord(2, a)).toThrow(
        /already applied through line 2/,
    );
});

test("a worker whose copy lost a record finishes with the gap as its error", async () => {
    const directory = workspace();
    const path = join(directory, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "echo-process",
        cwd: directory,
    });
    const updates: AgentUpdate[] = [];
    const handle = await startWorker({
        store,
        session: await readSessionSeed(path),
        model: "test",
        adapter: {
            module: SESSION_START_ADAPTER,
            options: { requestPath: join(directory, "requests.jsonl") },
        },
        data: { approvalMode: "full_access" },
        onUpdate: (update) => void updates.push(update),
    });
    try {
        store.watchRecords(() => {});
        await store.appendMessage(user("never echoed"));
        store.watchRecords(handle.server.pushRecord);
        await store.appendMessage(user("echoed"));

        const outcome = await Promise.race([
            handle.outcome,
            Bun.sleep(15_000).then(() => "still running" as const),
        ]);
        expect(outcome).toMatchObject({
            kind: "failed",
            error: expect.stringContaining("expected line 2 but received line 3"),
        });
    } finally {
        handle.kill();
        await handle.outcome;
    }
}, 30_000);

test("a request after the worker's own writes carries each message once", async () => {
    const directory = workspace();
    const path = join(directory, "session.jsonl");
    const requestPath = join(directory, "requests.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "echo-once",
        cwd: directory,
    });
    const updates: AgentUpdate[] = [];
    const handle = await startWorker({
        store,
        session: await readSessionSeed(path),
        model: "test",
        adapter: { module: SESSION_START_ADAPTER, options: { requestPath } },
        data: { approvalMode: "full_access" },
        onUpdate: (update) => void updates.push(update),
    });
    try {
        store.watchRecords(handle.server.pushRecord);
        for (const word of ["first", "second"]) {
            const finished = updates.filter(
                (update) => update.type === "turn_finished",
            ).length;
            handle.send({ type: "prompt", content: word });
            await waitFor(
                () => updates.filter(
                    (update) => update.type === "turn_finished",
                ).length > finished,
            );
        }
        const requests = readFileSync(requestPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as {
                readonly messages: readonly ModelMessage[];
            });
        const last = JSON.stringify(requests.at(-1)?.messages);
        expect(last.match(/"first"/g)).toHaveLength(1);
        expect(last.match(/"second"/g)).toHaveLength(1);
        expect(last.match(/"done"/g)).toHaveLength(1);
        expect(store.messages()).toHaveLength(4);
    } finally {
        handle.kill();
        await handle.outcome;
    }
}, 30_000);

test("a host write made while the seed is being read is in the worker's first request", async () => {
    const directory = workspace();
    const path = join(directory, "session.jsonl");
    const requestPath = join(directory, "requests.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "echo-seeding",
        cwd: directory,
    });
    await store.appendMessage(user("in the seed"));
    const updates: AgentUpdate[] = [];
    let seedRead: () => void = () => {};
    const seedStarted = new Promise<void>((resolve) => {
        seedRead = resolve;
    });
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
        openGate = resolve;
    });

    const starting = startSeededWorker(
        {
            store,
            model: "test",
            adapter: { module: SESSION_START_ADAPTER, options: { requestPath } },
            data: { approvalMode: "full_access" },
            onUpdate: (update) => void updates.push(update),
        },
        async (seedPath) => {
            const seed = await readSessionSeed(seedPath);
            seedRead();
            await gate;
            return seed;
        },
    );
    await seedStarted;
    const writing = store.appendMessage(user("written during the seed read"));
    await Bun.sleep(50);
    expect(store.appendedLineCount()).toBe(2);
    openGate();

    const handle = await starting;
    try {
        await writing;
        await store.appendMessage(user("written after the start"));
        handle.send({ type: "prompt", content: "go" });
        await waitFor(() => updates.some((update) => update.type === "turn_finished"));
        const request = readFileSync(requestPath, "utf8").trim().split("\n")[0];
        const messages = (JSON.parse(request as string) as {
            readonly messages: readonly ModelMessage[];
        }).messages;
        expect(texts(messages).filter((text) => text.includes("in the seed"))).toHaveLength(1);
        expect(texts(messages).filter((text) => text.includes("written during the seed read"))).toHaveLength(1);
        expect(texts(messages).filter((text) => text.includes("written after the start"))).toHaveLength(1);
    } finally {
        handle.kill();
        await handle.outcome;
    }
}, 30_000);
