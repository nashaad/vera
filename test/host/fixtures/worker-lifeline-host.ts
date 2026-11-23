import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { isToolApprovalUiRequestUpdate } from "../../../src/engine/protocol.ts";
import { residentWorkerSpawnCommand } from "../../../src/host/worker/handle.ts";
import { createWorkerBoundaryServer } from "../../../src/host/worker/boundary-server.ts";
import { createJsonPipe } from "../../../src/host/worker/pipe.ts";
import { emptyUsage } from "../../../src/model/types.ts";
import { SessionStore } from "../../../src/store/session-store.ts";

const [home, mode] = process.argv.slice(2) as [string, string];
const toolPidPath = join(home, "tool.pid");
const toolChildPidPath = join(home, "tool-child.pid");
const store = await SessionStore.create(join(home, "session.jsonl"), {
    sessionId: "lifeline",
    cwd: home,
});
const [executable, ...args] = residentWorkerSpawnCommand(undefined);
const worker = spawn(executable!, args, {
    argv0: "vera-worker",
    stdio: ["pipe", "pipe", "inherit"],
    detached: true,
    env: { ...process.env, VERA_HOME: home, HOME: home },
});
if (worker.pid === undefined || worker.stdin === null || worker.stdout === null) {
    throw new Error("Worker did not start");
}
writeFileSync(join(home, "worker.pid"), String(worker.pid));
process.stdout.write(`${JSON.stringify({ worker: worker.pid })}\n`);
let ready = (): void => {};
let turnFinished = (): void => {};
const initialized = new Promise<void>((resolve) => { ready = resolve; });
const finished = new Promise<void>((resolve) => { turnFinished = resolve; });
const pipe = createJsonPipe({ input: worker.stdout, output: worker.stdin }, {
    onRequest: (body) => server.handleRequest(body),
    onNotification: (body) => server.handleNotification(body),
});
const server = createWorkerBoundaryServer({
    pipe,
    store,
    services: {},
    onBlockAck: () => ready(),
    onClientUpdate: (update) => {
        if (update.type === "ui_request" && isToolApprovalUiRequestUpdate(update)) {
            server.sendCommand({
                type: "ui_response",
                requestId: update.requestId,
                response: { type: "tool_approval", decision: "allow_once" },
            });
        }
        if (update.type === "turn_finished") turnFinished();
    },
});
store.watchRecords((line, record) => server.pushRecord(line, record));

process.stdin.on("data", (chunk: Buffer) => {
    if (chunk.toString().includes("close")) worker.stdin!.end();
});

