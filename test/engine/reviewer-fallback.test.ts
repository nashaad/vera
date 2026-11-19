import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { ModelTurnSettings } from "../../src/engine/model-settings.ts";
import { reviewerFallbackModel } from "../../src/engine/reviewer-fallback.ts";
import type { ToolReviewerSettings } from "../../src/engine/reviewer.ts";
import { runHeadlessLoop } from "../../src/engine/run-turn.ts";
import { createSubagentEffectApplier, runSubagent } from "../../src/engine/subagent.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { ResidentAgent } from "../../src/host/resident-agent.ts";
import { knownReasoningEfforts, type PooledModel } from "../../src/model/catalog-view.ts";
import { cacheBuildId } from "../../src/release/cache-build-id.ts";
import { nearestEffort } from "../../src/model/effort-ladder.ts";
import { emptyUsage, type AssistantMessage, type ModelRequest } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import type { RegisteredTool } from "../../src/tools/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const directories: string[] = [];

afterEach(async () => {
    for (const directory of directories.splice(0)) {
        await rm(directory, { recursive: true, force: true });
    }
});

const source = { provider: "faux", api: "scripted", model: "conversation" };
const tool: RegisteredTool = {
    definition: {
        name: "lookout",
        description: "Check the horizon.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    permissionOperation: "lookout.check",
    async execute() {
        return { kind: "output", output: "clear", isError: false };
    },
};

function response(text: string): AssistantMessage {
    return {
        role: "assistant", content: [{ type: "text", text }],
        source, usage: emptyUsage(), stopReason: "stop",
    };
}

function toolCall(id: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name: "lookout", input: {} }],
        source, usage: emptyUsage(), stopReason: "tool_use",
    };
}

const verdict = response(JSON.stringify({
    outcome: "allow", rationale: "clear", risk_level: "low", user_authorization: "unknown",
}));

class RecordingAdapter extends FauxAdapter {
    readonly requests: ModelRequest[] = [];

    override stream(request: ModelRequest) {
        this.requests.push(request);
        return super.stream(request);
    }
}

async function workspace(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "vera-reviewer-fallback-"));
    directories.push(directory);
    return directory;
}

async function reviewTurn(
    settings: ModelTurnSettings,
    reviewer?: ToolReviewerSettings,
): Promise<readonly ModelRequest[]> {
    const root = await workspace();
    const store = await SessionStore.create(join(root, "session.jsonl"), {
        sessionId: "reviewer-fallback", cwd: root,
    });
    const adapter = new RecordingAdapter([toolCall("call-1"), verdict, response("done")]);
    const resident = new ResidentAgent("reviewer-fallback", root);
    const attachment = resident.attach();
    const loop = runHeadlessLoop(resident.engine, adapter, settings.model, settings.reasoningEffort, {
        approvalMode: "auto",
    }, {
        sessionStore: store,
        extensionTools: [tool],
        readModelSettings: () => settings,
        readApprovalMode: () => "auto",
        updateApprovalMode: async () => undefined,
        readPolicy: () => ({ reviewerFallbackEffort: "low" }),
        readReviewer: () => reviewer,
    });
    try {
        resident.sendPrompt("Check the horizon");
        for (;;) {
            const update = await attachment.receive(AbortSignal.timeout(5_000));
            if (update.type === "ui_request") {
                throw new Error(`Unexpected approval: ${JSON.stringify(update)}, requests: ${adapter.requests.length}`);
            }
            if (update.type === "turn_finished") break;
        }
        return adapter.requests;
    } finally {
        attachment.detach();
        resident.close();
        await loop.catch(() => {});
    }
}

test("@core an unassigned reviewer uses low without changing conversation effort", async () => {
    const requests = await reviewTurn({
        provider: "faux", model: "conversation", reasoningEffort: "max",
        availableReasoningEfforts: ["low", "high", "max"],
    });
    expect(requests.map((request) => [request.model, request.reasoningEffort])).toEqual([
        ["conversation", "max"], ["conversation", "low"], ["conversation", "max"],
    ]);
});

