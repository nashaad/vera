import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import type { VeraExtensionConfig } from "../../src/config.ts";
import { loadExtensionManifest } from "../../src/extensions/manifest.ts";
import { workerExtensionConfigs } from "../../src/extensions/host-set.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import type { AgentAttachment } from "../../src/host/resident-agent.ts";
import {
    emptyUsage,
    type AssistantMessage,
} from "../../src/model/types.ts";
import type { RegisteredTool } from "../../src/tools/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

const ADAPTER = fileURLToPath(
    new URL("./fixtures/worker-scripted-adapter.ts", import.meta.url),
);
const BUDGET = fileURLToPath(new URL("../../extensions/budget", import.meta.url));

function text(body: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: body }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function toolCall(name: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id: "call-1", name, input: {} }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
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

async function writeExtension(
    root: string,
    id: string,
    source: string,
    capabilities: readonly string[],
): Promise<string> {
    const directory = join(root, id);
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, "vera.extension.json"),
        JSON.stringify({
            id,
            version: "1.0.0",
            sdk: "1",
            entrypoint: "./extension.ts",
            capabilities,
        }),
    );
    await writeFile(join(directory, "extension.ts"), source);
    return directory;
}

function enabled(path: string): VeraExtensionConfig {
    return { path, enabled: true, config: null };
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

test("the worker set keeps model middleware and drops other included extensions", async () => {
    const configs = workerExtensionConfigs({
        disabled_included_extensions: [],
        extensions: [],
    });
    const ids = configs.map((config) =>
        loadExtensionManifest(config.path).manifest.id
    );
    expect(ids).toContain("vera.budget");
    expect(ids).not.toContain("vera.mcp");
    expect(ids).not.toContain("vera.artifacts");

    const withoutBudget = workerExtensionConfigs({
        disabled_included_extensions: ["vera.budget"],
        extensions: [],
    });
    expect(withoutBudget.map((config) =>
        loadExtensionManifest(config.path).manifest.id
    )).not.toContain("vera.budget");

    const root = await mkdtemp(join(tmpdir(), "vera-worker-set-"));
    try {
        const configured = await writeExtension(
            root,
            "test.configured",
            "export function activate() {}",
            [],
        );
        const withConfigured = workerExtensionConfigs({
            disabled_included_extensions: [],
            extensions: [enabled(configured)],
        });
        expect(withConfigured.some((config) => config.path === configured))
            .toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a worker loading only middleware extensions still reaches host tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-proxy-"));
    const marker = join(root, "host-tool-ran");
    const hostTool: RegisteredTool = {
        definition: {
            name: "host_probe",
            description: "Runs on the host.",
            inputSchema: { type: "object" },
        },
        async execute() {
            await writeFile(marker, "host", "utf8");
            return { kind: "output", output: "host", isError: false };
        },
    };
    await withWorkerHome(root, async () => {
        const registry = new AgentRegistry({
            createAdapter: () => new FauxAdapter([]),
            workerExtensions: () => [enabled(BUDGET)],
            workerAdapterSpec: () => ({
                module: ADAPTER,
                options: {
                    provider: "faux",
                    script: [toolCall("host_probe"), text("done")],
                },
            }),
            extensionTools: [hostTool],
            model: "faux/test",
            approvalMode: "full_access",
        });
        try {
            const agent = await registry.create({
                id: "proxy",
                workspace: root,
                sessionPath: join(root, "proxy.jsonl"),
            });
            const client = agent.attach();
            expect((await client.receive()).type).toBe("history");
            client.send({ type: "prompt", content: "call the host tool" });
            await receiveUntil(
                client,
                (update) => update.type === "turn_finished",
            );
            expect(existsSync(marker)).toBe(true);
        } finally {
            await registry.close();
        }
    });
    await rm(root, { recursive: true, force: true });
}, 60_000);

test("a broken middleware extension fails the session and names itself", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-broken-"));
    const broken = await writeExtension(
        root,
        "test.worker-broken",
        "export function activate() { throw new Error('middleware cannot load'); }",
        ["hooks.model_middleware"],
    );
    const requestLogPath = join(root, "requests.jsonl");
    await withWorkerHome(root, async () => {
        const registry = new AgentRegistry({
            createAdapter: () => new FauxAdapter([]),
            workerExtensions: () => [enabled(broken)],
            workerAdapterSpec: () => ({
                module: ADAPTER,
                options: {
                    provider: "faux",
                    requestLogPath,
                    script: [text("never")],
                },
            }),
            model: "faux/test",
            approvalMode: "full_access",
        });
        try {
            const agent = await registry.create({
                id: "broken",
                workspace: root,
                sessionPath: join(root, "broken.jsonl"),
            });
            const client = agent.attach();
            expect((await client.receive()).type).toBe("history");
            client.send({ type: "prompt", content: "run" });
            const failed = await receiveUntil(
                client,
                (update) => update.type === "turn_finished",
            );
            expect(failed).toMatchObject({
                type: "turn_finished",
                outcome: "error",
            });
            if (failed.type !== "turn_finished") {
                throw new Error("expected turn_finished");
            }
            expect(failed.error).toContain("test.worker-broken");
            expect(failed.error).toContain("middleware cannot load");
            expect(existsSync(requestLogPath)).toBe(false);
        } finally {
            await registry.close();
        }
    });
    await rm(root, { recursive: true, force: true });
}, 60_000);
