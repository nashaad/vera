import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadVeraConfig, type VeraConfig } from "../../src/config.ts";

export interface TransferHookEvent {
    readonly source: "command" | "extension";
    readonly type: "session_start" | "session_end";
    readonly reason: string;
    readonly pid: number;
}

export async function installTransferHooks(home: string): Promise<{ readonly config: VeraConfig; readonly log: string; readonly updates: string }> {
    const hooks = join(home, "hooks");
    const extension = join(home, "extensions", "transfer-hooks");
    const log = join(home, "hook-events.jsonl");
    const updates = join(home, "session-updates.jsonl");
    await mkdir(hooks, { recursive: true });
    await mkdir(extension, { recursive: true });
    const command = join(hooks, "record-lifecycle");
    await writeFile(command, `#!${process.execPath}\n`
        + `import { appendFileSync } from "node:fs";\n`
        + `const event = await Bun.stdin.json();\n`
        + `appendFileSync(${JSON.stringify(log)}, JSON.stringify({source: "command", type: event.type, reason: event.reason, pid: process.pid}) + "\\n");\n`
        + `if (event.type === "session_start") console.log(JSON.stringify({power: "mutate", context: "command: " + event.reason}));\n`);
    await chmod(command, 0o755);
    await writeFile(join(extension, "vera.extension.json"), JSON.stringify({
        id: "test.transfer-hooks", sdk: "1", version: "1.0.0", entrypoint: "extension.ts",
        capabilities: ["hooks.session_start", "hooks.session_end", "hooks.session_updated"],
    }));
    await writeFile(join(extension, "extension.ts"), `import { appendFileSync } from "node:fs";\n`
        + `export function activate(api) {\n`
        + `  const record = (event) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({source: "extension", type: event.type, reason: event.reason, pid: process.pid}) + "\\n");\n`
        + `  api.hooks.registerSessionStart((event) => { record(event); return {power: "mutate", context: "extension: " + event.reason}; });\n`
        + `  api.hooks.registerSessionEnd(record);\n`
        + `  api.hooks.registerSessionUpdated((event) => appendFileSync(${JSON.stringify(updates)}, JSON.stringify(event) + "\\n"));\n`
        + `}\n`);
    const path = join(home, "config.json");
    await writeFile(path, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "faux/test",
        approval_mode: "auto",
        hooks: [
            { phase: "session_start", argv: ["record-lifecycle"] },
            { phase: "session_end", argv: ["record-lifecycle"] },
        ],
        extensions: [{ path: extension, enabled: true, config: {} }],
    }));
    return { config: loadVeraConfig({ path }), log, updates };
}

export async function transferHookEvents(path: string): Promise<TransferHookEvent[]> {
    const contents = await readFile(path, "utf8").catch(() => "");
    return contents.trim().length === 0
        ? []
        : contents.trim().split("\n").map((line) => JSON.parse(line) as TransferHookEvent);
}

export async function waitForTransferHooks(path: string, count: number): Promise<TransferHookEvent[]> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const events = await transferHookEvents(path);
        if (events.length >= count) return events;
        await Bun.sleep(10);
    }
    throw new Error(`Timed out waiting for ${count} lifecycle hook events`);
}