test("@core a worker follows model, pool, and catalog changes", async () => {
    const root = await workspace();
    const recordPath = join(root, "requests.jsonl");
    const home = join(root, "home");
    const cacheDir = join(root, "cache");
    await mkdir(home);
    await mkdir(cacheDir);
    await writeFile(join(home, "pool.json"), JSON.stringify({
        models: { "faux/second": { efforts: { low: null } } },
    }));
    await writeFile(join(cacheDir, "faux.json"), JSON.stringify({
        schema_version: 2, build_id: cacheBuildId(), provider: "faux",
        models: [{ id: "second", label: "Second", levels: [
            { id: "low", label: "Low" }, { id: "high", label: "High" }, { id: "max", label: "Max" },
        ] }],
    }));
    const model = (name: string, levels: readonly string[]): PooledModel => ({
        provider: "faux", model: name, label: name, available: true, verified: false,
        levels: levels.map((id) => ({ id, label: id })), defaultLevel: "max",
    });
    const pool = [model("first", ["low", "max"]), model("second", ["minimal", "medium", "max"])];
    const registry = new AgentRegistry({
        model: "first", provider: "faux", reasoningEffort: "max", approvalMode: "auto",
        createAdapter: () => new FauxAdapter([]),
        readPool: () => pool,
        readAvailableModels: () => pool.map(({ provider, model, label }) => ({
            provider, model, label, description: "",
        })),
        admitToPool: async () => {
            pool[1] = model("second", ["low", "max"]);
            return { verdict: "added" };
        },
        readConfiguredTurnPolicy: () => ({ reviewerFallbackEffort: "low" }),
        cacheDir,
        home,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        workerAdapterSpec: () => ({
            module: pathToFileURL(join(import.meta.dir, "reviewer-fallback-worker-adapter.ts")).href,
            options: { root, recordPath },
        }),
    });
    try {
        const agent = await registry.create({ workspace: root });
        const attachment = agent.attach();
        const prompt = async (): Promise<void> => {
            agent.sendPrompt("Check the horizon");
            for (;;) {
                const update = await attachment.receive(AbortSignal.timeout(10_000));
                if (update.type === "ui_request") throw new Error(`Unexpected approval: ${JSON.stringify(update)}`);
                if (update.type === "turn_finished") break;
            }
        };
        try {
            const initial = await registry.updateSessionModelSettings(agent.id, {
                model: "first", reasoningEffort: "max",
            });
            expect(initial?.settings.reasoningEffort).toBe("max");
            await prompt();
            expect(registry.agents.get(agent.id)?.worker).toBeDefined();
            const switched = await registry.updateSessionModelSettings(agent.id, {
                model: "second", reasoningEffort: "max",
            });
            expect(switched?.settings.model).toBe("second");
            await prompt();
            const admitted = await registry.poolAdd(agent.id, { provider: "faux", model: "second" }, () => {});
            expect(admitted.verdict).toBe("added");
            await prompt();
            pool[1] = model("second", ["minimal", "medium", "max"]);
            registry.notifyModelCatalogChanged();
            await prompt();
            pool.splice(0);
            registry.notifyModelCatalogChanged();
            await prompt();
            const requests = (await readFile(recordPath, "utf8")).trim().split("\n")
                .map((line) => JSON.parse(line) as { model: string; reasoningEffort: string | null });
            expect(requests).toEqual([
                { model: "first", reasoningEffort: "max" },
                { model: "first", reasoningEffort: "low" },
                { model: "first", reasoningEffort: "max" },
                { model: "second", reasoningEffort: "max" },
                { model: "second", reasoningEffort: "medium" },
                { model: "second", reasoningEffort: "max" },
                { model: "second", reasoningEffort: "max" },
                { model: "second", reasoningEffort: "low" },
                { model: "second", reasoningEffort: "max" },
                { model: "second", reasoningEffort: "max" },
                { model: "second", reasoningEffort: "medium" },
                { model: "second", reasoningEffort: "max" },
                { model: "second", reasoningEffort: "max" },
                { model: "second", reasoningEffort: "high" },
                { model: "second", reasoningEffort: "max" },
            ]);
        } finally {
            attachment.detach();
        }
    } finally {
        await registry.close();
    }
}, 30_000);