if (mode !== "before") {
    const source = { provider: "faux", api: "scripted", model: "test" };
    const tool = mode === "foreground" || mode === "background" || mode === "cleanup-hang";
    const script = tool ? [
        {
            role: "assistant",
            content: [{
                type: "tool_call",
                id: "hold",
                name: "bash",
                input: {
                    command: `echo $$ > '${toolPidPath}'; sleep 60 & echo $! > '${toolChildPidPath}'; wait`,
                    ...(mode === "foreground" ? {} : { yield_after: 0 }),
                },
            }],
            source,
            usage: emptyUsage(),
            stopReason: "tool_use",
        },
        {
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
            source,
            usage: emptyUsage(),
            stopReason: "stop",
        },
    ] : [];
    let extensions: { path: string; enabled: boolean; config: object }[] | undefined;
    if (mode === "cleanup-hang" || mode === "extension-pending" || mode === "extension-release"
        || mode === "extension-dispose-hang") {
        const path = join(home, "extension");
        mkdirSync(path);
        writeFileSync(join(path, "vera.extension.json"), JSON.stringify({
            id: "test.lifeline", version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
            capabilities: ["commands.register"], contributes: {},
        }));
        writeFileSync(join(path, "extension.ts"), `
            import { existsSync, writeFileSync } from "node:fs";
            export function activate(api) {
                writeFileSync(${JSON.stringify(join(home, mode === "extension-release" ? "pending-extension-active" : "extension-active"))}, "active");
                ${mode === "extension-pending" ? "return new Promise(() => {});" : mode === "extension-release" ? `
                    api.onDispose(() => writeFileSync(${JSON.stringify(join(home, "pending-extension-disposed"))}, "disposed"));
                    return new Promise((resolve) => {
                        const timer = setInterval(() => {
                            if (!existsSync(${JSON.stringify(join(home, "release-activation"))})) return;
                            clearInterval(timer);
                            writeFileSync(${JSON.stringify(join(home, "pending-extension-settled"))}, "settled");
                            resolve();
                        }, 10);
                    });
                ` : mode === "extension-dispose-hang" ? `
                    api.onDispose(() => {
                        writeFileSync(${JSON.stringify(join(home, "hanging-disposer-started"))}, "started");
                        return new Promise(() => {});
                    });
                ` : `
                    api.onDispose(() => {
                        writeFileSync(${JSON.stringify(join(home, "dispose-started"))}, "started");
                        return new Promise(() => {});
                    });
                `}
            }
        `);
        if (mode === "extension-pending") {
            const activePath = join(home, "active-extension");
            mkdirSync(activePath);
            writeFileSync(join(activePath, "vera.extension.json"), JSON.stringify({
                id: "test.active", version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
                capabilities: ["commands.register"], contributes: {},
            }));
            writeFileSync(join(activePath, "extension.ts"), `
                import { writeFileSync } from "node:fs";
                export function activate(api) {
                    writeFileSync(${JSON.stringify(join(home, "prior-extension-active"))}, "active");
                    api.onDispose(() => writeFileSync(${JSON.stringify(join(home, "prior-extension-disposed"))}, "disposed"));
                }
            `);
            extensions = [
                { path: activePath, enabled: true, config: {} },
                { path, enabled: true, config: {} },
            ];
        } else if (mode === "extension-dispose-hang") {
            const otherPath = join(home, "other-extension");
            mkdirSync(otherPath);
            writeFileSync(join(otherPath, "vera.extension.json"), JSON.stringify({
                id: "test.other", version: "1.0.0", sdk: "1", entrypoint: "extension.ts",
                capabilities: ["commands.register"], contributes: {},
            }));
            writeFileSync(join(otherPath, "extension.ts"), `
                import { writeFileSync } from "node:fs";
                export function activate(api) {
                    writeFileSync(${JSON.stringify(join(home, "other-extension-active"))}, "active");
                    api.onDispose(() => writeFileSync(${JSON.stringify(join(home, "other-disposer-started"))}, "started"));
                }
            `);
            extensions = [
                { path: otherPath, enabled: true, config: {} },
                { path, enabled: true, config: {} },
            ];
        } else {
            extensions = [{ path, enabled: true, config: {} }];
        }
    }
    const pendingAdapter = mode === "adapter-pending" || mode === "provider-pending";
    pipe.notify({
        method: "worker.start",
        model: "test",
        adapter: {
            module: fileURLToPath(new URL(
                pendingAdapter ? "./worker-pending-adapter.ts" : "./worker-scripted-adapter.ts",
                import.meta.url,
            )),
            ...(mode === "provider-pending" ? { export: "createStreamingAdapter" } : {}),
            options: pendingAdapter ? { marker: join(home, "adapter-pending") } : { script },
        },
        ...(extensions === undefined ? {} : { extensions }),
        data: { approvalMode: "ask" },
        session: { path: store.path, header: store.header, lineCount: 1 },
        home,
        offers: { approvalModeRead: false, modelSettings: false, selectedAgent: false },
        capabilities: {},
        state: { policy: {} },
    });
    if (mode === "adapter-pending" || mode === "extension-pending" || mode === "extension-release") {
        const marker = mode === "adapter-pending" ? "adapter-pending"
            : mode === "extension-release" ? "pending-extension-active"
            : "extension-active";
        while (!existsSync(join(home, marker))) await Bun.sleep(10);
    } else {
        pipe.notify({ method: "session.confirmBlock", requestId: "ready" });
        await initialized;
    }
    if (mode === "cleanup-hang" && !existsSync(join(home, "extension-active"))) {
        throw new Error("Extension did not activate");
    }
    if (mode === "provider-pending") {
        server.sendCommand({ type: "prompt", content: "Hold the provider open" });
        while (!existsSync(join(home, "adapter-pending"))) await Bun.sleep(10);
    }
    if (tool) {
        server.sendCommand({ type: "prompt", content: "Hold the command open" });
        while (!existsSync(toolPidPath) || !existsSync(toolChildPidPath)) await Bun.sleep(10);
        process.stdout.write(`${JSON.stringify({
            tool: Number(readFileSync(toolPidPath, "utf8")),
            toolChild: Number(readFileSync(toolChildPidPath, "utf8")),
        })}\n`);
        if (mode !== "foreground") await finished;
    }
} else {
    while (!existsSync(join(home, "machine", "live", `${worker.pid}.json`))) {
        await Bun.sleep(10);
    }
}
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
