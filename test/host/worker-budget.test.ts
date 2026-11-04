import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import type { ExtensionRegistry } from "../../src/extensions/registry.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const ADAPTER = fileURLToPath(
    new URL("./fixtures/worker-scripted-adapter.ts", import.meta.url),
);
const BUDGET = fileURLToPath(new URL("../../extensions/budget", import.meta.url));

function assistantText(body: string, cost: number): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: body }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: {
            ...emptyUsage(),
            inputTokens: 100,
            outputTokens: 10,
            totalTokens: 110,
            cost,
        },
        stopReason: "stop",
    };
}

async function receiveUntil(
    attachment: AgentAttachment,
    predicate: (update: AgentUpdate) => boolean,
): Promise<AgentUpdate> {
    const deadline = Date.now() + 20_000;
    while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Timed out waiting for agent update");
        const update = await Promise.race([
            attachment.receive(),
            Bun.sleep(remaining).then(() => {
                throw new Error("Timed out waiting for agent update");
            }),
        ]);
        if (predicate(update)) return update;
    }
}

interface BudgetWorker {
    readonly root: string;
    readonly sessionPath: string;
    readonly requestLogPath: string;
    readonly extensions: ExtensionRegistry;
    readonly registry: AgentRegistry;
    readonly detach: () => void;
}

async function budgetWorker(script?: readonly AssistantMessage[]): Promise<BudgetWorker> {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-budget-"));
    const previousHome = process.env.VERA_HOME;
    const previousExtensions = process.env.VERA_WORKER_EXTENSIONS;
    process.env.VERA_HOME = join(root, "home");
    process.env.VERA_WORKER_EXTENSIONS = "1";
    await mkdir(process.env.VERA_HOME, { recursive: true });
    const extensions = await startExtensionRegistry({
        extensions: [{ path: BUDGET, enabled: true, config: null }],
    });
    const requestLogPath = join(root, "requests.jsonl");
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        modelMiddleware: extensions.modelMiddleware(),
        workerExtensions: () => [{ path: BUDGET, enabled: true, config: null }],
        workerAdapterSpec: () => ({
            module: ADAPTER,
            options: {
                script: script ?? [
                    assistantText("one", 1),
                    assistantText("two", 1),
                    assistantText("three", 1),
                ],
                requestLogPath,
            },
        }),
        model: "faux/test",
        approvalMode: "full_access",
    });
    return {
        root,
        sessionPath: join(root, "session.jsonl"),
        requestLogPath,
        extensions,
        registry,
        detach: () => {
            if (previousHome === undefined) delete process.env.VERA_HOME;
            else process.env.VERA_HOME = previousHome;
            if (previousExtensions === undefined) delete process.env.VERA_WORKER_EXTENSIONS;
            else process.env.VERA_WORKER_EXTENSIONS = previousExtensions;
        },
    };
}

async function closeWorker(worker: BudgetWorker): Promise<void> {
    await worker.registry.close();
    await worker.extensions.close();
    worker.detach();
    await rm(worker.root, { recursive: true, force: true });
}

