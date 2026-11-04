import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import {
    FULL_SUMMARY_MODEL_SLOT,
    FULL_SUMMARY_STRATEGY_ID,
} from "../../src/engine/compaction-full-summary.ts";
import type { VeraExtensionConfig } from "../../src/config.ts";
import type { ResolvedCompactionProfile } from "../../src/config/model-catalog.ts";
import { startExtensionRegistry } from "../../src/extensions/registry.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const ADAPTER = fileURLToPath(
    new URL("./fixtures/worker-scripted-adapter.ts", import.meta.url),
);
const COMPACTION: ResolvedCompactionProfile = {
    strategy: FULL_SUMMARY_STRATEGY_ID,
    slots: {
        [FULL_SUMMARY_MODEL_SLOT]: [{
            name: "summarizer",
            provider: "faux",
            model: "faux/test",
        }],
    },
    routes: { [FULL_SUMMARY_MODEL_SLOT]: "default" },
};

interface ContextRecord {
    readonly provider: string;
    readonly purpose: string;
    readonly requestProvider: string | null;
    readonly model: string;
}

function text(body: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: body }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

async function receiveUntil(
    attachment: AgentAttachment,
    predicate: (update: AgentUpdate) => boolean,
): Promise<AgentUpdate> {
    const deadline = Date.now() + 20_000;
    while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Timed out waiting for agent update");
        const update = await Promise.race([
            attachment.receive(),
            Bun.sleep(remaining).then(() => {
                throw new Error("Timed out waiting for agent update");
            }),
        ]);
        if (predicate(update)) return update;
    }
}

async function contextRecords(path: string): Promise<ContextRecord[]> {
    if (!existsSync(path)) return [];
    return (await readFile(path, "utf8"))
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as ContextRecord);
}

async function writeContextExtension(root: string): Promise<string> {
    const directory = join(root, "context-extension");
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, "vera.extension.json"),
        JSON.stringify({
            id: "test.worker-context",
            version: "1.0.0",
            sdk: "1",
            entrypoint: "./extension.ts",
            capabilities: ["hooks.model_middleware"],
        }),
    );
    await writeFile(
        join(directory, "extension.ts"),
        `import { appendFileSync } from "node:fs";

export function activate(vera) {
    const logPath = vera.config.logPath;
    vera.hooks.registerModelMiddleware((adapter, context) => ({
        ...(adapter.supportsImageInput === undefined
            ? {}
            : { supportsImageInput: adapter.supportsImageInput }),
        ...(adapter.imageInputSupport === undefined
            ? {}
            : { imageInputSupport: adapter.imageInputSupport.bind(adapter) }),
        ...(adapter.supportsImageInputFor === undefined
            ? {}
            : {
                supportsImageInputFor:
                    adapter.supportsImageInputFor.bind(adapter),
            }),
        stream(request) {
            appendFileSync(logPath, JSON.stringify({
                provider: context.provider,
                purpose: context.purpose,
                requestProvider: request.provider ?? null,
                model: request.model,
            }) + "\\n");
            return adapter.stream(request);
        },
    }));
}
`,
    );
    return directory;
}

function enabled(path: string, logPath: string): VeraExtensionConfig {
    return { path, enabled: true, config: { logPath } };
}

async function withWorkerHome(
    root: string,
    run: () => Promise<void>,
): Promise<void> {
    const previousHome = process.env.VERA_HOME;
    const previousExtensions = process.env.VERA_WORKER_EXTENSIONS;
    process.env.VERA_HOME = join(root, "home");
    process.env.VERA_WORKER_EXTENSIONS = "1";
    await mkdir(process.env.VERA_HOME, { recursive: true });
    try {
        await run();
    } finally {
        if (previousHome === undefined) delete process.env.VERA_HOME;
        else process.env.VERA_HOME = previousHome;
        if (previousExtensions === undefined) {
            delete process.env.VERA_WORKER_EXTENSIONS;
        } else {
            process.env.VERA_WORKER_EXTENSIONS = previousExtensions;
        }
    }
}

