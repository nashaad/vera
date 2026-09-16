import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../../src/agents/definition.ts";
import { createSubagentEffectApplier, type SubagentPoolPolicy } from "../../src/engine/subagent.ts";
import { delegatedSubagentPolicy } from "../../src/host/agent-registry/helpers.ts";
import { emptyUsage, type ModelRequest } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const directories: string[] = [];
afterEach(async () => {
    for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

const definition: AgentDefinition = {
    name: "research",
    instructions: "Find evidence and cite its source.",
    tools: ["read", "grep"],
    skills: [],
    posture: "readonly",
    subagentAssignment: "eco",
};

async function run(options: {
    readonly policy: SubagentPoolPolicy;
    readonly available?: boolean;
    readonly agent?: string;
    readonly model?: string;
    readonly emptyFavorites?: boolean;
}) {
    const root = await mkdtemp(join(tmpdir(), "vera-assignment-"));
    directories.push(root);
    const requests: ModelRequest[] = [];
    const paths: string[] = [];
    const adapter = new FauxAdapter([{
        role: "assistant",
        content: [{ type: "text", text: "The records agree." }],
        source: { provider: "faux", api: "test", model: "small" },
        usage: emptyUsage(),
        stopReason: "stop",
    }]);
    let configurationRequests = 0;
    const apply = createSubagentEffectApplier({
        adapter: { stream(request) { requests.push(request); return adapter.stream(request); } },
        workspace: root,
        loadOptionalContext: false,
        loadAgent: async () => definition,
        sessionPathForId: (id) => {
            const path = join(root, `${id}.jsonl`);
            paths.push(path);
            return path;
        },
        readPool: () => (options.emptyFavorites ? [] : ["small", "ordinary"]).map((model) => ({
            provider: "faux", model, label: model,
            available: model === "small" ? options.available !== false : true,
            verified: true, levels: [{ id: "low", label: "Low" }],
        })),
        readPolicy: () => options.policy,
        requestMissingConfiguration: async () => {
            configurationRequests += 1;
            return { ok: false, reason: "cancelled", error: "cancelled" };
        },
    });
    const result = await apply({
        type: "spawn_subagent", description: "Compare the records.",
        ...(options.agent === undefined ? {} : { agent: options.agent }),
        ...(options.model === undefined ? {} : { model: options.model }),
    }, new AbortController().signal, {
        provider: "faux", model: "parent", approvalMode: "ask", sessionId: "parent",
        selectedAgent: { name: "parent", instructions: "Private parent instructions", tools: ["read", "subagent"] },
    });
    return { result, requests, paths, configurationRequests };
}

const policy: SubagentPoolPolicy = {
    assigned: [{ provider: "faux", model: "ordinary" }],
    allowSelf: true,
    assignments: { eco: [{ provider: "faux", model: "small", reasoningEffort: "low" }] },
};

test("an assigned candidate runs with no favorites", async () => {
    const result = await run({ emptyFavorites: true, policy: {
        ...policy, candidates: [{ provider: "faux", model: "ordinary", label: "ordinary", available: true, verified: true, levels: [] }],
    } });
    expect(result.result.isError).toBe(false);
    expect(result.requests[0]?.model).toBe("ordinary");
    expect(result.configurationRequests).toBe(0);
});

test("a named assignment supplies the child model and preserves parent tool limits", async () => {
    const result = await run({ policy, agent: "research" });
    expect(result.result.isError).toBe(false);
    expect(result.result.output).toStartWith("Agent: research\nModel: faux/small\nReasoning effort: low\n\n");
    expect(result.requests).toHaveLength(1);
    const request = result.requests[0]!;
    expect([request.provider, request.model, request.reasoningEffort])
        .toEqual(["faux", "small", "low"]);
    expect(request.tools?.map((tool) => tool.name)).toEqual(["read"]);
    expect(request.systemPrompt).toContain(definition.instructions);
    expect(JSON.stringify(request.messages)).not.toContain("Private parent instructions");
    const store = await SessionStore.open(result.paths[0]!);
    expect(store.selectedAgent()?.snapshot.subagentAssignment).toBe("eco");
    expect(store.header.delegation?.models).toEqual(policy.assignments!.eco);
});

test("an ordinary child keeps the subagents assignment", async () => {
    const result = await run({ policy });
    expect(result.result.isError).toBe(false);
    expect(result.requests[0]?.model).toBe("ordinary");
    expect(result.result.output).toStartWith("Agent: none\nModel: faux/ordinary\nReasoning effort: provider default\n\n");
});

for (const scenario of ["unset", "unavailable", "denied", "override"] as const) {
    test(`a bound child refuses ${scenario} instead of using another assignment or parent`, async () => {
        const result = await run({
            agent: "research",
            policy: {
                ...policy,
                ...(scenario === "unset" ? { assignments: {} } : {}),
                ...(scenario === "denied" ? { deny: ["faux/small"] } : {}),
            },
            available: scenario !== "unavailable",
            ...(scenario === "override" ? { model: "faux/ordinary" } : {}),
        });
        expect(result.result.isError).toBe(true);
        expect(result.result.output).toContain("Defaults -> eco");
        expect(result.requests).toHaveLength(0);
        expect(result.paths).toHaveLength(0);
        expect(result.configurationRequests).toBe(0);
    });
}

test("a resumed delegated session cannot escape its recorded bound through an assignment", async () => {
    const bounded = delegatedSubagentPolicy(policy, {
        kind: "subagent", parentId: "parent",
        models: [{ provider: "faux", model: "ordinary" }],
    });
    const result = await run({ policy: bounded, agent: "research" });
    expect(result.result.isError).toBe(true);
    expect(result.requests).toHaveLength(0);
});
