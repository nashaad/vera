import { expect, test } from "bun:test";

import { defineAgent } from "../../src/agents/definition.ts";
import type { VeraConfig } from "../../src/config.ts";
import { Vera, type FunctionTool } from "../../src/sdk/agent.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
    type ToolResultMessage,
} from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const lookout = defineAgent({
    name: "lookout",
    instructions: "Count what the crew asks about.",
    tools: [],
});

function parrotCount(calls: Readonly<Record<string, unknown>>[]): FunctionTool {
    return {
        name: "parrot_count",
        description: "Count the parrots on one deck.",
        parameters: {
            type: "object",
            properties: { deck: { type: "string" } },
            required: ["deck"],
        },
        run(args) {
            calls.push(args);
            return `${String(args.deck)}: 3 parrots`;
        },
    };
}

for (const posture of ["ask", "auto", "readonly"] as const) {
    test(`the model calls a bound function under ${posture}`, async () => {
        const requests: ModelRequest[] = [];
        const calls: Readonly<Record<string, unknown>>[] = [];
        const vera = await scriptedVera(
            [toolCall("parrot_count", { deck: "poop" }), answer("Three parrots.")],
            requests,
            posture,
        );

        const result = await vera
            .agent(lookout, { functions: [parrotCount(calls)] })
            .run("How many parrots on the poop deck?");

        expect(result.outcome).toBe("completed");
        expect(result.text).toBe("Three parrots.");
        expect(calls).toEqual([{ deck: "poop" }]);
        expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(["parrot_count"]);
        expect(toolResult(requests[1])).toEqual({
            text: "poop: 3 parrots",
            isError: false,
        });
        await vera.close();
    });
}

test("an agent that names built-in tools is offered its functions too", async () => {
    const requests: ModelRequest[] = [];
    const vera = await scriptedVera([answer("Aye.")], requests, "readonly");

    await vera.agent(
        defineAgent({ ...lookout, tools: ["read"] }),
        { functions: [parrotCount([])] },
    ).run("Count them.");

    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual([
        "read",
        "parrot_count",
    ]);
    await vera.close();
});

test("a function that throws gives the model its error text", async () => {
    const requests: ModelRequest[] = [];
    const vera = await scriptedVera(
        [toolCall("parrot_count", { deck: "bilge" }), answer("No parrots.")],
        requests,
        "ask",
    );
    const sunk: FunctionTool = {
        ...parrotCount([]),
        run() {
            throw new Error("the bilge is flooded");
        },
    };

    const result = await vera.agent(lookout, { functions: [sunk] }).run("Count them.");

    expect(result.outcome).toBe("completed");
    expect(toolResult(requests[1])).toEqual({
        text: "the bilge is flooded",
        isError: true,
    });
    await vera.close();
});

test("a bad function is refused when the agent is bound", async () => {
    const vera = await scriptedVera([], [], "ask");
    const counter = parrotCount([]);

    expect(() => vera.agent(lookout, { functions: [{ ...counter, name: "read" }] }))
        .toThrow("Function read collides with a built-in tool");
    expect(() => vera.agent(lookout, { functions: [counter, counter] }))
        .toThrow("Duplicate function: parrot_count");
    expect(() => vera.agent(lookout, { functions: [{ ...counter, name: "Count" }] }))
        .toThrow("must be lowercase snake_case");
    expect(() => vera.agent(lookout, {
        functions: [{ ...counter, parameters: { type: "string" } }],
    })).toThrow('parameters must be a JSON Schema with type "object"');
    await vera.close();
});

function toolResult(
    request: ModelRequest | undefined,
): { readonly text: string; readonly isError: boolean } | undefined {
    const message = request?.messages.find(
        (entry): entry is ToolResultMessage => entry.role === "tool_result",
    );
    if (message === undefined) return undefined;
    return {
        text: message.content.map((part) => part.text).join(""),
        isError: message.isError,
    };
}

function scriptedVera(
    responses: readonly AssistantMessage[],
    requests: ModelRequest[],
    posture: string,
): Promise<Vera> {
    const scripted = new FauxAdapter(responses, { chunkSize: 3 });
    return Vera.create({
        config: baseConfig(),
        posture,
        createAdapter: () => capture(scripted, requests),
    });
}

function capture(adapter: ModelAdapter, requests: ModelRequest[]): ModelAdapter {
    return {
        stream(request) {
            requests.push(request);
            return adapter.stream(request);
        },
    };
}

function baseConfig(): VeraConfig {
    return {
        schema_version: 1,
        provider: "faux",
        model: "reviewer",
        reasoning_effort: "high",
        approval_mode: "ask",
    };
}

function answer(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "test", model: "reviewer" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function toolCall(
    name: string,
    input: Readonly<Record<string, unknown>>,
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id: `call-${name}`, name, input }],
        source: { provider: "faux", api: "test", model: "reviewer" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}