test.each([
    { name: "specified", reasoningEffort: "max" },
    { name: "omitted", reasoningEffort: undefined },
])("@core an assigned reviewer preserves its $name effort", async ({ reasoningEffort }) => {
    const requests = await reviewTurn({
        provider: "faux", model: "conversation", reasoningEffort: "high",
        availableReasoningEfforts: ["low", "high"],
    }, {
        models: [{ model: "reviewer", ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }],
    });
    expect(requests.map((request) => [request.model, request.reasoningEffort])).toEqual([
        ["conversation", "high"], ["reviewer", reasoningEffort], ["conversation", "high"],
    ]);
});

test.each([
    { levels: ["high", "low"], expected: "low" },
    { levels: ["high", "medium"], expected: "medium" },
    { levels: ["off", "minimal"], expected: "minimal" },
    { levels: ["minimal", "medium"], expected: "medium" },
    { levels: ["medium", "minimal"], expected: "medium" },
    { levels: [], expected: undefined },
    { levels: ["magna", "regular", "small"], expected: undefined },
    { levels: ["medium", "small"], expected: undefined },
    { levels: ["low", "small"], expected: "low" },
])("nearest supported effort for $levels is $expected", ({ levels, expected }) => {
    expect(nearestEffort("low", levels)).toBe(expected);
});

test("@core fallback levels come from catalog and admitted pool facts, not provider guesses", async () => {
    const root = await workspace();
    const cacheDir = join(root, "cache");
    const userPath = join(root, "pool.json");
    const projectPath = join(root, "project-pool.json");
    await mkdir(cacheDir);
    await writeFile(join(cacheDir, "faux.json"), JSON.stringify({
        schema_version: 2, build_id: cacheBuildId(), provider: "faux",
        models: [{
            id: "catalogued", label: "Catalogued",
            levels: [{ id: "low", label: "Low" }, { id: "high", label: "High" }],
        }],
    }));
    const options = { cacheDir, userPath, projectPath, overridesPath: join(root, "overrides.json") };
    expect(knownReasoningEfforts("faux", "catalogued", [], options)).toEqual(["low", "high"]);
    expect(knownReasoningEfforts("ollama", "unknown-test-model", [], options)).toEqual([]);
    const pooled: PooledModel = {
        provider: "faux", model: "catalogued", label: "Catalogued", available: true, verified: true,
        levels: [{ id: "medium", label: "Medium" }],
    };
    expect(knownReasoningEfforts("faux", "catalogued", [pooled], options)).toEqual(["medium"]);
    expect(knownReasoningEfforts("faux", "catalogued", [{ ...pooled, levels: [] }], options)).toEqual([]);
    await writeFile(userPath, JSON.stringify({ models: { "faux/catalogued": { efforts: { low: null } } } }));
    expect(knownReasoningEfforts("faux", "catalogued", [], options)).toEqual(["high"]);
});

test("an owner without a fallback preference retains the current effort", () => {
    expect(reviewerFallbackModel({
        provider: "faux", model: "conversation", reasoningEffort: "max",
        availableReasoningEfforts: [],
    }, undefined)).toEqual({ provider: "faux", model: "conversation", reasoningEffort: "max" });
});

test("@core a delegated run inherits known levels for its parent's model", async () => {
    const root = await workspace();
    const adapter = new RecordingAdapter([toolCall("parent-child"), verdict, response("done")]);
    const apply = createSubagentEffectApplier({
        adapter,
        workspace: root,
        extensionTools: [tool],
        loadOptionalContext: false,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        reviewerFallbackEffort: "low",
        reviewerFallbackLevels: ["medium", "max"],
        readPolicy: () => ({ allowSelf: true }),
        readPool: () => [],
        readWindowSettings: () => ({ availableModels: [] }),
    });
    const result = await apply({
        type: "spawn_subagent",
        description: "look around",
    }, new AbortController().signal, {
        approvalMode: "auto",
        provider: "faux",
        model: "conversation",
        reasoningEffort: "max",
    });
    expect(result.isError).toBe(false);
    expect(adapter.requests.map((request) => [request.model, request.reasoningEffort])).toEqual([
        ["conversation", "max"], ["conversation", "medium"], ["conversation", "max"],
    ]);
});

