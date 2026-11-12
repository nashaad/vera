import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
    AssistantMessage,
    ModelAdapter,
    ModelRequest,
    ModelStreamEvent,
} from "../../../src/model/types.ts";
import type { VeraExtensionApi, VeraExtensionDisposer } from "../../../src/sdk/extensions.ts";
import type { SessionEndHook, SessionEndHookPayload } from "../../../src/sdk/hooks.ts";
import type { ModelAdapterContext, ModelMiddleware } from "../../../src/sdk/model-middleware.ts";

import { activate } from "./extension.ts";
import type { TelemetryEvent } from "./src/events.ts";

const directories: string[] = [];

async function scratch(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "telemetry-extension-"));
    directories.push(directory);
    return directory;
}

afterEach(async () => {
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

interface Registered {
    middleware?: ModelMiddleware;
    sessionEnd?: SessionEndHook;
    dispose?: VeraExtensionDisposer;
}

function fakeVera(config: unknown, profile: string, withSessionEnd = true) {
    const registered: Registered = {};
    const api = {
        config,
        storage: { profile },
        hooks: {
            registerModelMiddleware(middleware: ModelMiddleware) {
                registered.middleware = middleware;
            },
            ...(withSessionEnd
                ? {
                    registerSessionEnd(hook: SessionEndHook) {
                        registered.sessionEnd = hook;
                    },
                }
                : {}),
        },
        onDispose(dispose: VeraExtensionDisposer) {
            registered.dispose = dispose;
        },
    } as unknown as VeraExtensionApi;
    return { api, registered };
}

const MESSAGE: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "aye" }],
    source: { provider: "rookery", api: "chat", model: "crow-test" },
    usage: {
        inputTokens: 40,
        outputTokens: 4,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 44,
    },
    stopReason: "stop",
};

const REQUEST: ModelRequest = {
    model: "crow-test",
    systemPrompt: "plot a course",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

function adapter(): ModelAdapter {
    const event: ModelStreamEvent = { type: "done", message: MESSAGE };
    return {
        stream() {
            let sent = false;
            return {
                [Symbol.asyncIterator](): AsyncIterator<ModelStreamEvent> {
                    return {
                        async next(): Promise<IteratorResult<ModelStreamEvent>> {
                            if (sent) return { value: undefined, done: true };
                            sent = true;
                            return { value: event, done: false };
                        },
                    };
                },
                async result() {
                    return MESSAGE;
                },
            };
        },
    };
}

const CONTEXT: ModelAdapterContext = {
    sessionId: "session-1",
    sessionPath: "/workspace/session-1.jsonl",
    workspace: "/workspace",
    provider: "rookery",
    purpose: "turn",
};

const SESSION_ENDED: SessionEndHookPayload = {
    type: "session_end",
    sessionId: "session-1",
    workspace: "/workspace",
    reason: "closed",
    turns: 1,
    spawned: false,
};

async function runCall(middleware: ModelMiddleware): Promise<void> {
    const stream = middleware(adapter(), CONTEXT).stream(REQUEST);
    for await (const _event of stream) {
        // Drain so the terminal event is observed.
    }
}

function lines(text: string): TelemetryEvent[] {
    return text.trim().split("\n").map((line) => JSON.parse(line) as TelemetryEvent);
}

describe("activate", () => {
    test("does nothing without a sink", async () => {
        const profile = await scratch();
        const { api, registered } = fakeVera({}, profile);
        activate(api);
        expect(registered.middleware).toBeUndefined();
        expect(registered.sessionEnd).toBeUndefined();
        await expect(readFile(join(profile, "install-id"), "utf8")).rejects.toThrow();
    });

    test("fails activation on invalid config", async () => {
        const profile = await scratch();
        const { api } = fakeVera({ sink: { type: "axiom" } }, profile);
        expect(() => activate(api)).toThrow(/^telemetry: sink\.dataset/);
    });

    test("writes model calls and session ends to the profile when the sink is jsonl", async () => {
        const profile = await scratch();
        const { api, registered } = fakeVera(
            { sink: { type: "jsonl" }, flush_seconds: 3_600, developer: "blackfeather" },
            profile,
        );
        activate(api);
        expect(registered.middleware).toBeDefined();
        expect(registered.sessionEnd).toBeDefined();

        await runCall(registered.middleware!);
        registered.sessionEnd!(SESSION_ENDED);
        await registered.dispose!();

        const installId = (await readFile(join(profile, "install-id"), "utf8")).trim();
        const written = lines(await readFile(join(profile, "events.jsonl"), "utf8"));
        expect(written.map((event) => event.event)).toEqual(["model_call", "session_end"]);
        expect(written[0]).toMatchObject({
            install_id: installId,
            developer: "blackfeather",
            session_id: "session-1",
            input_tokens: 40,
            output_tokens: 4,
            stop_reason: "stop",
        });
        expect(written[1]).toMatchObject({ event: "session_end", reason: "closed", provider: "rookery" });
    });

    test("keeps working on a host that cannot report session ends", async () => {
        const profile = await scratch();
        const { api, registered } = fakeVera({ sink: { type: "jsonl" } }, profile, false);
        activate(api);
        expect(registered.middleware).toBeDefined();
        await registered.dispose!();
    });

    test("a second activation reuses the same install id", async () => {
        const profile = await scratch();
        const first = fakeVera({ sink: { type: "jsonl" } }, profile);
        activate(first.api);
        const id = (await readFile(join(profile, "install-id"), "utf8")).trim();
        await first.registered.dispose!();

        const second = fakeVera({ sink: { type: "jsonl" } }, profile);
        activate(second.api);
        await second.registered.dispose!();
        expect((await readFile(join(profile, "install-id"), "utf8")).trim()).toBe(id);
    });
});
