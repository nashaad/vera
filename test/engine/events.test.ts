import { expect, test } from "bun:test";
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    EngineEventBus,
    createJsonlEventLogger,
    defaultEventLogPath,
    type EngineEvent,
} from "../../src/engine/events.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import type { PromptContributionMetadata } from "../../src/engine/prompt-contributions.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";

interface LoggedEventLine {
    readonly timestamp: string;
    readonly level: string;
    readonly sessionId: string;
    readonly type: EngineEvent["type"];
    readonly event?: { readonly type: string };
    readonly systemPrompt?: string;
    readonly promptContributions?: readonly PromptContributionMetadata[];
}

test("a turn fans out to updates and a per-session event log", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-events-"));
    const logDirectory = join(workspace, "logs");
    const logPath = join(logDirectory, "session-test.jsonl");
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const observed: EngineEvent[] = [];

    await mkdir(logDirectory, { mode: 0o777 });
    await chmod(logDirectory, 0o777);
    await writeFile(logPath, "", { mode: 0o666 });
    await chmod(logPath, 0o666);

    events.subscribe(createProtocolEncoder(channel.engine));
    events.subscribe(() => {
        throw new Error("broken observer");
    });
    events.subscribe(createJsonlEventLogger({
        path: logPath,
        sessionId: "session-test",
        now: () => new Date("2026-07-17T12:00:00.000Z"),
    }));
    events.subscribe((event) => {
        observed.push(event);
    });

    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
    };

    try {
        channel.client.send({ type: "prompt", content: "say hello" });
        const turn = runTurn(new FauxAdapter([response]), "test", state);

        expect(await channel.client.receive()).toEqual({
            type: "user_prompt",
            content: "say hello",
            seq: 1,
        });
        // The request is measured as it is built, so the size lands before the
        // first token rather than after the answer. The exact count tracks the
        // system prompt and is not worth pinning here.
        const measured = await channel.client.receive();
        expect(measured.type).toBe("context");
        if (measured.type !== "context") throw new Error("expected a measurement");
        expect(measured.measurement.estimated).toBe(true);
        expect(measured.measurement.tokens).toBeGreaterThan(0);
        expect(measured.seq).toBe(2);

        expect(await channel.client.receive()).toEqual({
            type: "assistant_delta",
            text: "hello",
            seq: 3,
        });
        expect(await channel.client.receive()).toEqual({
            type: "turn_finished",
            seq: 4,
        });
        expect(await turn).toEqual(response);

        const eventNames = observed.map(eventName);
        expect(eventNames).toEqual([
            "turn_started",
            "model_request",
            "context_measured",
            "model_stream:start",
            "model_stream:text_start",
            "model_stream:text_delta",
            "model_stream:text_end",
            "model_stream:done",
            "turn_finished",
        ]);

        const lines = (await readFile(logPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as LoggedEventLine);
        expect(lines.map(loggedEventName)).toEqual(eventNames);
        expect(lines.every((line) =>
            line.timestamp === "2026-07-17T12:00:00.000Z"
            && line.sessionId === "session-test"
            && line.level === "debug"
        )).toBe(true);
        const requestLine = lines.find((line) => line.type === "model_request");
        expect(requestLine?.systemPrompt).toContain("## Identity\n");
        expect(requestLine?.systemPrompt).toContain(
            `## Workspace\nWorking directory: ${workspace}`,
        );
        expect(requestLine?.promptContributions).toEqual([
            expect.objectContaining({
                id: "core.identity",
                target: "stable",
                order: 0,
            }),
            expect.objectContaining({
                id: "core.tools",
                target: "stable",
                order: 1,
            }),
            expect.objectContaining({
                id: "core.workspace",
                target: "stable",
                order: 2,
            }),
            expect.objectContaining({
                id: "core.date",
                target: "contextual",
                order: 3,
            }),
        ]);
        expect((await stat(logDirectory)).mode & 0o777).toBe(0o700);
        expect((await stat(logPath)).mode & 0o777).toBe(0o600);
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("a turn given no event log path writes no log at all", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-events-"));
    const sessionId = `unrouted-${process.pid}-${workspace.slice(-6)}`;
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
    };

    try {
        channel.client.send({ type: "prompt", content: "say hello" });
        await runTurn(new FauxAdapter([response]), sessionId, state);

        await expect(stat(defaultEventLogPath(sessionId))).rejects.toThrow();
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("prompt prefix drift is logged as a warning", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-events-"));
    const logPath = join(workspace, "events.jsonl");
    try {
        const events = new EngineEventBus();
        events.subscribe(createJsonlEventLogger({
            path: logPath,
            sessionId: "session-test",
        }));
        events.emit({
            type: "prompt_prefix_drift",
            cause: "unexplained",
            changes: [{
                id: "core.tools",
                owner: "core",
                kind: "content_changed",
                previousOrder: 1,
                currentOrder: 1,
            }],
        });

        expect(JSON.parse(await readFile(logPath, "utf8"))).toEqual(
            expect.objectContaining({
                level: "warn",
                type: "prompt_prefix_drift",
                cause: "unexplained",
            }),
        );
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("provider failures keep their structured diagnostics in the event log", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-events-"));
    const logPath = join(workspace, "events.jsonl");
    try {
        const events = new EngineEventBus();
        events.subscribe(createJsonlEventLogger({
            path: logPath,
            sessionId: "session-test",
        }));
        events.emit({
            type: "model_stream_error",
            error: "Provider returned error",
            errorName: "ProviderFailureError",
            stack: "ProviderFailureError: Provider returned error",
            cause: {
                name: "Error",
                message: "Provider returned error (provider_unavailable)",
            },
            failure: {
                kind: "server",
                resolution: "retry",
                message: "Provider returned error (provider_unavailable)",
                statusCode: 503,
                providerErrorType: "provider_unavailable",
                providerCode: "overloaded_error",
                providerName: "Anthropic",
                providerMessage: "Service is temporarily overloaded",
            },
            message: {
                role: "assistant",
                content: [],
                source: {
                    provider: "openrouter",
                    api: "openrouter-chat",
                    model: "anthropic/claude-sonnet-5",
                },
                usage: emptyUsage(),
                stopReason: "error",
                errorMessage: "Provider returned error",
            },
        });

        expect(JSON.parse(await readFile(logPath, "utf8"))).toEqual(
            expect.objectContaining({
                level: "error",
                errorName: "ProviderFailureError",
                cause: expect.objectContaining({
                    message: "Provider returned error (provider_unavailable)",
                }),
                failure: expect.objectContaining({
                    statusCode: 503,
                    providerErrorType: "provider_unavailable",
                    providerCode: "overloaded_error",
                    providerName: "Anthropic",
                    providerMessage: "Service is temporarily overloaded",
                }),
            }),
        );
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

function eventName(event: EngineEvent): string {
    return event.type === "model_stream"
        ? `${event.type}:${event.event.type}`
        : event.type;
}

function loggedEventName(event: LoggedEventLine): string {
    return event.type === "model_stream"
        ? `${event.type}:${event.event?.type}`
        : event.type;
}