test("@core a delegated run without known levels leaves reviewer effort unset", async () => {
    const root = await workspace();
    const adapter = new RecordingAdapter([toolCall("unknown-child"), verdict, response("done")]);
    const apply = createSubagentEffectApplier({
        adapter,
        workspace: root,
        extensionTools: [tool],
        loadOptionalContext: false,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        reviewerFallbackEffort: "low",
        readPolicy: () => ({ allowSelf: true }),
        readPool: () => [],
        readWindowSettings: () => ({ availableModels: [] }),
    });
    const result = await apply({
        type: "spawn_subagent",
        description: "look around",
    }, new AbortController().signal, {
        approvalMode: "auto",
        provider: "faux",
        model: "unknown-child",
        reasoningEffort: "max",
    });
    expect(result.isError).toBe(false);
    expect(adapter.requests.map((request) => [request.model, request.reasoningEffort])).toEqual([
        ["unknown-child", "max"], ["unknown-child", undefined], ["unknown-child", "max"],
    ]);
});

test("@core a child with no levels does not inherit its parent's levels", async () => {
    const root = await workspace();
    const adapter = new RecordingAdapter([toolCall("unknown-assigned-child"), verdict, response("done")]);
    const apply = createSubagentEffectApplier({
        adapter,
        workspace: root,
        extensionTools: [tool],
        loadOptionalContext: false,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        reviewerFallbackEffort: "low",
        reviewerFallbackLevels: ["low", "max"],
        readPolicy: () => ({
            assigned: [{ provider: "faux", model: "child", reasoningEffort: "max" }],
            candidates: [{
                provider: "faux", model: "child", label: "Child", available: true,
                verified: false, levels: [],
            }],
        }),
        readPool: () => [],
        readWindowSettings: () => ({ availableModels: [] }),
    });
    const result = await apply({
        type: "spawn_subagent",
        model: "faux/child",
        description: "look around",
    }, new AbortController().signal, {
        approvalMode: "auto",
        provider: "faux",
        model: "conversation",
        reasoningEffort: "max",
    });
    expect(result.isError).toBe(false);
    expect(adapter.requests.map((request) => [request.model, request.reasoningEffort])).toEqual([
        ["child", undefined], ["child", undefined], ["child", undefined],
    ]);
});

test("@core a delegated run uses the assigned model's candidate levels", async () => {
    const root = await workspace();
    const adapter = new RecordingAdapter([toolCall("assigned-child"), verdict, response("done")]);
    const apply = createSubagentEffectApplier({
        adapter,
        workspace: root,
        extensionTools: [tool],
        loadOptionalContext: false,
        sessionPathForId: (id) => join(root, `${id}.jsonl`),
        reviewerFallbackEffort: "low",
        reviewerFallbackLevels: ["low", "max"],
        readPolicy: () => ({
            assigned: [{ provider: "faux", model: "child", reasoningEffort: "max" }],
            candidates: [{
                provider: "faux",
                model: "child",
                label: "Child",
                available: true,
                verified: false,
                levels: [{ id: "minimal", label: "minimal" }, { id: "medium", label: "medium" }, { id: "max", label: "max" }],
                defaultLevel: "max",
            }],
        }),
        readPool: () => [],
        readWindowSettings: () => ({ availableModels: [] }),
    });
    const result = await apply({
        type: "spawn_subagent",
        model: "faux/child",
        description: "look around",
    }, new AbortController().signal, {
        approvalMode: "auto",
        provider: "faux",
        model: "conversation",
        reasoningEffort: "max",
    });
    expect(result.isError).toBe(false);
    expect(adapter.requests.map((request) => [request.model, request.reasoningEffort])).toEqual([
        ["child", "max"], ["child", "medium"], ["child", "max"],
    ]);
});

test("a child reviews with its own model and supported effort", async () => {
    const root = await workspace();
    const adapter = new RecordingAdapter([toolCall("child-call"), verdict, response("done")]);
    const result = await runSubagent({
        adapter, provider: "faux", model: "child", reasoningEffort: "max",
        reviewerFallbackEffort: "low", availableReasoningEfforts: ["minimal", "medium"],
        description: "Check the horizon", workspace: root, approvalMode: "auto",
        sessionPath: join(root, "child.jsonl"), loadOptionalContext: false,
        extensionTools: [tool],
    });
    expect(result.isError).toBe(false);
    expect(adapter.requests.map((request) => [request.model, request.reasoningEffort])).toEqual([
        ["child", "max"], ["child", "medium"], ["child", "max"],
    ]);
});
