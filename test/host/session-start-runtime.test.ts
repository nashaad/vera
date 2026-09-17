import { expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVeraConfig } from "../../src/config.ts";
import { defaultHostLogPath } from "../../src/host/host-log.ts";
import { attachAgent, type AttachedAgentClient } from "../../src/host/attached-client.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { emptyUsage, type ModelRequest } from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

(process.env.CODEX_SANDBOX_NETWORK_DISABLED === "1" ? test.skip : test)(
    "home command hooks and extension hooks reach the first request after a failure",
    async () => {
        const root = mkdtempSync(join(tmpdir(), "vera-start-runtime-"));
        const home = join(root, "home");
        const extension = join(root, "extension");
        mkdirSync(join(home, "hooks"), { recursive: true });
        mkdirSync(extension);
        const executable = join(home, "hooks", "greet");
        writeFileSync(executable, `#!${process.execPath}\nconst p = await Bun.stdin.json(); console.log(JSON.stringify({power: "mutate", context: "command: " + p.reason}));\n`);
        chmodSync(executable, 0o755);
        writeFileSync(join(extension, "vera.extension.json"), JSON.stringify({
            id: "test.greeting", sdk: "1", version: "1.0.0", entrypoint: "extension.ts", capabilities: ["hooks.session_start"],
        }));
        writeFileSync(join(extension, "extension.ts"), `export function activate(api) {
            api.hooks.registerSessionStart(() => { throw new Error("broken greeting"); });
            api.hooks.registerSessionStart(() => ({power: "mutate", context: "extension greeting"}));
        }`);
        const configPath = join(home, "config.json");
        writeFileSync(configPath, JSON.stringify({
            schema_version: 1, model: "faux/test", approval_mode: "ask",
            hooks: [{ phase: "session_start", argv: ["greet"] }],
            extensions: [{ path: extension, enabled: true, config: {} }],
        }));
        const requests: ModelRequest[] = [];
        const warning = spyOn(console, "warn").mockImplementation(() => {});
        const host = await startResidentHost({
            config: loadVeraConfig({ path: configPath }),
            createAdapter: () => ({ stream(request) {
                requests.push(request);
                return new FauxAdapter([{
                    role: "assistant", content: [{ type: "text", text: "done" }],
                    source: { provider: "faux", api: "scripted", model: "test" },
                    usage: emptyUsage(), stopReason: "stop",
                }]).stream(request);
            } }),
            socketPath: join(root, "host.sock"), lockPath: join(root, "host.json"),
            sessionDirectory: join(root, "sessions"), eventLogDirectory: join(root, "logs"),
        });
        let client: AttachedAgentClient | undefined;
        try {
            const path = join(root, "session.jsonl");
            const agent = await host.registry.create({ id: "greet", workspace: root, sessionPath: path });
            client = await attachAgent({ socketPath: join(root, "host.sock"), agentId: agent.id });
            let visible = false;
            while (!visible) {
                const update = await client.receive(AbortSignal.timeout(10_000));
                visible = update.type === "history" && update.entries.some((entry) =>
                    entry.kind === "harness" && entry.text.includes("extension greeting")
                );
            }
            expect(requests).toHaveLength(0);
            for (let turn = 0; turn < 2; turn++) {
                client.send({ type: "prompt", content: "continue" });
                while ((await client.receive(AbortSignal.timeout(10_000))).type !== "turn_finished") {}
            }
            expect(requests).toHaveLength(2);
            const injected = (await SessionStore.open(path)).messages().filter((message) => message.internal);
            expect(injected).toHaveLength(1);
            expect(injected[0]?.content).toEqual([{ type: "text", text: "## Session start hook 1\n\ncommand: start\n\n## Session start hook 3\n\nextension greeting" }]);
            expect(requests[0]?.messages).toContainEqual(injected[0]);
            expect(warning).toHaveBeenCalledWith(expect.stringContaining("broken greeting"));
            expect(agent.failed).toBe(false);
            const logged = readFileSync(defaultHostLogPath(), "utf8").trim().split("\n").map((line) => JSON.parse(line));
            expect(logged).toContainEqual(expect.objectContaining({
                type: "session_start_hook_failed", sessionId: "greet", reason: "start", index: 2,
                error: expect.stringContaining("broken greeting"),
            }));
        } finally {
            client?.close();
            await host.close();
            warning.mockRestore();
            rmSync(root, { recursive: true, force: true });
        }
    },
);
