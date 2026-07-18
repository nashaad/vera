import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSubagent } from "../../src/engine/subagent.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

test("subagent uses fresh context, ordinary tools, and a durable session", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-"));
    const sessionPath = join(root, "child.jsonl");
    const response: AssistantMessage = {
        role: "assistant",
        content: [
            { type: "thinking", text: "private working" },
            { type: "text", text: "The request enters through the socket." },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([response]);
    let request: ModelRequest | undefined;
    const adapter: ModelAdapter = {
        stream(nextRequest) {
            request = nextRequest;
            return faux.stream(nextRequest);
        },
    };

    try {
        const result = await runSubagent({
            adapter,
            model: "test",
            description: "Trace the request path",
            workspace: root,
            approvalMode: "approve_for_me",
            sessionId: "child-1",
            sessionPath,
        });

        expect(result).toEqual({
            text: "The request enters through the socket.",
            sessionId: "child-1",
            sessionPath,
        });
        expect(request?.messages).toEqual([{
            role: "user",
            content: [{ type: "text", text: "Trace the request path" }],
        }]);
        expect(request?.tools?.map((tool) => tool.name)).not.toContain(
            "subagent",
        );
        expect((await SessionStore.open(sessionPath)).messages()).toEqual([
            {
                role: "user",
                content: [{ type: "text", text: "Trace the request path" }],
            },
            response,
        ]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("aborting the parent signal cancels the child turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-subagent-"));
    const sessionPath = join(root, "aborted-child.jsonl");
    const controller = new AbortController();
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "this should not finish" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([response], { chunkSize: 1, delayMs: 20 });
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    const adapter: ModelAdapter = {
        stream(request) {
            markStarted?.();
            return faux.stream(request);
        },
    };

    try {
        const child = runSubagent({
            adapter,
            model: "test",
            description: "Work until cancelled",
            workspace: root,
            approvalMode: "approve_for_me",
            sessionId: "child-abort",
            sessionPath,
            signal: controller.signal,
        });
        await started;
        controller.abort(new Error("Parent turn aborted"));

        await expect(child).rejects.toThrow("Parent turn aborted");
        const messages = (await SessionStore.open(sessionPath)).messages();
        expect(messages.at(-1)).toMatchObject({
            role: "assistant",
            stopReason: "aborted",
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