function requestCount(worker: BudgetWorker): number {
    if (!existsSync(worker.requestLogPath)) return 0;
    return readFileSync(worker.requestLogPath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .length;
}

async function assistantCosts(path: string): Promise<number[]> {
    if (!existsSync(path)) return [];
    const lines = (await readFile(path, "utf8")).split("\n");
    const costs: number[] = [];
    for (const line of lines) {
        if (line.trim().length === 0) continue;
        const entry = JSON.parse(line) as {
            readonly type?: string;
            readonly message?: {
                readonly role?: string;
                readonly usage?: { readonly cost?: number };
            };
        };
        if (
            entry.type === "message"
            && entry.message?.role === "assistant"
            && typeof entry.message.usage?.cost === "number"
        ) {
            costs.push(entry.message.usage.cost);
        }
    }
    return costs;
}

async function setBudget(worker: BudgetWorker, id: string, amount: string): Promise<void> {
    await worker.extensions.invokeCommand(
        "budget",
        amount,
        worker.root,
        undefined,
        id,
        worker.sessionPath,
    );
}

async function openSession(worker: BudgetWorker, id: string): Promise<AgentAttachment> {
    const agent = await worker.registry.create({
        id,
        workspace: worker.root,
        sessionPath: worker.sessionPath,
    });
    const client = agent.attach();
    expect((await client.receive()).type).toBe("history");
    return client;
}

test("a worker sees its own appended cost before the next model request", async () => {
    const worker = await budgetWorker();
    try {
        const client = await openSession(worker, "budget-notice");
        client.send({ type: "prompt", content: "first" });
        await receiveUntil(client, (update) => update.type === "turn_finished");
        expect(requestCount(worker)).toBe(1);
        expect(await assistantCosts(worker.sessionPath)).toEqual([1]);

        await setBudget(worker, "budget-notice", "1.5");
        client.send({ type: "prompt", content: "second" });
        const notice = await receiveUntil(
            client,
            (update) => update.type === "notice" || update.type === "turn_finished",
        );
        expect(notice.type).toBe("notice");
        if (notice.type === "notice") {
            expect(notice.text).toContain(
                "Halfway through budget: $1.00 spent of $1.50.",
            );
        }
        await receiveUntil(client, (update) => update.type === "turn_finished");
        expect(requestCount(worker)).toBe(2);
    } finally {
        await closeWorker(worker);
    }
}, 60_000);

test("a worker counts both replies before asking at the limit", async () => {
    const worker = await budgetWorker();
    try {
        const client = await openSession(worker, "budget-limit");
        client.send({ type: "prompt", content: "first" });
        await receiveUntil(client, (update) => update.type === "turn_finished");
        await setBudget(worker, "budget-limit", "1.5");
        client.send({ type: "prompt", content: "second" });
        await receiveUntil(client, (update) => update.type === "turn_finished");

        client.send({ type: "prompt", content: "third" });
        const approval = await receiveUntil(
            client,
            (update) => update.type === "ui_request" || update.type === "turn_finished",
        );
        expect(approval.type).toBe("ui_request");
        if (approval.type === "ui_request") {
            expect(approval.request.type).toBe("user_question");
            if (approval.request.type === "user_question") {
                expect(approval.request.question).toContain(
                    "Budget exceeded: $2.00 / $1.50.",
                );
            }
        }
        expect(requestCount(worker)).toBe(2);
    } finally {
        await closeWorker(worker);
    }
}, 60_000);

test("a worker turn continues after the budget is increased", async () => {
    const worker = await budgetWorker();
    try {
        const client = await openSession(worker, "budget-increase");
        client.send({ type: "prompt", content: "first" });
        await receiveUntil(client, (update) => update.type === "turn_finished");
        await setBudget(worker, "budget-increase", "1");
        client.send({ type: "prompt", content: "second" });
        const approval = await receiveUntil(
            client,
            (update) => update.type === "ui_request" || update.type === "turn_finished",
        );
        expect(approval.type).toBe("ui_request");
        if (approval.type !== "ui_request") return;
        client.send({
            type: "ui_response",
            requestId: approval.requestId,
            response: { type: "user_question", outcome: "custom", text: "2" },
        });
        await receiveUntil(client, (update) => update.type === "turn_finished");
        expect(requestCount(worker)).toBe(2);
    } finally {
        await closeWorker(worker);
    }
}, 60_000);

test("a worker turn continues after the budget is ignored", async () => {
    const worker = await budgetWorker();
    try {
        const client = await openSession(worker, "budget-ignore");
        client.send({ type: "prompt", content: "first" });
        await receiveUntil(client, (update) => update.type === "turn_finished");
        await setBudget(worker, "budget-ignore", "1");
        client.send({ type: "prompt", content: "second" });
        const approval = await receiveUntil(
            client,
            (update) => update.type === "ui_request" || update.type === "turn_finished",
        );
        expect(approval.type).toBe("ui_request");
        if (approval.type !== "ui_request") return;
        client.send({
            type: "ui_response",
            requestId: approval.requestId,
            response: {
                type: "user_question",
                outcome: "selected",
                choiceId: "ignore",
            },
        });
        await receiveUntil(client, (update) => update.type === "turn_finished");
        expect(requestCount(worker)).toBe(2);

        client.send({ type: "prompt", content: "third" });
        await receiveUntil(client, (update) => update.type === "turn_finished");
        expect(requestCount(worker)).toBe(3);
    } finally {
        await closeWorker(worker);
    }
}, 60_000);

test("a worker turn stops when the budget question is declined", async () => {
    const worker = await budgetWorker();
    try {
        const client = await openSession(worker, "budget-stop");
        client.send({ type: "prompt", content: "first" });
        await receiveUntil(client, (update) => update.type === "turn_finished");
        await setBudget(worker, "budget-stop", "1");
        client.send({ type: "prompt", content: "second" });
        const approval = await receiveUntil(
            client,
            (update) => update.type === "ui_request" || update.type === "turn_finished",
        );
        expect(approval.type).toBe("ui_request");
        if (approval.type !== "ui_request") return;
        client.send({
            type: "ui_response",
            requestId: approval.requestId,
            response: {
                type: "user_question",
                outcome: "selected",
                choiceId: "stop",
            },
        });
        const stopped = await receiveUntil(
            client,
            (update) => update.type === "notice" || update.type === "turn_finished",
        );
        expect(stopped.type).toBe("notice");
        if (stopped.type === "notice") {
            expect(stopped.text).toBe("Stopped at budget.");
        }
        const finished = await receiveUntil(
            client,
            (update) => update.type === "turn_finished",
        );
        expect(finished.type).toBe("turn_finished");
        if (finished.type === "turn_finished") {
            expect(finished.outcome).toBe("aborted");
        }
        expect(requestCount(worker)).toBe(1);
    } finally {
        await closeWorker(worker);
    }
}, 60_000);

test("control: the same middleware asks on the host path", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-host-budget-"));
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = join(root, "home");
    await mkdir(process.env.VERA_HOME, { recursive: true });
    const extensions = await startExtensionRegistry({
        extensions: [{ path: BUDGET, enabled: true, config: null }],
    });
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([
            assistantText("one", 1),
            assistantText("two", 1),
        ]),
        modelMiddleware: extensions.modelMiddleware(),
        model: "faux/test",
        approvalMode: "full_access",
    });
    try {
        const sessionPath = join(root, "session.jsonl");
        const agent = await registry.create({
            id: "host-budget",
            workspace: root,
            sessionPath,
        });
        const client = agent.attach();
        expect((await client.receive()).type).toBe("history");
        client.send({ type: "prompt", content: "first" });
        await receiveUntil(client, (update) => update.type === "turn_finished");
        await extensions.invokeCommand(
            "budget",
            "1",
            root,
            undefined,
            "host-budget",
            sessionPath,
        );
        client.send({ type: "prompt", content: "second" });
        const approval = await receiveUntil(
            client,
            (update) => update.type === "ui_request" || update.type === "turn_finished",
        );
        expect(approval.type).toBe("ui_request");
    } finally {
        await registry.close();
        await extensions.close();
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        await rm(root, { recursive: true, force: true });
    }
}, 60_000);
