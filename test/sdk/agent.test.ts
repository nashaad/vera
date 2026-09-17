import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineAgent, type AgentDefinition } from "../../src/agents/definition.ts";
import {
    updateVeraConfigDefaults,
    type VeraConfig,
} from "../../src/config.ts";
import { veraProfileDirectory } from "../../src/profile-paths.ts";
import {
    Vera,
    type AgentOutputSchema,
} from "../../src/sdk/agent.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

test("A1 an SDK agent runs from a module-level definition", async () => {
    const requests: ModelRequest[] = [];
    const vera = await scriptedVera([answer("bounded answer")], requests);
    const definition = defineAgent({
        name: "review-correctness",
        instructions: "Inspect control flow and report concrete defects.",
        tools: [],
    });

    const result = await vera.agent(definition).run("Review this patch");

    expect(result).toMatchObject({
        outcome: "completed",
        text: "bounded answer",
        model: { provider: "faux", model: "reviewer" },
        substitutions: [],
    });
    expect(requests[0]?.systemPrompt).toContain(definition.instructions);
    expect(requests[0]?.tools).toEqual([]);
});

test("A2 a definition name resolves through the catalog", async () => {
    const workspace = temporaryWorkspace("vera-sdk-catalog-");
    const directory = join(workspace, ".vera", "agents");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "review-correctness.md"),
        "Instructions loaded from the project catalog.\n",
    );
    const requests: ModelRequest[] = [];

    try {
        const vera = await scriptedVera([answer("catalog run")], requests, {
            workspace,
        });
        await vera.agent("review-correctness").run("Review this patch");

        expect(requests[0]?.systemPrompt).toContain(
            "Instructions loaded from the project catalog.",
        );
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("A3 an invalid definition is refused where it is defined", () => {
    expect(() => defineAgent({
        name: "Review_Bad",
        instructions: "review",
    })).toThrow("must be lowercase letters");
    expect(() => defineAgent({
        name: "review-empty",
        instructions: "   ",
    })).toThrow("instructions must not be empty");
});

test("A4 defaultPair selects the model and effort", async () => {
    const workspace = temporaryWorkspace("vera-sdk-pair-");
    const directory = join(workspace, ".vera");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "pool.json"), JSON.stringify({
        defaults: {},
        models: {
            "pair-provider/pair-model": {
                added: true,
                name: "luna",
            },
        },
    }));
    const selected: VeraConfig[] = [];
    const requests: ModelRequest[] = [];
    const vera = await Vera.create({
        config: baseConfig(),
        workspace,
        createAdapter(config) {
            selected.push(config);
            const scripted = new FauxAdapter([
                answer("selected", config.provider, config.model),
            ]);
            return capture(scripted, requests);
        },
    });
    const definition = defineAgent({
        name: "review-pair",
        instructions: "Review with the role default.",
        tools: [],
        defaultPair: { name: "luna", effort: "high" },
    });

    try {
        await vera.agent(definition).run("review");
        await vera.agent(definition, {
            provider: "override-provider",
            model: "override-model",
            reasoningEffort: "low",
        }).run("review again");

        expect(selected[0]).toMatchObject({
            provider: "pair-provider",
            model: "pair-model",
        });
        expect(requests[0]).toMatchObject({
            model: "pair-model",
            reasoningEffort: "high",
        });
        expect(selected[1]).toMatchObject({
            provider: "override-provider",
            model: "override-model",
        });
        expect(requests[1]).toMatchObject({
            model: "override-model",
            reasoningEffort: "low",
        });
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("an SDK config snapshot applies exact-model request options", async () => {
    const requests: ModelRequest[] = [];
    const vera = await scriptedVera([answer("configured", "openrouter", "test/model")], requests, {
        config: {
            ...baseConfig(),
            provider: "openrouter",
            model: "test/model",
            model_request_options: {
                "openrouter/test/model": {
                    body: { provider: { only: ["z-ai"] } },
                },
            },
        },
    });

    await vera.agent(basicDefinition()).run("review");

    expect(requests[0]?.bodyExtensions).toEqual({
        provider: { only: ["z-ai"] },
    });
});

test("an SDK instance reads later request options from its home", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-sdk-home-"));
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    const path = join(home, "config.json");
    mkdirSync(home, { recursive: true });
    writeFileSync(path, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "test/model",
        approval_mode: "readonly",
        model_request_options: {
            "openrouter/test/model": {
                body: { provider: { only: ["first"] } },
            },
        },
    }));
    const requests: ModelRequest[] = [];
    const scripted = new FauxAdapter([
        answer("first", "openrouter", "test/model"),
        answer("second", "openrouter", "test/model"),
    ]);
    try {
        const vera = await Vera.create({
            createAdapter: () => capture(scripted, requests),
        });
        await vera.agent(basicDefinition()).run("first");
        updateVeraConfigDefaults({
            model_request_options: {
                model: "openrouter/test/model",
                body: { provider: { only: ["second-longer"] } },
            },
        }, { path });
        await vera.agent(basicDefinition()).run("second");

        expect(requests.map((request) => request.bodyExtensions)).toEqual([
            { provider: { only: ["first"] } },
            { provider: { only: ["second-longer"] } },
        ]);
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
    }
});

