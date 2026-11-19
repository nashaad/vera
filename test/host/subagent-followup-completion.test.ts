import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SubagentFinishedHookPayload } from "../../src/sdk/hooks.ts";
import type { AssistantMessage, ModelAdapter } from "../../src/model/types.ts";
import { emptyUsage } from "../../src/model/types.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { RegisteredTool } from "../../src/tools/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function call(name: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id: "hold-1", name, input: {} }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

interface CompletionNotification {
    readonly deliveryId: string;
    readonly content: string;
}

async function nextNotification(attachment: AgentAttachment): Promise<CompletionNotification> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 2_000);
    try {
        while (true) {
            const update = await attachment.receive(abort.signal);
            if (update.type === "task_notification") return update;
        }
    } catch {
        throw new Error("Timed out waiting for completion notification");
    } finally {
        clearTimeout(timer);
    }
}

async function waitForQueue(attachment: AgentAttachment, contents: readonly string[]): Promise<void> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 2_000);
    try {
        while (true) {
            const update = await attachment.receive(abort.signal);
            if (update.type === "prompt_queue"
                && contents.every((content) => update.queue.prompts.some((prompt) => prompt.content === content))) return;
        }
    } catch {
        throw new Error("Timed out waiting for queued follow-ups");
    } finally {
        clearTimeout(timer);
    }
}

async function nextTurn(attachment: AgentAttachment): Promise<void> {
    const signal = AbortSignal.timeout(2_000);
    while ((await attachment.receive(signal)).type !== "turn_finished") {}
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
        if (predicate()) return;
        await Bun.sleep(5);
    }
    throw new Error("Timed out waiting for completion");
}

