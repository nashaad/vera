import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentDefinition } from "../../src/agents/definition.ts";
import { createSubagentEffectApplier } from "../../src/engine/subagent.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { emptyUsage, type AssistantMessage } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const directories: string[] = [];
afterEach(async () => {
    for (const path of directories.splice(0)) {
        await rm(path, { recursive: true, force: true });
    }
});

const source = { provider: "openrouter", api: "test", model: "ordinary" };

const writeCall: AssistantMessage = {
    role: "assistant",
    content: [{
        type: "tool_call",
        id: "write-1",
        name: "write",
        input: { path: "child.txt", content: "written by the child" },
    }],
    source,
    usage: emptyUsage(),
    stopReason: "tool_use",
};

const finished: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    source,
    usage: emptyUsage(),
    stopReason: "stop",
};

function definition(fields: Partial<AgentDefinition>): AgentDefinition {
    return { name: "scribe", instructions: "Write what you are asked.", ...fields };
}

async function delegate(parentMode: string, agent: AgentDefinition) {
    const root = await mkdtemp(join(tmpdir(), "vera-posture-"));
    directories.push(root);
    const paths: string[] = [];
    const apply = createSubagentEffectApplier({
        adapter: new FauxAdapter([writeCall, finished]),
        workspace: root,
        loadOptionalContext: false,
        loadAgent: async () => agent,
        sessionPathForId: (id) => {
            const path = join(root, `${id}.jsonl`);
            paths.push(path);
            return path;
        },
        readPool: () => [{
            provider: "openrouter", model: "ordinary", label: "ordinary",
            available: true, verified: true, levels: [],
        }],
        readPolicy: () => ({ assigned: [{ provider: "openrouter", model: "ordinary" }] }),
    });
    const result = await apply(
        { type: "spawn_subagent", description: "Write the file.", agent: agent.name },
        new AbortController().signal,
        { provider: "openrouter", model: "parent", approvalMode: parentMode, sessionId: "parent" },
    );
    return { root, paths, result, written: existsSync(join(root, "child.txt")) };
}

for (const parentMode of ["auto", "full_access"]) {
    test(`a definition that forbids ${parentMode} runs its child at its posture`, async () => {
        const { result, written, paths } = await delegate(parentMode, definition({
            posture: "readonly",
            forbiddenAccess: ["auto", "full_access"],
        }));
        expect(result.isError).toBe(false);
        expect(written).toBe(false);
        expect((await SessionStore.open(paths[0]!)).approvalMode()).toBe("readonly");
    });
}

for (const parentMode of ["auto", "full_access"]) {
    test(`a readonly posture alone narrows a ${parentMode} parent's child`, async () => {
        const { result, written, paths } = await delegate(parentMode, definition({
            posture: "readonly",
        }));
        expect(result.isError).toBe(false);
        expect(written).toBe(false);
        expect((await SessionStore.open(paths[0]!)).approvalMode()).toBe("readonly");
    });
}

for (const [parentMode, posture] of [["ask", "auto"], ["readonly", "full_access"], ["auto", "full_access"]]) {
    test(`a ${posture} posture does not widen a ${parentMode} parent's child`, async () => {
        const { result, paths } = await delegate(parentMode!, definition({ posture: posture! }));
        expect(result.isError).toBe(false);
        expect((await SessionStore.open(paths[0]!)).approvalMode()).toBe(parentMode!);
    });
}

test("a definition that forbids nothing the parent uses leaves the parent's mode", async () => {
    const { result, written, paths } = await delegate("auto", definition({}));
    expect(result.isError).toBe(false);
    expect(written).toBe(true);
    expect((await SessionStore.open(paths[0]!)).approvalMode()).toBe("auto");
});

test("without a posture the child takes the narrowest mode the definition allows", async () => {
    const { written, paths } = await delegate("full_access", definition({
        forbiddenAccess: ["full_access"],
    }));
    expect(written).toBe(false);
    expect((await SessionStore.open(paths[0]!)).approvalMode()).toBe("readonly");
});

test("a posture wider than the parent's mode is never taken", async () => {
    const { result, written, paths } = await delegate("ask", definition({
        posture: "auto",
        forbiddenAccess: ["ask"],
    }));
    expect(result.isError).toBe(false);
    expect(written).toBe(false);
    expect((await SessionStore.open(paths[0]!)).approvalMode()).toBe("readonly");
});

test("a definition with no narrower mode to offer refuses the launch", async () => {
    const { result, paths, written } = await delegate("readonly", definition({
        posture: "auto",
        forbiddenAccess: ["readonly"],
    }));
    expect(result.isError).toBe(true);
    expect(result.output).toContain("scribe");
    expect(result.output).toContain("readonly");
    expect(paths).toHaveLength(0);
    expect(written).toBe(false);
});

test("a resumed delegated session keeps the mode the definition left it", async () => {
    const { paths } = await delegate("auto", definition({
        posture: "readonly",
        forbiddenAccess: ["auto", "full_access"],
    }));
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([finished]),
        provider: "openrouter",
        model: "ordinary",
        approvalMode: "auto",
    });
    try {
        const resumed = await registry.resume({ sessionPath: paths[0]! });
        expect(registry.approvalModeOf(resumed.id)).toBe("readonly");
    } finally {
        await registry.close();
    }
});
