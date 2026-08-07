import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelSettingsUpdate } from "../../src/engine/protocol.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import type { PooledModel } from "../../src/model/catalog-view.ts";
import { availableReasoningEfforts } from "../../src/engine/model-settings.ts";
import { inferReasoningSelection } from "../../src/model/reasoning-effort.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const GLM = "z-ai/glm-5.2";

function pooledGlm(levelIds: readonly string[]): PooledModel {
    return {
        provider: "openrouter",
        model: GLM,
        label: "GLM 5.2",
        available: true,
        verified: true,
        levels: levelIds.map((id) => ({ id, label: id })),
    };
}

/**
 * The level list a client is served and the list a settings change is checked
 * against are one reader, so a level the picker offers is always one the
 * change accepts.
 */
test("a level the served list offers is accepted by the settings change", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-effort-agree-"));
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        provider: "openrouter",
        model: GLM,
        reasoningEffort: "high",
        approvalMode: "auto",
        readPool: () => [pooledGlm(["max", "high", "medium", "low"])],
    });

    try {
        const agent = await registry.create({
            workspace: root,
            sessionPath: join(root, "agent.jsonl"),
        });
        const attachment = agent.attach();
        attachment.send({ type: "get_model_settings", requestId: "settings" });
        const served = await receiveModelSettings(attachment);
        expect(served.settings.availableReasoningEfforts).toContain("medium");

        const changed = await registry.updateModelSettings(agent.id, {
            reasoningEffort: "medium",
        });
        expect(changed).toMatchObject({ model: GLM, reasoningEffort: "medium" });
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

/** The shipped verified list seeds a model discovery has not described; it never caps one it has. */
test("the catalog outranks the shipped verified list", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "vera-effort-catalog-"));
    try {
        await writeFile(
            join(cacheDir, "openrouter.json"),
            JSON.stringify({
                schema_version: 2,
                provider: "openrouter",
                models: [{
                    id: GLM,
                    label: "GLM 5.2",
                    levels: [
                        { id: "max", label: "Max" },
                        { id: "high", label: "High" },
                        { id: "medium", label: "Medium" },
                        { id: "low", label: "Low" },
                    ],
                }],
            }),
        );
        expect(availableReasoningEfforts("openrouter", GLM, { cacheDir }))
            .toEqual(["max", "high", "medium", "low"]);
    } finally {
        await rm(cacheDir, { recursive: true, force: true });
    }
});

/**
 * One rule for a level the target model does not name, at every layer: the
 * model's own default, else a middle level, never the top.
 */
test("an unnamed level resolves the same way across the layers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-effort-off-"));
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        reasoningEffort: "high",
        approvalMode: "auto",
    });

    try {
        const agent = await registry.create({
            workspace: root,
            sessionPath: join(root, "agent.jsonl"),
        });

        // Layer one: the level on its own coerces to a middle level of what
        // kimi-k3 offers.
        expect(await registry.updateModelSettings(agent.id, {
            reasoningEffort: "off",
        })).toMatchObject({ reasoningEffort: "medium" });

        // Layer two: the same level riding a model change lands on the same
        // rule against the target's own list.
        expect(await registry.updateModelSettings(agent.id, {
            model: GLM,
            reasoningEffort: "off",
        })).toMatchObject({ model: GLM, reasoningEffort: "medium" });

        // Layer three: request-time resolution says the same thing.
        expect(inferReasoningSelection(
            "off",
            ["xhigh", "high", "medium", "low"],
            "medium",
        )).toMatchObject({ providerEffort: "medium" });
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

/**
 * The coerced level is the whole answer to what is running, so the level that
 * was asked for rides along beside it and stays there: a client reads it on
 * every later snapshot, not only on the reply to the change.
 */
test("a coerced level publishes what was asked for until a clean change", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-effort-asked-"));
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        provider: "openrouter",
        model: GLM,
        reasoningEffort: "high",
        approvalMode: "auto",
        readPool: () => [pooledGlm(["high", "medium", "low"])],
    });

    try {
        const agent = await registry.create({
            workspace: root,
            sessionPath: join(root, "agent.jsonl"),
        });
        const attachment = agent.attach();

        const coerced = await registry.updateModelSettings(agent.id, {
            reasoningEffort: "xhigh",
        });
        expect(coerced).toMatchObject({
            reasoningEffort: "medium",
            requestedReasoningEffort: "xhigh",
        });

        attachment.send({ type: "get_model_settings", requestId: "standing" });
        const standing = await receiveModelSettings(attachment);
        expect(standing.settings).toMatchObject({
            reasoningEffort: "medium",
            requestedReasoningEffort: "xhigh",
        });

        const clean = await registry.updateModelSettings(agent.id, {
            reasoningEffort: "low",
        });
        expect(clean).toMatchObject({ reasoningEffort: "low" });
        expect(clean?.requestedReasoningEffort).toBeUndefined();

        attachment.send({ type: "get_model_settings", requestId: "cleared" });
        const cleared = await receiveModelSettings(attachment);
        expect(cleared.settings.requestedReasoningEffort).toBeUndefined();
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

/** A level the model publishes is never annotated, whatever else changed. */
test("a published level publishes no requested level", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-effort-unasked-"));
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        provider: "openrouter",
        model: GLM,
        reasoningEffort: "high",
        approvalMode: "auto",
        readPool: () => [pooledGlm(["high", "medium", "low"])],
    });

    try {
        const agent = await registry.create({
            workspace: root,
            sessionPath: join(root, "agent.jsonl"),
        });
        const changed = await registry.updateModelSettings(agent.id, {
            reasoningEffort: "medium",
        });
        expect(changed?.requestedReasoningEffort).toBeUndefined();
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
    }
});

async function receiveModelSettings(
    attachment: AgentAttachment,
): Promise<ModelSettingsUpdate> {
    while (true) {
        const update = await attachment.receive();
        if (update.type === "model_settings") {
            return update;
        }
    }
}