test("a worker middleware chain follows the provider of each request", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-context-"));
    const context = await writeContextExtension(root);
    const workerLog = join(root, "worker-context.jsonl");
    await withWorkerHome(root, async () => {
        const registry = new AgentRegistry({
            createAdapter: () => new FauxAdapter([]),
            workerExtensions: () => [enabled(context, workerLog)],
            workerAdapterSpec: () => ({
                module: ADAPTER,
                options: {
                    provider: "faux",
                    script: [text("one"), text("two")],
                },
            }),
            provider: "faux",
            model: "faux/test",
            approvalMode: "full_access",
        });
        try {
            const agent = await registry.create({
                id: "context",
                workspace: root,
                sessionPath: join(root, "context.jsonl"),
            });
            const client = agent.attach();
            expect((await client.receive()).type).toBe("history");
            client.send({ type: "prompt", content: "first" });
            await receiveUntil(
                client,
                (update) => update.type === "turn_finished",
            );

            client.send({
                type: "update_model_settings",
                requestId: "switch",
                patch: { provider: "ollama", model: "second-model" },
            });
            await receiveUntil(
                client,
                (update) =>
                    update.type === "model_settings"
                    && update.pending === false
                    && update.requestId === "switch",
            );
            client.send({ type: "prompt", content: "second" });
            await receiveUntil(
                client,
                (update) => update.type === "turn_finished",
            );

            expect(await contextRecords(workerLog)).toEqual([
                {
                    provider: "faux",
                    purpose: "turn",
                    requestProvider: "faux",
                    model: "faux/test",
                },
                {
                    provider: "ollama",
                    purpose: "turn",
                    requestProvider: "ollama",
                    model: "second-model",
                },
            ]);
        } finally {
            await registry.close();
        }
    });
    await rm(root, { recursive: true, force: true });
}, 60_000);

test("a worker session's compaction reaches host middleware", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-compact-context-"));
    const context = await writeContextExtension(root);
    const workerLog = join(root, "worker-context.jsonl");
    const hostLog = join(root, "host-context.jsonl");
    await withWorkerHome(root, async () => {
        const hostExtensions = await startExtensionRegistry({
            extensions: [enabled(context, hostLog)],
        });
        const registry = new AgentRegistry({
            createAdapter: () => new FauxAdapter([text("summary")]),
            modelMiddleware: hostExtensions.modelMiddleware(),
            workerExtensions: () => [enabled(context, workerLog)],
            workerAdapterSpec: () => ({
                module: ADAPTER,
                options: {
                    provider: "faux",
                    script: [text("one")],
                },
            }),
            provider: "faux",
            model: "faux/test",
            approvalMode: "full_access",
            compaction: COMPACTION,
        });
        try {
            const agent = await registry.create({
                id: "compacting",
                workspace: root,
                sessionPath: join(root, "compacting.jsonl"),
            });
            const client = agent.attach();
            expect((await client.receive()).type).toBe("history");
            client.send({ type: "prompt", content: "first" });
            await receiveUntil(
                client,
                (update) => update.type === "turn_finished",
            );

            await writeFile(workerLog, "");
            await writeFile(hostLog, "");
            client.send({ type: "compact", requestId: "compact-1" });
            await receiveUntil(
                client,
                (update) =>
                    update.type === "compaction"
                    && update.phase === "finished",
            );

            expect(await contextRecords(hostLog)).toEqual([
                {
                    provider: "faux",
                    purpose: "turn",
                    requestProvider: "faux",
                    model: "faux/test",
                },
            ]);
            expect(await contextRecords(workerLog)).toEqual([]);
        } finally {
            await registry.close();
            await hostExtensions.close();
        }
    });
    await rm(root, { recursive: true, force: true });
}, 60_000);
