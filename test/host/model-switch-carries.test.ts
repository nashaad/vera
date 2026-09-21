import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { modelSwitchCommand } from "../../clients/tui/model-switch-command.ts";
import { loadVeraConfig } from "../../src/config.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { startResidentHost } from "../../src/host/runtime.ts";
import { VERA_HOME_ENV } from "../../src/profile-paths.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

interface Attachment {
    receive(): Promise<AgentUpdate>;
    send(command: unknown): void;
}

async function receiveSettings(attachment: Attachment, requestId: string): Promise<AgentUpdate> {
    while (true) {
        const update = await attachment.receive();
        if ((update.type === "model_settings" || update.type === "model_settings_rejected")
            && update.requestId === requestId) return update;
    }
}

test("a TUI model switch is what a fresh conversation starts on after a host restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-switch-carries-"));
    const previousHome = process.env[VERA_HOME_ENV];
    process.env[VERA_HOME_ENV] = root;
    const configPath = join(root, "config.json");
    await writeFile(configPath, JSON.stringify({
        schema_version: 1,
        provider: "openrouter",
        model: "first-model",
        approval_mode: "auto",
    }));
    const start = () => startResidentHost({
        config: loadVeraConfig({ path: configPath }),
        createAdapter: () => new FauxAdapter([]),
        socketPath: join(root, "host.sock"),
        lockPath: join(root, "host.json"),
        sessionDirectory: join(root, "sessions"),
    });
    try {
        const first = await start();
        try {
            const agent = await first.registry.create({
                id: "before-restart",
                workspace: root,
                sessionPath: join(root, "before.jsonl"),
            });
            const attachment = agent.attach() as unknown as Attachment;
            expect((await attachment.receive()).type).toBe("history");
            const command = modelSwitchCommand({ provider: "openrouter", model: "second-model" });
            attachment.send(command);
            expect((await receiveSettings(attachment, command.requestId)).type).toBe("model_settings");
        } finally {
            await first.close();
        }
        expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ model: "second-model" });

        const second = await start();
        try {
            const fresh = await second.registry.create({
                id: "after-restart",
                workspace: root,
                sessionPath: join(root, "after.jsonl"),
            });
            const attachment = fresh.attach() as unknown as Attachment;
            expect((await attachment.receive()).type).toBe("history");
            attachment.send({ type: "get_model_settings", requestId: "fresh" });
            expect(await receiveSettings(attachment, "fresh")).toMatchObject({
                type: "model_settings",
                settings: { provider: "openrouter", model: "second-model" },
            });
        } finally {
            await second.close();
        }
    } finally {
        if (previousHome === undefined) delete process.env[VERA_HOME_ENV];
        else process.env[VERA_HOME_ENV] = previousHome;
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);
