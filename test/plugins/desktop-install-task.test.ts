import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePluginInstallTask, parsePluginInstallTaskReply, type PluginInstallTask } from "../../clients/desktop/src/plugin-install/task-protocol.ts";
import { parseRunMessage, parseTaskOutput, resultMessage, runMessage } from "../../clients/desktop/src/tasks/messages.ts";
import { runPluginInstallTask } from "../../clients/desktop/src/plugin-install/run-task.ts";
import { AGENT_PLUGIN_SCHEMA } from "../../src/plugins/naming.ts";

let roots: string[] = [];
const originalHome = process.env.VERA_HOME;

afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots = [];
    if (originalHome === undefined) delete process.env.VERA_HOME;
    else process.env.VERA_HOME = originalHome;
});

function setup(): { home: string; source: string } {
    const root = mkdtempSync(join(tmpdir(), "vera-plugin-task-"));
    roots.push(root);
    const home = join(root, "home");
    const source = join(root, "source");
    mkdirSync(join(source, "skills", "plunder"), { recursive: true });
    mkdirSync(join(source, "dev.vera", "agents"), { recursive: true });
    mkdirSync(join(home, "machine"), { recursive: true });
    writeFileSync(join(source, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "sea-chest", version: "1.0.0" }));
    writeFileSync(join(source, "skills", "plunder", "SKILL.md"), "---\nname: plunder\ndescription: >\n  Sail with it\nmetadata:\n  labels: [sail, reef]\n---\nSail.\n");
    writeFileSync(join(source, "dev.vera", "agents", "captain.md"), "---\ndescription: >\n  Navigate the reef\ntools: [read]\n---\nNavigate.\n");
    process.env.VERA_HOME = home;
    return { home, source };
}

test("plugin install task previews, installs, then refuses an invalid folder", () => {
    const { home, source } = setup();
    const preview = runPluginInstallTask({ kind: "preview", source });
    expect(preview.ok).toBe(true);
    expect(preview.ok && preview.preview).toMatchObject({ name: "sea-chest", version: "1.0.0", skills: ["plunder"], agents: ["captain"], warnings: [], needs_host_restart: false, needs_desktop_restart: false });
    expect(requirePluginRegistry(home)).toBe(false);

    const installed = runPluginInstallTask(structuredClone({ kind: "install", source } as PluginInstallTask));
    expect(installed.ok).toBe(true);
    expect(installed.ok && installed.result).toMatchObject({ preview: { name: "sea-chest", skills: ["plunder"] } });
    expect(requirePluginRegistry(home)).toBe(true);

    const invalid = join(home, "invalid-plugin");
    mkdirSync(invalid);
    const refused = runPluginInstallTask({ kind: "preview", source: invalid });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.reason).toContain("No plugin manifest");
});

test("plugin task previews and installs skills and agents in the Node runtime", async () => {
    const { home, source } = setup();
    const bundle = await Bun.build({
        entrypoints: [join(import.meta.dir, "../../clients/desktop/src/plugin-install/run-task.ts")],
        target: "node",
        format: "cjs",
    });
    expect(bundle.success).toBe(true);
    const path = join(home, "plugin-task.cjs");
    writeFileSync(path, await bundle.outputs[0]!.text());
    const script = 'const task = require(process.argv[1]); process.stdout.write(JSON.stringify(task.runPluginInstallTask({kind:process.argv[2],source:process.argv[3]})));';
    const run = (kind: string) => JSON.parse(execFileSync("node", ["-e", script, path, kind, source], {
        env: { ...process.env, VERA_HOME: home },
        encoding: "utf8",
    }));
    expect(run("preview")).toMatchObject({ ok: true, preview: { skills: ["plunder"], agents: ["captain"], warnings: [] } });
    expect(requirePluginRegistry(home)).toBe(false);
    expect(run("install")).toMatchObject({ ok: true, result: { preview: { skills: ["plunder"], agents: ["captain"], warnings: [] } } });
    expect(requirePluginRegistry(home)).toBe(true);
});

test("plugin task and reply survive structuredClone and JSON, malformed data is rejected", () => {
    const { source } = setup();
    const task: PluginInstallTask = { kind: "preview", source };
    const envelope = runMessage(task);
    for (const copy of [structuredClone(envelope), JSON.parse(JSON.stringify(envelope))]) {
        expect(parsePluginInstallTask(parseRunMessage(copy)?.task)).toEqual(task);
    }
    const reply = runPluginInstallTask(task);
    const answer = resultMessage(reply);
    for (const copy of [structuredClone(answer), JSON.parse(JSON.stringify(answer))]) {
        const output = parseTaskOutput(copy);
        expect(output?.type).toBe("result");
        expect(output?.type === "result" ? parsePluginInstallTaskReply(output.reply) : undefined).toEqual(reply);
    }
    for (const bad of [null, [], {}, { kind: "preview", source: "relative" }, { kind: "install", source: "" }, { kind: "other", source: "/tmp/plugin" }]) {
        expect(parsePluginInstallTask(bad)).toBeUndefined();
    }
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    const preview = reply.preview;
    const malformed = [
        null, [], {}, { ok: false }, { ok: false, reason: 3 }, { ok: true },
        { ok: true, preview: { ...preview, name: 4 } },
        { ok: true, preview: { ...preview, version: 42 } },
        { ok: true, preview: { ...preview, skills: [null] } },
        { ok: true, preview: { ...preview, agents: [42] } },
        { ok: true, preview: { ...preview, mcp: { servers: [{ name: "x", transport: "bad" }], skipped: [], notes: [] } } },
        { ok: true, preview: { ...preview, mcp: { servers: [], skipped: [{ name: "x", reason: 7 }], notes: [] } } },
        { ok: true, preview: { ...preview, mcp: { ...preview.mcp, servers: Array.from({ length: 2_001 }, () => ({ name: "x", transport: "stdio" })) } } },
        { ok: true, preview: { ...preview, mcp: { ...preview.mcp, skipped: Array.from({ length: 2_001 }, () => ({ name: "x", reason: "ignored" })) } } },
        { ok: true, preview: { ...preview, name: "x".repeat(257) } },
        { ok: true, preview: { ...preview, host_extension_id: 7 } },
        { ok: true, preview: { ...preview, desktop_extension_id: 7 } },
        { ok: true, preview: { ...preview, needs_host_restart: "yes" } },
        { ok: true, preview: { ...preview, needs_desktop_restart: 0 } },
        { ok: true, preview: { ...preview, mcp_enabled: "yes" } },
        { ok: true, preview: { ...preview, warnings: [4] } },
        { ok: true, preview, result: {} },
        { ok: true, preview, result: { preview: { ...preview, mcp_enabled: "yes" } } },
    ];
    for (const bad of malformed) expect(parsePluginInstallTaskReply(bad)).toBeUndefined();
});

function requirePluginRegistry(home: string): boolean {
    return existsSync(join(home, "machine", "plugins.json"));
}