test("@core reused background child delivers joined follow-ups once and remains reusable", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-followup-completion-"));
    let enterHold!: () => void;
    const entered = new Promise<void>((resolve) => { enterHold = resolve; });
    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
    const finished: SubagentFinishedHookPayload[] = [];
    const gate: RegisteredTool = {
        definition: { name: "hold_work", description: "Hold work.", inputSchema: { type: "object" } },
        async execute() {
            enterHold();
            await hold;
            return { kind: "output", output: "resumed", isError: false };
        },
    };
    const parentAdapter = new FauxAdapter(Array.from({ length: 12 }, () => response("Noted.")));
    const childAdapter = new FauxAdapter([
        response("First result."),
        response("Second result."),
        response("Third result."),
        call("hold_work"),
        response("Permission requires confirmation."),
        response("Joined result."),
        response("Reused result."),
    ]);
    let adapters = 0;
    const registry = new AgentRegistry({
        createAdapter: () => adapters++ === 0 ? childAdapter : parentAdapter,
        model: "faux/test",
        approvalMode: "auto",
        extensionTools: [gate],
        onSubagentFinished: (payload) => { finished.push(payload); },
    });
    let parentAttachment: AgentAttachment | undefined;
    let childAttachment: AgentAttachment | undefined;
    try {
        const parent = await registry.create({ id: "parent", workspace: root, sessionPath: join(root, "parent.jsonl") });
        const child = await registry.createWithKind(
            { id: "child", workspace: root, sessionPath: join(root, "child.jsonl") },
            "background", { approvalMode: "auto", parentId: parent.id },
        );
        parentAttachment = parent.attach();
        childAttachment = child.attach();
        expect((await parentAttachment.receive()).type).toBe("history");
        expect((await childAttachment.receive()).type).toBe("history");
        const send = async (text: string) => {
            const result = await registry.messageSubagent(registry.agents.get(parent.id)!.store, {
                type: "message_subagent", subagentId: child.id, message: text,
            });
            expect(result.isError).toBe(false);
        };
        for (const [index, text] of ["First result.", "Second result.", "Third result."].entries()) {
            await send(`work ${index + 1}`);
            expect(await nextNotification(parentAttachment)).toMatchObject({
                deliveryId: index === 0 ? "completion:child" : `completion:child:${index + 1}`,
                content: text,
            });
            await waitFor(() => finished.length === index + 1);
        }
        await send("hold this work");
        const approvalTimeout = AbortSignal.timeout(2_000);
        while (true) {
            const update = await parentAttachment.receive(approvalTimeout);
            if (update.type === "ui_request" && update.request.type === "tool_approval") {
                parentAttachment.send({
                    type: "ui_response", requestId: update.requestId,
                    response: { type: "tool_approval", decision: "allow_once" },
                });
                break;
            }
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                entered,
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out waiting for tool")), 2_000); }),
            ]);
        } finally {
            clearTimeout(timer);
        }
        await send("joined work one");
        await send("joined work two");
        await waitForQueue(childAttachment, ["joined work one", "joined work two"]);
        releaseHold();
        expect(await nextNotification(parentAttachment)).toMatchObject({
            deliveryId: "completion:child:4", content: "Joined result.",
        });
        await waitFor(() => finished.length === 4);
        expect(finished.map((event) => event.text)).toEqual([
            "First result.", "Second result.", "Third result.", "Joined result.",
        ]);
        await send("reuse the child");
        expect(await nextNotification(parentAttachment)).toMatchObject({
            deliveryId: "completion:child:5", content: "Reused result.",
        });
        await waitFor(() => finished.length === 5);
        expect(finished[4]).toMatchObject({ subagentId: child.id, outcome: "completed", text: "Reused result." });
        const childStore = await SessionStore.open(join(root, "child.jsonl"));
        const userTexts = childStore.messages().filter((message) => message.role === "user")
            .flatMap((message) => message.content.filter((part) => part.type === "text").map((part) => part.text));
        expect(userTexts).toContain("joined work one");
        expect(userTexts).toContain("joined work two");
        const joined = childStore.messages().filter((message) => message.role === "user" && message.arrivedDuringTurn === true);
        expect(joined).toHaveLength(2);
        const parentRecords = (await readFile(join(root, "parent.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        expect(parentRecords.filter((record) => record.type === "delivery" && String(record.id).startsWith("completion:child"))
            .map((record) => record.id)).toEqual([
                "completion:child", "completion:child:2", "completion:child:3", "completion:child:4", "completion:child:5",
            ]);
    } finally {
        releaseHold();
        childAttachment?.detach();
        parentAttachment?.detach();
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test.each(["parent", "direct"] as const)("@core a failed batch preserves held work until %s recovery", async (recovery) => {
    const root = await mkdtemp(join(tmpdir(), "vera-followup-failure-"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const recovered = new FauxAdapter([response("Map recovered."), response("Assigned result.")]);
    let firstRequest = true;
    let recoveryRequests = 0;
    const failed: ModelAdapter = {
        stream(request) {
            if (!firstRequest) {
                recoveryRequests += 1;
                return recovered.stream(request);
            }
            firstRequest = false;
            const stream = new ModelEventStream();
            entered.resolve();
            void release.promise.then(() => {
                const message: AssistantMessage = {
                    ...response("Map unavailable."), stopReason: "error", errorMessage: "Map unavailable.",
                };
                stream.push({ type: "error", error: new Error("Map unavailable."), message });
            });
            return stream;
        },
    };
    const hooks: SubagentFinishedHookPayload[] = [];
    const parentAdapter = new FauxAdapter(Array.from({ length: 4 }, () => response("Noted.")));
    let adapters = 0;
    const registry = new AgentRegistry({
        createAdapter: () => adapters++ === 0 ? failed : parentAdapter,
        model: "faux/test", approvalMode: "auto",
        onSubagentFinished: (payload) => { hooks.push(payload); },
    });
    let parentAttachment: AgentAttachment | undefined;
    let childAttachment: AgentAttachment | undefined;
    try {
        const parent = await registry.create({ id: "parent", workspace: root, sessionPath: join(root, "parent.jsonl") });
        const child = await registry.createWithKind(
            { id: "child", workspace: root, sessionPath: join(root, "child.jsonl") },
            "background", { approvalMode: "auto", parentId: parent.id },
        );
        parentAttachment = parent.attach();
        childAttachment = child.attach();
        expect((await parentAttachment.receive()).type).toBe("history");
        expect((await childAttachment.receive()).type).toBe("history");
        const send = async (message: string) => expect(await registry.messageSubagent(registry.agents.get(parent.id)!.store, {
            type: "message_subagent", subagentId: child.id, message,
        })).toMatchObject({ isError: false });
        await send("Find the map.");
        await Promise.race([entered.promise, Bun.sleep(2_000).then(() => { throw new Error("Timed out waiting for model"); })]);
        await send("Check the mast too.");
        await waitForQueue(childAttachment, ["Check the mast too."]);
        release.resolve();
        expect(await nextNotification(parentAttachment)).toMatchObject({ deliveryId: "completion:child", content: "Map unavailable." });
        await waitFor(() => hooks.length === 1);
        expect(hooks[0]).toMatchObject({ outcome: "error", text: "Map unavailable." });
        const entry = registry.agents.get(child.id)!;
        await waitFor(() => entry.pendingAsyncTurns === 0 && entry.pendingCompletionDeliveries === 0);
        expect(entry.agent.hasPendingTurn()).toBe(true);
        await nextTurn(childAttachment);
        await Bun.sleep(30);
        expect(recoveryRequests).toBe(0);
        if (recovery === "direct") {
            childAttachment.send({ type: "prompt", content: "Check the crow's sail." });
            await waitForQueue(childAttachment, ["Check the mast too.", "Check the crow's sail."]);
            expect(recoveryRequests).toBe(0);
            childAttachment.send({ type: "release_queued_prompts", mode: "all" });
            await nextTurn(childAttachment);
            expect(recoveryRequests).toBe(1);
            expect(hooks).toHaveLength(1);
            expect(entry.agent.hasPendingTurn()).toBe(false);
        }
        await send("Try the search again.");
        const expected = recovery === "parent" ? "Map recovered." : "Assigned result.";
        expect(await nextNotification(parentAttachment)).toMatchObject({ deliveryId: "completion:child:2", content: expected });
        await waitFor(() => hooks.length === 2);
        expect(hooks[1]).toMatchObject({ outcome: "completed", text: expected });
        await waitFor(() => entry.pendingAsyncTurns === 0 && entry.pendingCompletionDeliveries === 0);
        expect(entry.agent.hasPendingTurn()).toBe(false);
    } finally {
        release.resolve();
        childAttachment?.detach();
        parentAttachment?.detach();
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("@core queued follow-ups spanning turns deliver only the final result", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-followup-turns-"));
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const replies = ["First turn.", "Second turn.", "Final turn."];
    let calls = 0;
    const adapter: ModelAdapter = {
        stream(request) {
            const index = calls++;
            const inner = new FauxAdapter([response(replies[index]!)]);
            if (index >= entered.length) return inner.stream(request);
            const stream = new ModelEventStream();
            entered[index]!.resolve();
            void release[index]!.promise.then(async () => {
                for await (const event of inner.stream(request)) stream.push(event);
            });
            return stream;
        },
    };
    const hooks: SubagentFinishedHookPayload[] = [];
    const parentAdapter = new FauxAdapter([response("Noted.")]);
    let adapters = 0;
    const registry = new AgentRegistry({
        createAdapter: () => adapters++ === 0 ? adapter : parentAdapter,
        model: "faux/test", approvalMode: "auto",
        onSubagentFinished: (payload) => { hooks.push(payload); },
    });
    let parentAttachment: AgentAttachment | undefined;
    let childAttachment: AgentAttachment | undefined;
    try {
        const parent = await registry.create({ id: "parent", workspace: root, sessionPath: join(root, "parent.jsonl") });
        const child = await registry.createWithKind(
            { id: "child", workspace: root, sessionPath: join(root, "child.jsonl") },
            "background", { approvalMode: "auto", parentId: parent.id },
        );
        parentAttachment = parent.attach();
        childAttachment = child.attach();
        expect((await parentAttachment.receive()).type).toBe("history");
        expect((await childAttachment.receive()).type).toBe("history");
        const send = async (message: string) => expect(await registry.messageSubagent(registry.agents.get(parent.id)!.store, {
            type: "message_subagent", subagentId: child.id, message,
        })).toMatchObject({ isError: false });
        await send("First bearing.");
        await Promise.race([entered[0]!.promise, Bun.sleep(2_000).then(() => { throw new Error("First turn did not start"); })]);
        await send("Second bearing.");
        await send("Third bearing.");
        await waitForQueue(childAttachment, ["Second bearing.", "Third bearing."]);
        release[0]!.resolve();
        await Promise.race([entered[1]!.promise, Bun.sleep(2_000).then(() => { throw new Error("Second turn did not start"); })]);
        await expect(readFile(join(root, "parent.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(hooks).toHaveLength(0);
        release[1]!.resolve();
        expect(await nextNotification(parentAttachment)).toMatchObject({ deliveryId: "completion:child", content: "Final turn." });
        const records = (await readFile(join(root, "parent.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        expect(records.filter((record) => record.type === "delivery")).toHaveLength(1);
        await waitFor(() => hooks.length === 1);
        expect(hooks[0]).toMatchObject({ outcome: "completed", text: "Final turn." });
        expect(calls).toBe(3);
        const entry = registry.agents.get(child.id)!;
        await waitFor(() => entry.pendingAsyncTurns === 0 && entry.pendingCompletionDeliveries === 0);
    } finally {
        for (const gate of release) gate.resolve();
        childAttachment?.detach();
        parentAttachment?.detach();
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("@core closing a child suppresses a queued assignment completion and hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-followup-close-"));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const adapter: ModelAdapter = {
        stream() {
            const stream = new ModelEventStream();
            entered.resolve();
            void release.promise.then(() => stream.push({ type: "done", message: response("Closed work.") }));
            return stream;
        },
    };
    const hooks: SubagentFinishedHookPayload[] = [];
    const registry = new AgentRegistry({
        createAdapter: () => adapter, model: "faux/test", approvalMode: "auto",
        onSubagentFinished: (payload) => { hooks.push(payload); },
    });
    let childAttachment: AgentAttachment | undefined;
    try {
        const parent = await registry.create({ id: "parent", workspace: root, sessionPath: join(root, "parent.jsonl") });
        const child = await registry.createWithKind(
            { id: "child", workspace: root, sessionPath: join(root, "child.jsonl") },
            "background", { approvalMode: "auto", parentId: parent.id },
        );
        childAttachment = child.attach();
        expect((await childAttachment.receive()).type).toBe("history");
        const send = async (message: string) => expect(await registry.messageSubagent(registry.agents.get(parent.id)!.store, {
            type: "message_subagent", subagentId: child.id, message,
        })).toMatchObject({ isError: false });
        await send("Find the map.");
        await Promise.race([entered.promise, Bun.sleep(2_000).then(() => { throw new Error("Turn did not start"); })]);
        await send("Check the sail.");
        await waitForQueue(childAttachment, ["Check the sail."]);
        const closing = registry.closeDescendantTree(parent.id, child.id);
        release.resolve();
        expect(await closing).toMatchObject({ status: "closed" });
        await registry.close();
        await expect(readFile(join(root, "parent.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(hooks).toHaveLength(0);
    } finally {
        release.resolve();
        childAttachment?.detach();
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});
