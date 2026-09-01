import { afterEach, expect, test } from "bun:test";
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
    loadVeraConfig,
    updateVeraConfigDefaults,
} from "../../src/config.ts";
import {
    createWorkerAdapterOptions,
    createWorkerRequestPreparer,
} from
    "../../src/host/worker/adapter.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const roots: string[] = [];
const WORKER_ADAPTER = fileURLToPath(new URL(
    "./fixtures/worker-request-options-adapter.ts",
    import.meta.url,
));

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

test("an already-running worker prepares the latest exact-model option", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-worker-request-options-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify(config("first")));
    const serialized = JSON.parse(JSON.stringify(createWorkerAdapterOptions(
        loadVeraConfig({ path: configPath }),
        configPath,
        {
            provider: "openrouter",
            projectRoot: root,
            sessionId: "worker-request-options",
        },
    )));
    const prepare = createWorkerRequestPreparer(serialized);

    const first = await prepare({ model: "test/model", messages: [] }, "openrouter");
    expect(first.bodyExtensions).toEqual({ provider: { only: ["first"] } });

    updateVeraConfigDefaults({
        model_request_options: {
            model: "openrouter/test/model",
            body: { provider: { only: ["second-longer"] } },
        },
    }, { path: configPath });
    const second = await prepare({ model: "test/model", messages: [] }, "openrouter");
    expect(second.bodyExtensions).toEqual({
        provider: { only: ["second-longer"] },
    });

    const other = await prepare({ model: "other/model", messages: [] }, "openrouter");
    expect(other.bodyExtensions).toBeUndefined();
});

test("a running worker process reads edits from the serialized config path", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-worker-request-options-process-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    const recordPath = join(root, "requests.jsonl");
    writeFileSync(configPath, JSON.stringify(config("first")));
    const registry = new AgentRegistry({
        createAdapter: () => new FauxAdapter([]),
        workerAdapterSpec: (context) => ({
            module: WORKER_ADAPTER,
            options: {
                ...createWorkerAdapterOptions(
                    loadVeraConfig({ path: configPath }),
                    configPath,
                    context,
                ),
                recordPath,
            },
        }),
        provider: "openrouter",
        model: "test/model",
        approvalMode: "auto",
    });

    try {
        const agent = await registry.create({
            id: "request-options-worker",
            workspace: root,
            sessionPath: join(root, "session.jsonl"),
        });
        const attachment = agent.attach();
        expect((await attachment.receive()).type).toBe("history");
        attachment.send({ type: "prompt", content: "first" });
        await receiveTurnFinished(attachment);

        updateVeraConfigDefaults({
            model_request_options: {
                model: "openrouter/test/model",
                body: { provider: { only: ["second-longer"] } },
            },
        }, { path: configPath });
        attachment.send({ type: "prompt", content: "second" });
        await receiveTurnFinished(attachment);
        await Bun.sleep(100);

        expect(readFileSync(recordPath, "utf8").trim().split("\n")
            .map((line) => JSON.parse(line)))
            .toEqual([
                { provider: { only: ["first"] } },
                { provider: { only: ["second-longer"] } },
            ]);
    } finally {
        await registry.close();
    }
});

async function receiveTurnFinished(
    attachment: AgentAttachment,
): Promise<void> {
    while ((await attachment.receive()).type !== "turn_finished") {
        // The turn's streamed updates precede its terminal event.
    }
}

function config(upstream: string): Record<string, unknown> {
    return {
        schema_version: 1,
        provider: "openrouter",
        model: "test/model",
        approval_mode: "ask",
        model_request_options: {
            "openrouter/test/model": {
                body: { provider: { only: [upstream] } },
            },
        },
    };
}
