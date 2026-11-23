import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentUpdate } from "../../src/engine/protocol.ts";
import type { VeraExtensionConfig } from "../../src/config.ts";
import { loadExtensionManifest } from "../../src/extensions/manifest.ts";
import { workerExtensionConfigs } from "../../src/extensions/host-set.ts";
import { emptyPluginSnapshot, readPluginSnapshot } from "../../src/plugins/catalog.ts";
import { installPlugin } from "../../src/plugins/manager.ts";
import { AGENT_PLUGIN_SCHEMA } from "../../src/plugins/naming.ts";
import { AgentRegistry } from "../../src/host/agent-registry.ts";
import { defaultHostLogPath } from "../../src/host/host-log.ts";
import { startWorkerExtensions } from "../../src/host/worker/extensions.ts";
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
        if (previousHome === undefined) process.env.VERA_HOME = process.env.VERA_TEST_HOME!;
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
    }, emptyPluginSnapshot());
    const ids = configs.map((config) =>
        loadExtensionManifest(config.path).manifest.id
    );
    expect(ids).toContain("vera.budget");
    expect(ids).not.toContain("vera.mcp");
    expect(ids).not.toContain("vera.artifacts");

    const withoutBudget = workerExtensionConfigs({
        disabled_included_extensions: ["vera.budget"],
        extensions: [],
    }, emptyPluginSnapshot());
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
        }, emptyPluginSnapshot());
        expect(withConfigured.some((config) => config.path === configured))
            .toBe(true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("@core model-turn workers skip replaced plugin packages and warn once per host", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-worker-plugin-replaced-"));
    const veraHome = join(root, ".vera");
    const marker = join(root, "replacement-imported");
    const previousExtensions = process.env.VERA_WORKER_EXTENSIONS;
    process.env.VERA_WORKER_EXTENSIONS = "1";
    async function source(name: string, id: string): Promise<string> {
        const directory = join(root, name);
        const extension = join(directory, "dev.vera", "host");
        await mkdir(extension, { recursive: true });
        await writeFile(join(directory, "plugin.json"), JSON.stringify({
            $schema: AGENT_PLUGIN_SCHEMA, name,
        }));
        await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
            id, version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
            capabilities: ["hooks.model_middleware"],
        }));
        await writeFile(join(extension, "extension.ts"),
            "export function activate(vera) { vera.hooks.registerModelMiddleware((adapter) => adapter); }\n");
        return directory;
    }
    let agents: AgentRegistry | undefined;
    let worker: Awaited<ReturnType<typeof startWorkerExtensions>> | undefined;
    try {
        const replaced = await source("sea-chest", "crow.replace");
        const missing = await source("crow-gone", "crow.gone");
        const unchanged = await source("crow-keep", "crow.keep");
        installPlugin(replaced, { home: root });
        installPlugin(missing, { home: root });
        installPlugin(unchanged, { home: root });
        const snapshot = readPluginSnapshot({ veraHome });
        const paths = new Map(snapshot.host_extensions.map((part) => [part.plugin, part.directory]));
        const configured = {
            extensions: [{ path: paths.get("sea-chest")!, enabled: true, config: {} }],
        };
        agents = new AgentRegistry({
            createAdapter: () => new FauxAdapter([]),
            workerExtensions: () => workerExtensionConfigs(configured, snapshot),
            model: "faux/test",
            approvalMode: "full_access",
        });
        const initial = agents.workerExtensions()!;
        for (const path of paths.values()) expect(initial.some((entry) => entry.path === path)).toBe(true);

        await writeFile(join(replaced, "dev.vera", "host", "vera.extension.json"), JSON.stringify({
            id: "crow.replace", version: "2.0.0", sdk: "1", entrypoint: "replacement.ts",
            capabilities: ["hooks.model_middleware"],
        }));
        await writeFile(join(replaced, "dev.vera", "host", "replacement.ts"), `
            import { writeFileSync } from "node:fs";
            writeFileSync(${JSON.stringify(marker)}, "imported");
            export function activate(vera) { vera.hooks.registerModelMiddleware((adapter) => adapter); }
        `);
        installPlugin(replaced, { home: root });
        await rm(join(veraHome, "plugins", "crow-gone"), { recursive: true, force: true });

        const selected = agents.workerExtensions()!;
        expect(selected.some((entry) => entry.path === paths.get("sea-chest"))).toBe(false);
        expect(selected.some((entry) => entry.path === paths.get("crow-gone"))).toBe(false);
        expect(selected.some((entry) => entry.path === paths.get("crow-keep"))).toBe(true);
        const pluginPaths = new Set(paths.values());
        worker = await startWorkerExtensions(
            selected.filter((entry) => pluginPaths.has(entry.path)),
            veraHome,
        );
        expect(worker.activationFailure).toBeUndefined();
        expect(worker.registry?.modelMiddleware().map((entry) => entry.extensionId)).toEqual(["crow.keep"]);
        expect(existsSync(marker)).toBe(false);

        agents.workerExtensions();
        const logs = readFileSync(defaultHostLogPath(veraHome), "utf8").trim().split("\n")
            .map((line) => JSON.parse(line) as { type: string; message?: string })
            .filter((entry) => entry.type === "host_startup_plugin_warning");
        expect(logs.map((entry) => entry.message)).toEqual([
            "plugin crow-gone: the installed package changed or is unavailable; restart the host to load the new version",
            "plugin sea-chest: the installed package changed or is unavailable; restart the host to load the new version",
        ]);
        const callbackWarnings: string[] = [];
        const anotherHost = { ...snapshot };
        workerExtensionConfigs(configured, anotherHost, (message) => callbackWarnings.push(message));
        workerExtensionConfigs(configured, anotherHost, (message) => callbackWarnings.push(message));
        expect(callbackWarnings).toEqual(logs.map((entry) => entry.message!));
    } finally {
        await worker?.registry?.close();
        await agents?.close();
        if (previousExtensions === undefined) delete process.env.VERA_WORKER_EXTENSIONS;
        else process.env.VERA_WORKER_EXTENSIONS = previousExtensions;
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
