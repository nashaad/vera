import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelSettingsUpdate } from "../../src/engine/protocol.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import type { PooledModel } from "../../src/model/catalog-view.ts";
import { availableReasoningEfforts } from "../../src/engine/model-settings.ts";
import { refreshDeepSeekCatalog } from "../../src/model/deepseek-catalog.ts";
import { inferReasoningSelection } from "../../src/model/reasoning-effort.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const GLM = "z-ai/glm-5.2";
const KIMI = "moonshotai/kimi-k3";
const FLASH = "deepseek-flash";

function pooled(model: string, label: string, levelIds: readonly string[]): PooledModel {
    return {
        provider: "openrouter",
        model,
        label,
        available: true,
        verified: true,
        levels: levelIds.map((id) => ({ id, label: id })),
    };
}

function pooledGlm(levelIds: readonly string[]): PooledModel {
    return pooled(GLM, "GLM 5.2", levelIds);
}

function pooledFlash(): PooledModel {
    return {
        provider: "deepseek",
        model: FLASH,
        label: "DeepSeek V4.1 Flash 1017",
        available: true,
        verified: true,
        defaultLevel: "high",
        levels: ["max", "high", "off"].map((id) => ({ id, label: id })),
    };
}

function answer(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function recordingAdapter(
    responses: readonly AssistantMessage[],
    requests: ModelRequest[],
): ModelAdapter {
    const faux = new FauxAdapter(responses);
    return {
        stream(request) {
            requests.push(request);
            return faux.stream(request);
        },
    };
}

async function finishTurn(attachment: AgentAttachment): Promise<void> {
    while ((await attachment.receive()).type !== "turn_finished") {
        // A client consumes the ordered update stream until the turn boundary.
    }
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
        model: KIMI,
        reasoningEffort: "high",
        approvalMode: "auto",
        readPool: () => [
            pooled(KIMI, "Kimi K3", ["max", "high", "medium", "low"]),
            pooledGlm(["max", "high", "medium", "low"]),
        ],
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

test("@core a new session on a Flash-shaped model starts on the model's default level", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-effort-flash-"));
    const cacheDir = await mkdtemp(join(tmpdir(), "vera-effort-flash-cache-"));
    refreshDeepSeekCatalog({ cacheDir });
    const requests: ModelRequest[] = [];
    const registry = new AgentRegistry({
        createAdapter: () => recordingAdapter([answer("done")], requests),
        provider: "deepseek",
        model: FLASH,
        // The saved default names a level this model does not offer.
        reasoningEffort: "low",
        approvalMode: "auto",
        cacheDir,
        readPool: () => [pooledFlash()],
    });

    try {
        const agent = await registry.create({
            workspace: root,
            sessionPath: join(root, "agent.jsonl"),
        });
        const attachment = agent.attach();
        attachment.send({ type: "prompt", content: "hello" });
        await finishTurn(attachment);
        expect(requests[0]?.reasoningEffort).toBe("high");

        attachment.send({ type: "get_model_settings", requestId: "settings" });
        const served = await receiveModelSettings(attachment);
        expect(served.settings.availableReasoningEfforts).toEqual(["max", "high", "off"]);
        expect(served.settings.reasoningEffort).toBe("high");
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
        await rm(cacheDir, { recursive: true, force: true });
    }
});

test("a saved default the model offers is kept at session start", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-effort-kept-"));
    const cacheDir = await mkdtemp(join(tmpdir(), "vera-effort-kept-cache-"));
    await writeFile(
        join(cacheDir, "openrouter.json"),
        JSON.stringify({
            schema_version: 2,
            provider: "openrouter",
            models: [{
                id: GLM,
                label: "GLM 5.2",
                default_level: "high",
                levels: [
                    { id: "max", label: "Max" },
                    { id: "high", label: "High" },
                    { id: "medium", label: "Medium" },
                    { id: "low", label: "Low" },
                ],
            }],
        }),
    );
    const requests: ModelRequest[] = [];
    const registry = new AgentRegistry({
        createAdapter: () => recordingAdapter([answer("done")], requests),
        provider: "openrouter",
        model: GLM,
        reasoningEffort: "low",
        approvalMode: "auto",
        cacheDir,
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
        expect(served.settings.reasoningEffort).toBe("low");

        attachment.send({ type: "prompt", content: "hello" });
        await finishTurn(attachment);
        expect(requests[0]?.reasoningEffort).toBe("low");
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
        await rm(cacheDir, { recursive: true, force: true });
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

/**
 * A model the pool never admitted is answered by the catalog, and the catalog
 * does not know what this key was refused. The refusal is a fact about the key,
 * so both lists drop the level rather than one offering what the other rejects.
 */
test("a level the project pool refuses is neither served nor accepted", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-effort-refused-"));
    const cacheDir = await mkdtemp(join(tmpdir(), "vera-effort-refused-cache-"));
    await mkdir(join(root, ".vera"), { recursive: true });
    await writeFile(
        join(root, ".vera", "pool.json"),
        JSON.stringify({
            models: {
                [`openrouter/${GLM}`]: {
                    learned: {
                        "efforts.max": {
                            ok: false,
                            seen: "2026-08-21T00:00:00Z",
                            error: "Invalid value: 'max'",
                        },
                    },
                },
            },
        }),
    );
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
                ],
            }],
        }),
    );
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        provider: "openrouter",
        model: GLM,
        reasoningEffort: "high",
        approvalMode: "auto",
        cacheDir,
        // No pool entry for this model, so the catalog answers.
        readPool: () => [],
    });

    try {
        const agent = await registry.create({
            workspace: root,
            sessionPath: join(root, "agent.jsonl"),
        });
        const attachment = agent.attach();
        attachment.send({ type: "get_model_settings", requestId: "settings" });
        const served = await receiveModelSettings(attachment);
        expect(served.settings.availableReasoningEfforts)
            .toEqual(["high", "medium"]);
        // Asking for it anyway coerces, exactly as an unpublished level does.
        expect(await registry.updateModelSettings(agent.id, {
            reasoningEffort: "max",
        })).toMatchObject({ reasoningEffort: "medium" });

    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
        await rm(cacheDir, { recursive: true, force: true });
    }
});

