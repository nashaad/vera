import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listAgentsThroughHost } from "../../src/host/agent-list-client.ts";
import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { closeAgentThroughHost } from "../../src/host/agent-close-client.ts";
import {
    attachAgent,
    type AttachedAgentClient,
} from "../../src/host/attached-client.ts";
import { requestHostIdentity } from "../../src/host/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const config = {
    schema_version: 1,
    provider: "openrouter",
    model: "faux/test",
    approval_mode: "full_access",
} as const;

const skipOnSandbox = process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1";
const flowTest = skipOnSandbox ? test.skip : test;

/**
 * The incident this operation exists for: several prompts were buffered behind
 * an active turn, and every ordinary abort promoted the next one into another
 * paid turn. Close must leave the queue unable to produce a model request.
 */
flowTest(
    "close discards buffered prompts and stops the loop making model requests",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-close-queue-"));
        const paths = hostPaths(root);
        const host = await startResidentHost({
            config,
            createAdapter: () => new FauxAdapter(
                [
                    textResponse("first"),
                    textResponse("second"),
                    textResponse("third"),
                    textResponse("fourth"),
                    textResponse("fifth"),
                ],
                { chunkSize: 1, delayMs: 40 },
            ),
            ...paths,
        });
        try {
            await host.registry.create({ id: "runaway", workspace: root });
            const client = await attachAgent({
                socketPath: paths.socketPath,
                agentId: "runaway",
            });
            expect((await client.receive()).type).toBe("history");
            // One prompt starts the turn; the rest buffer behind it, which is
            // exactly the state the incident recovered from.
            for (const content of [
                "start the long turn",
                "queued one",
                "queued two",
                "queued three",
            ]) {
                await client.send({ type: "prompt", content });
            }
            await waitFor(async () =>
                (await listAgentsThroughHost(paths.socketPath))
                    .some((agent) =>
                        agent.id === "runaway" && agent.status === "working"
                    )
            );

            expect(await closeAgentThroughHost(paths.socketPath, "runaway"))
                .toEqual({ status: "closed" });

            const eventLog = join(paths.eventLogDirectory, "runaway.jsonl");
            const atAcknowledgement = await countEvents(
                eventLog,
                "model_request",
            );
            // The acknowledgement is the quiescence boundary, so nothing may
            // arrive after it however long anyone waits.
            await Bun.sleep(400);
            expect(await countEvents(eventLog, "model_request"))
                .toBe(atAcknowledgement);
            expect(atAcknowledgement).toBe(1);
            expect(await countEvents(eventLog, "turn_started")).toBe(1);

            expect(
                (await listAgentsThroughHost(paths.socketPath))
                    .filter((agent) =>
                        agent.id === "runaway" && agent.status === "working"
                    ),
            ).toEqual([]);
            // Close is not deletion: the durable session is still on disk.
            expect((await stat(
                join(paths.sessionDirectory, "runaway.jsonl"),
            )).isFile()).toBe(true);

            await client.close();
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
    10_000,
);

flowTest(
    "close is idempotent, leaves siblings working, and keeps the host running",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-close-sibling-"));
        const paths = hostPaths(root);
        const host = await startResidentHost({
            config,
            createAdapter: () => new FauxAdapter(
                [textResponse("done"), textResponse("done again")],
                { chunkSize: 1, delayMs: 20 },
            ),
            ...paths,
        });
        try {
            const pidBefore =
                (await requestHostIdentity(paths.socketPath))?.pid;
            expect(typeof pidBefore).toBe("number");

            await host.registry.create({ id: "target", workspace: root });
            await host.registry.create({ id: "sibling", workspace: root });

            expect(await closeAgentThroughHost(paths.socketPath, "target"))
                .toEqual({ status: "closed" });
            // Repeating a terminal operation asks for a state that already
            // holds, so it acknowledges rather than rejecting.
            expect(await closeAgentThroughHost(paths.socketPath, "target"))
                .toEqual({ status: "closed" });

            expect(await promptAttachedAgent(
                paths.socketPath,
                "sibling",
                "still there?",
            )).toBe("done");

            expect((await requestHostIdentity(paths.socketPath))?.pid)
                .toBe(pidBefore as number);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
    10_000,
);

flowTest(
    "a prompt racing the close never becomes a turn",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-close-race-"));
        const paths = hostPaths(root);
        const host = await startResidentHost({
            config,
            createAdapter: () => new FauxAdapter(
                [
                    textResponse("first"),
                    textResponse("second"),
                    textResponse("third"),
                ],
                { chunkSize: 1, delayMs: 40 },
            ),
            ...paths,
        });
        try {
            await host.registry.create({ id: "racer", workspace: root });
            const client = await attachAgent({
                socketPath: paths.socketPath,
                agentId: "racer",
            });
            expect((await client.receive()).type).toBe("history");
            await client.send({ type: "prompt", content: "start working" });
            await waitFor(async () =>
                (await listAgentsThroughHost(paths.socketPath))
                    .some((agent) =>
                        agent.id === "racer" && agent.status === "working"
                    )
            );

            const closed = closeAgentThroughHost(paths.socketPath, "racer");
            const enqueued = client
                .send({ type: "prompt", content: "sneak past the fence" })
                .then(() => undefined, () => undefined);
            expect(await closed).toEqual({ status: "closed" });
            await enqueued;

            const eventLog = join(paths.eventLogDirectory, "racer.jsonl");
            const atAcknowledgement = await countEvents(
                eventLog,
                "model_request",
            );
            await Bun.sleep(400);
            expect(await countEvents(eventLog, "model_request"))
                .toBe(atAcknowledgement);
            expect(atAcknowledgement).toBe(1);

            await client.close();
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
    10_000,
);

flowTest(
    "closing an idle agent succeeds and an unknown id is rejected",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-close-idle-"));
        const paths = hostPaths(root);
        const host = await startResidentHost({
            config,
            createAdapter: () => new FauxAdapter([textResponse("done")]),
            ...paths,
        });
        try {
            await host.registry.create({ id: "idle", workspace: root });
            expect(await closeAgentThroughHost(paths.socketPath, "idle"))
                .toEqual({ status: "closed" });
            expect(await closeAgentThroughHost(paths.socketPath, "nobody"))
                .toEqual({ status: "rejected", reason: "not_found" });
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
    10_000,
);

flowTest(
    "closing an agent closes the live children it spawned",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-close-tree-"));
        const paths = hostPaths(root);
        let adapterNumber = 0;
        const host = await startResidentHost({
            config,
            createAdapter() {
                adapterNumber += 1;
                return adapterNumber === 1
                    ? new FauxAdapter([
                        backgroundToolResponse(),
                        textResponse("child started"),
                    ])
                    : new FauxAdapter(
                        [
                            textResponse("child turn one"),
                            textResponse("child turn two"),
                        ],
                        { chunkSize: 1, delayMs: 60 },
                    );
            },
            ...paths,
        });
        try {
            await host.registry.create({ id: "parent", workspace: root });
            const parent = await attachAgent({
                socketPath: paths.socketPath,
                agentId: "parent",
            });
            expect((await parent.receive()).type).toBe("history");
            await parent.send({
                type: "prompt",
                content: "run the review in the background",
            });
            await finishTurn(parent);
            await parent.detach();

            const child = await waitForAgent(
                paths.socketPath,
                (agent) =>
                    agent.kind === "background" && agent.status === "working",
            );
            expect(host.registry.find(child)).toBeDefined();
            expect(await closeAgentThroughHost(paths.socketPath, "parent"))
                .toEqual({ status: "closed" });

            const childLog = join(paths.eventLogDirectory, `${child}.jsonl`);
            const atAcknowledgement = await countEvents(
                childLog,
                "model_request",
            );
            await Bun.sleep(400);
            expect(await countEvents(childLog, "model_request"))
                .toBe(atAcknowledgement);
            // The parent cannot be quiesced while a child it spawned is
            // still free to call a provider, so the child goes too.
            expect(host.registry.find(child)).toBeUndefined();
            expect(host.registry.find("parent")).toBeUndefined();
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
    10_000,
);

async function waitForAgent(
    socketPath: string,
    predicate: (agent: RegisteredAgentSummary) => boolean,
): Promise<string> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        const agent = (await listAgentsThroughHost(socketPath)).find(predicate);
        if (agent !== undefined) {
            return agent.id;
        }
        await Bun.sleep(5);
    }
    throw new Error("Timed out waiting for a background agent");
}

function backgroundToolResponse(id = "background-1"): AssistantMessage {
    return {
        role: "assistant",
        content: [{
            type: "tool_call",
            id,
            name: "async_subagent",
            input: { description: "Review the change" },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

flowTest(
    "close ends an agent that is waiting for an approval nobody answers",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-close-approval-"));
        const paths = hostPaths(root);
        const host = await startResidentHost({
            config: { ...config, approval_mode: "ask" },
            createAdapter: () => new FauxAdapter([
                bashToolResponse("env CLOSE=waiting"),
                textResponse("this must never be requested"),
            ]),
            ...paths,
        });
        try {
            await host.registry.create({ id: "waiting", workspace: root });
            const client = await attachAgent({
                socketPath: paths.socketPath,
                agentId: "waiting",
            });
            expect((await client.receive()).type).toBe("history");
            await client.send({ type: "prompt", content: "run something" });
            await waitUntilUpdate(client, "ui_request");

            expect(await closeAgentThroughHost(paths.socketPath, "waiting"))
                .toEqual({ status: "closed" });

            const eventLog = join(paths.eventLogDirectory, "waiting.jsonl");
            const atAcknowledgement = await countEvents(
                eventLog,
                "model_request",
            );
            await Bun.sleep(400);
            expect(await countEvents(eventLog, "model_request"))
                .toBe(atAcknowledgement);
            expect(await countEvents(eventLog, "turn_started")).toBe(1);
            expect(host.registry.find("waiting")).toBeUndefined();
            await client.close();
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
    10_000,
);

flowTest(
    "close ends an agent in the middle of a tool call",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-close-tool-"));
        const paths = hostPaths(root);
        const host = await startResidentHost({
            config,
            createAdapter: () => new FauxAdapter([
                bashToolResponse("sleep 5"),
                textResponse("this must never be requested"),
            ]),
            ...paths,
        });
        try {
            await host.registry.create({ id: "toolbound", workspace: root });
            const client = await attachAgent({
                socketPath: paths.socketPath,
                agentId: "toolbound",
            });
            expect((await client.receive()).type).toBe("history");
            await client.send({ type: "prompt", content: "run the slow tool" });
            const eventLog = join(paths.eventLogDirectory, "toolbound.jsonl");
            await waitFor(async () =>
                await countEvents(eventLog, "tool_execution_started") === 1
            );

            expect(await closeAgentThroughHost(paths.socketPath, "toolbound"))
                .toEqual({ status: "closed" });
            const atAcknowledgement = await countEvents(
                eventLog,
                "model_request",
            );
            await Bun.sleep(400);
            expect(await countEvents(eventLog, "model_request"))
                .toBe(atAcknowledgement);
            expect(await countEvents(eventLog, "turn_started")).toBe(1);
            expect(host.registry.find("toolbound")).toBeUndefined();
            await client.close();
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
    15_000,
);

async function waitUntilUpdate(
    client: AttachedAgentClient,
    type: string,
): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if ((await client.receive()).type === type) {
            return;
        }
    }
    throw new Error(`Timed out waiting for a ${type} update`);
}

function bashToolResponse(command: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "bash-1",
            name: "bash",
            input: { command },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function hostPaths(root: string): {
    readonly socketPath: string;
    readonly lockPath: string;
    readonly sessionDirectory: string;
    readonly eventLogDirectory: string;
} {
    return {
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
        eventLogDirectory: join(root, "events"),
    };
}

async function countEvents(path: string, type: string): Promise<number> {
    let contents: string;
    try {
        contents = await readFile(path, "utf8");
    } catch {
        return 0;
    }
    return contents
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => (JSON.parse(line) as { type: string }).type)
        .filter((entry) => entry === type)
        .length;
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await predicate()) {
            return;
        }
        await Bun.sleep(5);
    }
    throw new Error("Timed out waiting for resident agent state");
}

async function promptAttachedAgent(
    socketPath: string,
    agentId: string,
    content: string,
): Promise<string> {
    const client = await attachAgent({ socketPath, agentId });
    try {
        expect((await client.receive()).type).toBe("history");
        await client.send({ type: "prompt", content });
        return await finishTurn(client);
    } finally {
        if (!client.closed) {
            await client.detach().catch(() => client.close());
        }
    }
}

async function finishTurn(client: AttachedAgentClient): Promise<string> {
    let response = "";
    while (true) {
        const update = await client.receive();
        if (update.type === "assistant_delta") {
            response += update.text;
        }
        if (update.type === "turn_finished") {
            return response;
        }
    }
}

function textResponse(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

/**
 * The regression: the close walk snapshotted the subtree, then awaited each
 * child before touching the parent. A child takes seconds to exit, and for all
 * of them the parent was still admitting work, so a subagent it spawned in that
 * window was never in the snapshot and outlived the acknowledgement.
 *
 * The interleaving is driven by the abort signals rather than by sleeps: the
 * first child's fence is what releases the parent's pending model request, so
 * the second spawn lands inside the window on any machine. The parent can only
 * reach that request if the walk left it unfenced.
 */
flowTest(
    "a subagent spawned while the close walks the tree is closed too",
    async () => {
        const root = await mkdtemp(join(tmpdir(), "vera-close-spawn-race-"));
        const paths = hostPaths(root);
        const firstChildFenced = deferred();
        const parentFenced = deferred();
        const secondChildRequested = deferred();
        let adapterNumber = 0;
        const host = await startResidentHost({
            config,
            createAdapter() {
                adapterNumber += 1;
                if (adapterNumber === 1) {
                    return new GatedAdapter(
                        [
                            backgroundToolResponse("background-1"),
                            backgroundToolResponse("background-2"),
                            textResponse("parent done"),
                        ],
                        async (call, signal) => {
                            signal?.addEventListener(
                                "abort",
                                () => parentFenced.resolve(),
                            );
                            if (call === 1) {
                                await firstChildFenced.promise;
                            }
                        },
                    );
                }
                if (adapterNumber === 2) {
                    return new GatedAdapter(
                        [textResponse("first child done")],
                        async (_call, signal) => {
                            await onceAborted(signal);
                            firstChildFenced.resolve();
                            // Hold the first child inside the close walk until
                            // the parent has had its chance to spawn again.
                            // The timeout is only a deadlock guard.
                            await Promise.race([
                                secondChildRequested.promise,
                                parentFenced.promise,
                                Bun.sleep(2000),
                            ]);
                        },
                    );
                }
                secondChildRequested.resolve();
                // Held open so a second child that survives the walk is still
                // on the roster when the assertions run.
                return new GatedAdapter(
                    [textResponse("second child done")],
                    (_call, signal) => onceAborted(signal),
                );
            },
            ...paths,
        });
        try {
            await host.registry.create({ id: "parent", workspace: root });
            const parent = await attachAgent({
                socketPath: paths.socketPath,
                agentId: "parent",
            });
            expect((await parent.receive()).type).toBe("history");
            await parent.send({
                type: "prompt",
                content: "run the review in the background",
            });
            const firstChild = await waitForAgent(
                paths.socketPath,
                (agent) => agent.kind === "background",
            );
            // The parent must be inside its second model request, which is the
            // request the first child's fence releases.
            await waitFor(async () => adapterNumber >= 2);
            await parent.detach();

            expect(await closeAgentThroughHost(paths.socketPath, "parent"))
                .toEqual({ status: "closed" });

            expect(host.registry.find("parent")).toBeUndefined();
            expect(host.registry.find(firstChild)).toBeUndefined();
            expect(host.registry.list().filter((agent) => agent.live))
                .toEqual([]);
            // A third adapter only ever exists because a second subagent got
            // far enough to ask a provider for something.
            const adaptersAtAcknowledgement = adapterNumber;
            await Bun.sleep(400);
            expect(adapterNumber).toBe(adaptersAtAcknowledgement);
            expect(adapterNumber).toBe(2);
        } finally {
            await host.close();
            await rm(root, { recursive: true, force: true });
        }
    },
    20_000,
);

interface Deferred {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
}

function deferred(): Deferred {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((settle) => {
        resolve = () => settle();
    });
    return { promise, resolve: () => resolve() };
}

function onceAborted(signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined) {
        return new Promise(() => undefined);
    }
    if (signal.aborted) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve());
    });
}

/**
 * A scripted adapter whose every request can be held open by the test, so an
 * interleaving is decided by what has happened rather than by how long it took.
 */
class GatedAdapter implements ModelAdapter {
    private calls = 0;

    constructor(
        private readonly responses: readonly AssistantMessage[],
        private readonly gate: (
            call: number,
            signal: AbortSignal | undefined,
        ) => Promise<void>,
    ) {}

    stream(request: ModelRequest): ModelEventStream {
        const call = this.calls;
        this.calls += 1;
        const scripted = this.responses[call];
        const inner = new FauxAdapter(
            scripted === undefined ? [] : [scripted],
        );
        const stream = new ModelEventStream();
        void (async () => {
            await this.gate(call, request.signal);
            for await (const event of inner.stream(request)) {
                stream.push(event);
            }
        })();
        return stream;
    }
}
