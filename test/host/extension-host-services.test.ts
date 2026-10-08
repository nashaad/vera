import { expect, test } from "bun:test";

import type { VeraConfig } from "../../src/config.ts";
import type { AgentRegistry } from "../../src/host/agent-registry.ts";
import { createExtensionHostServices } from "../../src/host/extension-host-services.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelRequest,
} from "../../src/model/types.ts";
import type { ModelEventStream } from "../../src/model/stream.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const config = {
    model_assignments: {
        snappy: {
            models: [
                { name: "parrot", provider: "rookery", model: "parrot-1" },
                { name: "crow", provider: "rookery", model: "crow-mini" },
            ],
        },
    },
} as unknown as VeraConfig;

const unusedRegistry = {} as AgentRegistry;

test("a oneshot answers from the slot's first reachable model", async () => {
    const requests: ModelRequest[] = [];
    const services = createExtensionHostServices({
        registry: unusedRegistry,
        currentConfig: () => config,
        reachability: () => (model) => model.model !== "parrot-1",
        createAdapter: () => recording(
            new FauxAdapter([reply("Raid on the button factory")]),
            requests,
        ),
    });

    const result = await services.oneshot({
        assignment: "snappy",
        systemPrompt: "Name this voyage.",
        messages: [{ role: "user", text: "plot a course for the shiny buttons" }],
        maxTokens: 32,
    }, new AbortController().signal);

    expect(result).toEqual({
        text: "Raid on the button factory",
        model: "crow-mini",
        provider: "rookery",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
        provider: "rookery",
        model: "crow-mini",
        maxTokens: 32,
        systemPrompt: "Name this voyage.",
    });
});

test("a oneshot refuses an empty slot instead of using a session model", async () => {
    let adapters = 0;
    const services = createExtensionHostServices({
        registry: unusedRegistry,
        currentConfig: () => config,
        reachability: () => () => true,
        createAdapter: () => {
            adapters += 1;
            return new FauxAdapter([]);
        },
    });

    await expect(services.oneshot({
        assignment: "extra",
        systemPrompt: "",
        messages: [{ role: "user", text: "caw" }],
    }, new AbortController().signal)).rejects.toThrow(
        "No reachable model is assigned to extra",
    );
    expect(adapters).toBe(0);
});

test("a cancelled oneshot rejects and the next one still answers", async () => {
    const services = createExtensionHostServices({
        registry: unusedRegistry,
        currentConfig: () => config,
        reachability: () => () => true,
        createAdapter: () => new FauxAdapter([reply("Sails trimmed.")], { delayMs: 50 }),
    });
    const message = { role: "user" as const, text: "trim the sails" };

    const controller = new AbortController();
    const pending = services.oneshot(
        { assignment: "snappy", systemPrompt: "", messages: [message] },
        controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow();

    const next = await services.oneshot(
        { assignment: "snappy", systemPrompt: "", messages: [message] },
        new AbortController().signal,
    );
    expect(next.text).toBe("Sails trimmed.");
});

function recording(adapter: FauxAdapter, requests: ModelRequest[]) {
    return {
        stream(request: ModelRequest): ModelEventStream {
            requests.push(request);
            return adapter.stream(request);
        },
    };
}

function reply(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}