test("B1 an SDK agent does not run at full access", async () => {
    const workspace = temporaryWorkspace("vera-sdk-posture-");
    const requests: ModelRequest[] = [];
    const blockedPath = join(workspace, "blocked.txt");
    const vera = await scriptedVera([
        toolCall("write", { path: blockedPath, content: "no" }),
        answer("write was refused"),
    ], requests, {
        workspace,
        config: { ...baseConfig(), approval_mode: "full_access" },
        posture: "full_access",
    });
    const definition = defineAgent({
        name: "review-readonly",
        instructions: "Inspect without changing files.",
        tools: ["write"],
        posture: "readonly",
    });

    try {
        const result = await vera.agent(definition).run("try the write");

        expect(existsSync(blockedPath)).toBe(false);
        expect(JSON.stringify(requests[1]?.messages)).toContain(
            "Permission mode readonly requires deny",
        );
        expect(result).toMatchObject({
            outcome: "completed",
            text: "write was refused",
        });
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("B2 a definition cannot widen the runtime posture", async () => {
    const vera = await Vera.create({
        config: { ...baseConfig(), approval_mode: "readonly" },
        posture: "readonly",
    });
    const definition = defineAgent({
        name: "review-wide",
        instructions: "Review with broad access.",
        tools: [],
        posture: "full_access",
    });

    expect(() => vera.agent(definition)).toThrow("would widen runtime posture");
});

test("B3 tools are offered from the definition list", async () => {
    const requests: ModelRequest[] = [];
    const vera = await scriptedVera([answer("done")], requests);
    const definition = defineAgent({
        name: "review-reader",
        instructions: "Read relevant source.",
        tools: ["read"],
        posture: "readonly",
    });

    await vera.agent(definition).run("review");

    const names = requests[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("read");
    expect(names).not.toContain("write");
    expect(names).not.toContain("subagent");
});

test("B4 a reviewer cannot delegate", async () => {
    const requests: ModelRequest[] = [];
    const vera = await scriptedVera([
        toolCall("subagent", { description: "delegate" }),
        answer("delegation refused"),
    ], requests);
    const definition = defineAgent({
        name: "review-leaf",
        instructions: "Review the supplied change.",
        tools: ["read"],
        posture: "readonly",
    });

    const result = await vera.agent(definition).run("review");

    const offered = requests[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(offered).not.toContain("subagent");
    expect(JSON.stringify(requests[1]?.messages)).toContain(
        "does not offer the subagent tool",
    );
    expect(result.text).toBe("delegation refused");
});

test("B5 one posture decision covers the fan", async () => {
    const workspace = temporaryWorkspace("vera-sdk-fan-posture-");
    let adapters = 0;
    const vera = await Vera.create({
        config: { ...baseConfig(), approval_mode: "readonly" },
        workspace,
        posture: "readonly",
        createAdapter() {
            adapters += 1;
            return new FauxAdapter([
                toolCall("write", {
                    path: join(workspace, `blocked-${adapters}.txt`),
                    content: "no",
                }),
                answer(`refused ${adapters}`),
            ]);
        },
    });
    const definitions = ["one", "two", "three", "four"].map((name) =>
        defineAgent({
            name: `review-${name}`,
            instructions: `Review lens ${name}.`,
            tools: ["write"],
        })
    );

    try {
        const results = await Promise.all(
            definitions.map((definition) => vera.agent(definition).run("review")),
        );

        expect(results.map((result) => result.outcome)).toEqual([
            "completed",
            "completed",
            "completed",
            "completed",
        ]);
        for (let index = 1; index <= 4; index += 1) {
            expect(existsSync(join(workspace, `blocked-${index}.txt`))).toBe(false);
        }
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("C1 a run with an output schema returns typed output", async () => {
    const vera = await scriptedVera([
        toolCallWithText(
            "I will inspect the file before returning the result.",
            "read",
            { path: "package.json" },
        ),
        answer(
            'There is one supported finding.\n'
                + '{"findings":[{"summary":"broken branch"}]}',
        ),
    ]);
    const schema = findingsSchema();
    const definition = defineAgent({
        name: "review-structured",
        instructions: "Inspect the file and return structured findings.",
        tools: ["read"],
        posture: "readonly",
    });

    const result = await vera.agent(definition).run("review", {
        output: schema,
    });

    expect(result).toMatchObject({
        outcome: "completed",
        output: { findings: [{ summary: "broken branch" }] },
    });
    expect(result.text).toContain("I will inspect the file");
    expect(result.text).toContain("There is one supported finding.");
    expect(result.text).toContain('{"findings":[{"summary":"broken branch"}]}');
});

test("C2 a response that violates the schema fails loudly", async () => {
    const vera = await scriptedVera([
        answer("not json"),
        answer('{"findings":[{}]}'),
    ]);
    const bound = vera.agent(basicDefinition());
    const prose = await bound.run("review prose", { output: findingsSchema() });
    const partial = await bound.run("review partial", { output: findingsSchema() });

    for (const result of [prose, partial]) {
        expect(result.outcome).toBe("failed");
        expect(result.error).toMatchObject({ kind: "schema" });
        expect(result.error?.message.length).toBeGreaterThan(0);
        expect("output" in result).toBe(false);
        expect(result.output).toBeUndefined();
    }
});

test("C3 a run without a schema is unchanged", async () => {
    const vera = await scriptedVera([answer("plain text")]);

    const result = await vera.agent(basicDefinition()).run("review");

    expect(result).toMatchObject({ outcome: "completed", text: "plain text" });
    expect("output" in result).toBe(false);
});

test("Agent.run rejects an empty prompt before constructing an adapter", async () => {
    let adapters = 0;
    const vera = await Vera.create({
        config: baseConfig(),
        createAdapter() {
            adapters += 1;
            throw new Error("must not run");
        },
    });

    await expect(vera.agent(basicDefinition()).run("  ")).rejects.toThrow(
        "Agent prompt must not be empty",
    );
    expect(adapters).toBe(0);
});

test("Agent.run returns failed when its bounded loop cannot complete", async () => {
    const adapter: ModelAdapter = {
        stream() {
            const stream = new ModelEventStream();
            const error = new Error("provider unavailable");
            queueMicrotask(() => {
                stream.push({ type: "start" });
                stream.push({
                    type: "error",
                    error,
                    message: {
                        role: "assistant",
                        content: [],
                        source: {
                            provider: "faux",
                            api: "test",
                            model: "reviewer",
                        },
                        usage: emptyUsage(),
                        stopReason: "error",
                        errorMessage: error.message,
                    },
                });
            });
            return stream;
        },
    };
    const vera = await Vera.create({
        config: baseConfig(),
        createAdapter: () => adapter,
    });

    const result = await vera.agent(basicDefinition()).run("review");

    expect(result.outcome).toBe("failed");
    expect(result.error?.message).toContain("provider unavailable");
});

test("Agent.run turns AbortSignal cancellation into an aborted result", async () => {
    const response = answer("too late");
    const vera = await Vera.create({
        config: baseConfig(),
        createAdapter: () => new FauxAdapter([response], { delayMs: 100 }),
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await vera.agent(basicDefinition()).run("review", {
        signal: controller.signal,
    });

    expect(result.outcome).toBe("aborted");
    expect(result.error?.kind).toBe("aborted");
});

test("Agent.run prepareTurn can restrict tools before the model request", async () => {
    const requests: ModelRequest[] = [];
    const vera = await scriptedVera([answer("read only")], requests);
    const definition = defineAgent({
        name: "review-reader",
        instructions: "Read relevant source.",
        tools: ["read", "write"],
        posture: "readonly",
    });
    let seenTools: string[] | undefined;

    const result = await vera.agent(definition).run("review", {
        prepareTurn(payload) {
            seenTools = [...payload.tools];
            return { power: "mutate", tools: ["read"] };
        },
    });

    expect(seenTools).toContain("read");
    expect(seenTools).toContain("write");
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(["read"]);
    expect(result.outcome).toBe("completed");
    expect(result.text).toBe("read only");
});

test("Agent.run prepareTurn can block a turn before any model call", async () => {
    let adapters = 0;
    const vera = await Vera.create({
        config: baseConfig(),
        createAdapter() {
            adapters += 1;
            return new FauxAdapter([]);
        },
    });

    const result = await vera.agent(basicDefinition()).run("review", {
        prepareTurn: () => ({ power: "block", reason: "policy" }),
    });

    expect(adapters).toBe(1);
    expect(result).toMatchObject({
        outcome: "failed",
        error: {
            kind: "model",
            message: "pre_turn hook blocked this turn: policy",
        },
    });
});

test("Vera.run completes a bounded turn without a host socket", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-run-home-"));
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    mkdirSync(join(home, "machine"), { recursive: true });
    writeFileSync(join(home, "config.json"), `${JSON.stringify({
        schema_version: 1,
        provider: "faux",
        model: "reviewer",
        approval_mode: "readonly",
    })}\n`);
    const requests: ModelRequest[] = [];
    try {
        const result = await Vera.run({
            prompt: "Review this patch",
            agent: defineAgent({
                name: "review-run",
                instructions: "Inspect the change.",
                tools: [],
            }),
            config: baseConfig(),
            createAdapter: () => capture(
                new FauxAdapter([answer("hostless")], { chunkSize: 3 }),
                requests,
            ),
        });
        expect(result.outcome).toBe("completed");
        expect(result.text).toBe("hostless");
        expect(existsSync(join(home, "runtime", "host.sock"))).toBe(false);
        expect(existsSync(join(home, "runtime", "host.json"))).toBe(false);
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
    }
});

test("Vera.create without a home runs the agent's own provider and model", async () => {
    const root = temporaryWorkspace("vera-no-home-");
    const home = join(root, "missing");
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    const selected: VeraConfig[] = [];
    try {
        const vera = await Vera.create({
            workspace: root,
            createAdapter: (config) => {
                selected.push(config);
                return new FauxAdapter([answer("homeless")], { chunkSize: 3 });
            },
        });
        const result = await vera.agent(basicDefinition(), {
            provider: "faux",
            model: "reviewer",
        }).run("Review this patch");
        expect(result.outcome).toBe("completed");
        expect(result.text).toBe("homeless");
        expect(selected.map((config) => [config.provider, config.model]))
            .toEqual([["faux", "reviewer"]]);
        expect(existsSync(home)).toBe(false);
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
    }
});

test("Vera.create without a home refuses an agent with no model", async () => {
    const root = temporaryWorkspace("vera-no-home-");
    const home = join(root, "missing");
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    try {
        const vera = await Vera.create({
            workspace: root,
            createAdapter: () => new FauxAdapter([answer("unused")]),
        });
        await expect(vera.agent(basicDefinition()).run("Review this patch"))
            .rejects.toThrow("pass provider and model to the agent");
        expect(existsSync(home)).toBe(false);
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
    }
});

test("Vera.run without a home runs the named provider and model", async () => {
    const root = temporaryWorkspace("vera-run-no-home-");
    const home = join(root, "missing");
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    const selected: VeraConfig[] = [];
    try {
        const result = await Vera.run({
            prompt: "Review this patch",
            workspace: root,
            agent: basicDefinition(),
            provider: "faux",
            model: "reviewer",
            createAdapter: (config) => {
                selected.push(config);
                return new FauxAdapter([answer("hostless")], { chunkSize: 3 });
            },
        });
        expect(result.text).toBe("hostless");
        expect(selected.map((config) => [config.provider, config.approval_mode]))
            .toEqual([["faux", "readonly"]]);
        expect(existsSync(home)).toBe(false);
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
    }
});

test("Vera.run leaves auth.json untouched when the credential is unusable", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-run-auth-"));
    const previousHome = process.env.VERA_HOME;
    process.env.VERA_HOME = home;
    mkdirSync(join(home, "machine"), { recursive: true });
    const authPath = join(home, "machine", "auth.json");
    const authBody = `${JSON.stringify({
        schema_version: 2,
        credentials: {
            faux: { type: "api_key", key: "expired-key" },
        },
    })}\n`;
    writeFileSync(authPath, authBody);
    try {
        const result = await Vera.run({
            prompt: "Review this patch",
            agent: defineAgent({
                name: "review-auth",
                instructions: "Inspect the change.",
                tools: [],
            }),
            config: baseConfig(),
            createAdapter: () => ({
                stream() {
                    throw new Error("oauth token expired");
                },
            }),
        });
        expect(result.outcome).toBe("failed");
        expect(result.error?.message).toContain("faux credential is not usable");
        expect(result.error?.message).toContain("vera login");
        expect(readFileSync(authPath, "utf8")).toBe(authBody);
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
    }
});

test("Vera.run --session writes a durable SessionStore at the named path", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-run-session-"));
    const sessionPath = join(root, "kept.jsonl");
    const requests: ModelRequest[] = [];
    try {
        const result = await Vera.run({
            prompt: "Remember this",
            agent: defineAgent({
                name: "review-session",
                instructions: "Inspect the change.",
                tools: [],
            }),
            config: baseConfig(),
            sessionPath,
            createAdapter: () => capture(
                new FauxAdapter([answer("stored")], { chunkSize: 3 }),
                requests,
            ),
        });
        expect(result.outcome).toBe("completed");
        expect(existsSync(sessionPath)).toBe(true);
        const store = await SessionStore.open(sessionPath);
        expect(store.header.cwd).toBe(process.cwd());
        expect(store.messages().some((message) =>
            JSON.stringify(message).includes("Remember this")
        )).toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("Vera.run uses the shipped default agent when none is named", async () => {
    const result = await Vera.run({
        prompt: "say hostless",
        config: baseConfig(),
        createAdapter: () => new FauxAdapter(
            [answer("hostless")],
            { chunkSize: 3 },
        ),
    });
    expect(result.outcome).toBe("completed");
    expect(result.text).toBe("hostless");
});

test("Vera.run does not start a child when subagent configuration is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-run-subagent-"));
    let adapters = 0;
    try {
        const result = await Vera.run({
            prompt: "start one",
            workspace: root,
            config: { ...baseConfig(), approval_mode: "auto" },
            createAdapter() {
                adapters += 1;
                return new FauxAdapter(adapters === 1
                    ? [
                        toolCall("async_subagent", { description: "waiting task" }),
                        answer("No child was started."),
                    ]
                    : [answer("must not run")]);
            },
        });
        expect(result.outcome).toBe("completed");
        expect(adapters).toBe(1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

interface FindingOutput {
    readonly findings: readonly { readonly summary: string }[];
}

function findingsSchema(): AgentOutputSchema<FindingOutput> {
    return {
        parse(value) {
            if (!isRecord(value) || !Array.isArray(value.findings)) {
                throw new Error("findings must be an array");
            }
            const findings = value.findings.map((finding) => {
                if (!isRecord(finding) || typeof finding.summary !== "string") {
                    throw new Error("finding summary is required");
                }
                return { summary: finding.summary };
            });
            return { findings };
        },
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function basicDefinition(): AgentDefinition {
    return defineAgent({
        name: "review-basic",
        instructions: "Review the supplied input.",
        tools: [],
    });
}

interface ScriptedVeraOptions {
    readonly workspace?: string;
    readonly config?: VeraConfig;
    readonly posture?: string;
}

function scriptedVera(
    responses: readonly AssistantMessage[],
    requests: ModelRequest[] = [],
    options: ScriptedVeraOptions = {},
): Promise<Vera> {
    const scripted = new FauxAdapter(responses, { chunkSize: 3 });
    return Vera.create({
        config: options.config ?? baseConfig(),
        ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
        ...(options.posture === undefined ? {} : { posture: options.posture }),
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
        approval_mode: "readonly",
    };
}

function temporaryWorkspace(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

function answer(
    text: string,
    provider = "faux",
    model = "reviewer",
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider, api: "test", model },
        usage: {
            ...emptyUsage(),
            inputTokens: 3,
            outputTokens: 2,
            totalTokens: 5,
        },
        stopReason: "stop",
    };
}

function toolCall(
    name: string,
    input: Readonly<Record<string, unknown>>,
): AssistantMessage {
    return {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: `call-${name}`,
            name,
            input,
        }],
        source: { provider: "faux", api: "test", model: "reviewer" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function toolCallWithText(
    text: string,
    name: string,
    input: Readonly<Record<string, unknown>>,
): AssistantMessage {
    return {
        role: "assistant",
        content: [
            { type: "text", text },
            {
                type: "tool_call",
                id: `call-${name}`,
                name,
                input,
            },
        ],
        source: { provider: "faux", api: "test", model: "reviewer" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}
