import { expect, test } from "bun:test";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTurn, type RunTurnState, type TurnHaltCheck } from "../../src/engine/run-turn.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
    type ToolResultMessage,
} from "../../src/model/types.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";

const source = { provider: "faux", api: "scripted", model: "test" };

function reply(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source,
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function readCalls(ids: readonly string[]): AssistantMessage {
    return {
        role: "assistant",
        content: ids.map((id) => ({
            type: "tool_call" as const,
            id,
            name: "read",
            input: { path: `${id}.txt` },
        })),
        source,
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

async function setup(
    responses: readonly AssistantMessage[],
    haltCheck: TurnHaltCheck | undefined,
) {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), "vera-halt-")));
    for (const name of ["a", "b", "c"]) {
        await writeFile(join(workspace, `${name}.txt`), `contents of ${name}`);
    }
    const faux = new FauxAdapter(responses);
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            return faux.stream(request);
        },
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
        approvalMode: "full_access",
        ...(haltCheck === undefined ? {} : { haltCheck }),
    };
    channel.client.send({ type: "prompt", content: "read the files" });
    return { adapter, requests, state };
}

function toolResults(messages: readonly { role: string }[]): ToolResultMessage[] {
    return messages.filter((message): message is ToolResultMessage =>
        message.role === "tool_result"
    );
}

test("halt before the first model request ends the turn without calling the model", async () => {
    const { adapter, requests, state } = await setup([reply("unused")], () => "session blocked");

    const message = await runTurn(adapter, "test", state);

    expect(requests).toHaveLength(0);
    expect(message.stopReason).toBe("aborted");
    expect(message.errorMessage).toBe("session blocked");
    expect(message.content).toEqual([]);
});

test("halt between tool calls skips the remaining calls and keeps results paired", async () => {
    let checks = 0;
    // Check order: model request, tool a, tool b, tool c. Halt from the third check.
    const { adapter, requests, state } = await setup(
        [readCalls(["a", "b", "c"]), reply("unused")],
        () => {
            checks += 1;
            return checks >= 3 ? "session blocked" : undefined;
        },
    );

    const message = await runTurn(adapter, "test", state);

    expect(requests).toHaveLength(1);
    expect(message.stopReason).toBe("aborted");
    expect(message.errorMessage).toBe("session blocked");
    const results = toolResults(state.messages);
    expect(results.map((result) => result.toolCallId)).toEqual(["a", "b", "c"]);
    expect(results[0]!.isError).toBeFalsy();
    expect(results[1]!.content).toEqual([{ type: "text", text: "Not run: session blocked" }]);
    expect(results[2]!.content).toEqual([{ type: "text", text: "Not run: session blocked" }]);
});

test("a check that turns true after a tool finishes stops before the next model request", async () => {
    let checks = 0;
    // Check order: model request, tool a, after the tool batch. Halt from the third check.
    const { adapter, requests, state } = await setup(
        [readCalls(["a"]), reply("unused")],
        () => {
            checks += 1;
            return checks >= 3 ? "session blocked" : undefined;
        },
    );

    const message = await runTurn(adapter, "test", state);

    expect(requests).toHaveLength(1);
    expect(message.stopReason).toBe("aborted");
    const results = toolResults(state.messages);
    expect(results).toHaveLength(1);
    expect(results[0]!.isError).toBeFalsy();
});

test("without a halt check the turn runs unchanged", async () => {
    const { adapter, requests, state } = await setup(
        [readCalls(["a", "b"]), reply("done")],
        undefined,
    );

    const message = await runTurn(adapter, "test", state);

    expect(requests).toHaveLength(2);
    expect(message).toMatchObject({ stopReason: "stop" });
    expect(message.errorMessage).toBeUndefined();
    const results = toolResults(state.messages);
    expect(results.every((result) => result.isError !== true)).toBe(true);
});
