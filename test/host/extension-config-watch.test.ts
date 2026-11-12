import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    activeExtensionConfigWatches,
    createExtensionConfigWatch,
    diffExtensionConfigEntries,
    extensionConfigNoticeText,
    type ExtensionConfigChange,
    type ExtensionConfigEntry,
} from "../../src/host/extension-config-watch.ts";
import { EXTENSION_MANIFEST_FILENAME } from "../../src/extensions/manifest.ts";
import type { VeraConfig } from "../../src/config.ts";

const homes: string[] = [];

afterEach(() => {
    for (const home of homes.splice(0)) {
        rmSync(home, { recursive: true, force: true });
    }
});

function entry(
    id: string,
    path: string,
    enabled = true,
    servesHost = true,
): ExtensionConfigEntry {
    return { id, path, enabled, servesHost };
}

function entries(...items: ExtensionConfigEntry[]): Map<string, ExtensionConfigEntry> {
    return new Map(items.map((item) => [item.id, item]));
}

test("the diff names each change and whether the running host differs", () => {
    const before = entries(
        entry("acme.a", "/a"),
        entry("acme.b", "/b"),
        entry("acme.c", "/c"),
    );
    const after = entries(
        entry("acme.b", "/b"),
        entry("acme.c", "/c-moved"),
        entry("acme.d", "/d"),
    );
    expect(diffExtensionConfigEntries(before, after, before)).toEqual([
        { operation: "disable", id: "acme.a", needsRestart: true },
        { operation: "update", id: "acme.c", needsRestart: true },
        { operation: "enable", id: "acme.d", needsRestart: true },
    ]);
});

test("a client-only change needs no host restart", () => {
    const before = entries(entry("acme.notes", "/notes", true, false));
    const changes = diffExtensionConfigEntries(before, new Map(), before);
    expect(changes).toEqual([
        { operation: "disable", id: "acme.notes", needsRestart: false },
    ]);
    expect(extensionConfigNoticeText(changes[0]!)).toBe("Disabled acme.notes.");
});

test("a disabled entry that comes or goes changes nothing", () => {
    const before = entries(entry("acme.a", "/a", false));
    expect(diffExtensionConfigEntries(before, new Map(), before)).toEqual([]);
    expect(diffExtensionConfigEntries(new Map(), before, before)).toEqual([]);
});

test("notice text matches the picker wording", () => {
    expect(extensionConfigNoticeText({
        operation: "enable",
        id: "acme.a",
        needsRestart: true,
    })).toBe("Enabled acme.a. Use Reconnect host (Ctrl+P) to load it.");
    expect(extensionConfigNoticeText({
        operation: "disable",
        id: "acme.a",
        needsRestart: true,
    })).toBe("Disabled acme.a. Use Reconnect host (Ctrl+P) to unload it.");
    expect(extensionConfigNoticeText({
        operation: "update",
        id: "acme.a",
        needsRestart: true,
    })).toBe("Updated acme.a. Use Reconnect host (Ctrl+P) to apply it.");
});

test("the watch reads config only after the stamp changes and stops with the host", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-extwatch-"));
    homes.push(home);
    const configPath = join(home, "config.json");
    writeFileSync(configPath, "{\"schema_version\":1}\n");
    const extension = writeExtension(join(home, "acme"), "acme.notes");
    let config: Pick<VeraConfig, "extensions"> = {
        extensions: [{ path: extension, enabled: true, config: {} }],
    };
    let reads = 0;
    const deltas: (readonly ExtensionConfigChange[])[] = [];
    const watch = createExtensionConfigWatch({
        configPath,
        config,
        currentConfig: () => {
            reads += 1;
            return config;
        },
        intervalMs: 5,
    });
    watch.start((changes) => deltas.push([...changes]));
    try {
        // One read at construction establishes the drift; ticks read only on a stamp change.
        expect(reads).toBe(1);
        await Bun.sleep(30);
        expect(reads).toBe(1);

        config = { extensions: [] };
        writeFileSync(
            configPath,
            "{\"schema_version\":1,\"extensions\":[]}\n",
        );
        await until(() => deltas.length > 0);
        expect(reads).toBe(2);
        expect(deltas[0]).toEqual([
            { operation: "disable", id: "acme.notes", needsRestart: true },
        ]);
        expect(watch.drift()).toEqual([
            { operation: "disable", id: "acme.notes", needsRestart: true },
        ]);

        watch.stop();
        expect(activeExtensionConfigWatches()).toBe(0);
        writeFileSync(
            configPath,
            "{\"schema_version\":1,\"extensions\":[],\"note\":1}\n",
        );
        await Bun.sleep(30);
        expect(reads).toBe(2);
    } finally {
        watch.stop();
    }
});

test("a worker that starts after the edit already holds the drift", () => {
    const home = mkdtempSync(join(tmpdir(), "vera-extwatch-"));
    homes.push(home);
    const configPath = join(home, "config.json");
    writeFileSync(configPath, "{\"schema_version\":1}\n");
    const extension = writeExtension(join(home, "acme"), "acme.notes");
    const watch = createExtensionConfigWatch({
        configPath,
        config: { extensions: [{ path: extension, enabled: true, config: {} }] },
        currentConfig: () => ({ extensions: [] }),
    });
    expect(watch.drift()).toEqual([
        { operation: "disable", id: "acme.notes", needsRestart: true },
    ]);
    watch.stop();
});

function writeExtension(directory: string, id: string): string {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, EXTENSION_MANIFEST_FILENAME), JSON.stringify({
        id,
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities: ["commands.register"],
    }));
    writeFileSync(join(directory, "extension.ts"), "export function activate() {}\n");
    return directory;
}

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
        if (Date.now() - started > timeoutMs) {
            throw new Error("timed out waiting for the config watch");
        }
        await Bun.sleep(10);
    }
}
