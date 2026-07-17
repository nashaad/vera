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
    type EngineEvent,
} from "../../src/engine/events.ts";
import { createFrameProjector } from "../../src/engine/frames.ts";
import { createInProcessChannel } from "../../src/engine/in-process-channel.ts";
import { InboundFrameRouter } from "../../src/engine/inbound-frame-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

interface LoggedEventLine {
    readonly timestamp: string;
    readonly level: string;
    readonly sessionId: string;
    readonly type: EngineEvent["type"];
    readonly event?: { readonly type: string };
    readonly systemPrompt?: string;
}

test("a turn fans out to frames and a per-session event log", async () => {
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

    events.subscribe(createFrameProjector(channel.engine));
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
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundFrameRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
    };

    try {
        channel.client.send({ type: "prompt", content: "say hello" });
        const turn = runTurn(new FauxAdapter([response]), "test", state);

        expect(await channel.client.receive()).toEqual({
            type: "assistant_delta",
            text: "hello",
            seq: 1,
        });
        expect(await channel.client.receive()).toEqual({
            type: "turn_finished",
            seq: 2,
        });
        expect(await turn).toEqual(response);

        const eventNames = observed.map(eventName);
        expect(eventNames).toEqual([
            "turn_started",
            "model_request",
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
        expect((await stat(logDirectory)).mode & 0o777).toBe(0o700);
        expect((await stat(logPath)).mode & 0o777).toBe(0o600);
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