/**
 * The looser case cuts the other way too: a stored level the catalog never
 * published is served as it always was, unless admission refuses it. A new
 * session starts on an offered level in that case, so the footer cannot name
 * an effort the next turn refuses.
 */
test("a refused level is not served at session start", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-effort-unpublished-"));
    const cacheDir = await mkdtemp(join(tmpdir(), "vera-effort-unpub-cache-"));
    await mkdir(join(root, ".vera"), { recursive: true });
    await writeFile(
        join(root, ".vera", "pool.json"),
        JSON.stringify({
            models: {
                [`openrouter/${GLM}`]: {
                    learned: {
                        "efforts.max": {
                            ok: false,
                            seen: "2026-08-21T00:00:00Z",
                            error: "Invalid value: 'max'",
                        },
                    },
                },
            },
        }),
    );
    await writeFile(
        join(cacheDir, "openrouter.json"),
        JSON.stringify({
            schema_version: 2,
            provider: "openrouter",
            models: [{
                id: GLM,
                label: "GLM 5.2",
                levels: [
                    { id: "high", label: "High" },
                    { id: "medium", label: "Medium" },
                ],
            }],
        }),
    );
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        provider: "openrouter",
        model: GLM,
        // Neither published by the catalog nor admitted by the pool.
        reasoningEffort: "max",
        approvalMode: "auto",
        cacheDir,
        readPool: () => [],
    });

    try {
        const agent = await registry.create({
            workspace: root,
            sessionPath: join(root, "agent.jsonl"),
        });
        const attachment = agent.attach();
        attachment.send({ type: "get_model_settings", requestId: "settings" });
        const served = await receiveModelSettings(attachment);
        expect(served.settings.availableReasoningEfforts)
            .toEqual(["high", "medium"]);
        expect(served.settings.reasoningEffort).toBe("high");
    } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
        await rm(cacheDir, { recursive: true, force: true });
    }
});
