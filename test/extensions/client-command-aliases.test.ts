import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    startClientExtensionRegistry,
    type ClientExtensionConfig,
    type ClientExtensionModelSettingsAdapter,
    type ClientExtensionNoticeAdapter,
    type ClientExtensionPickerAdapter,
    type ClientExtensionPreferencesAdapter,
} from "../../src/extensions/client-registry.ts";

const directories: string[] = [];

afterEach(() => {
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function extensionDirectory(source: string): string {
    const directory = join(tmpdir(), `vera-command-alias-${crypto.randomUUID()}`);
    mkdirSync(directory);
    directories.push(directory);
    writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
        id: "client.alias",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities: ["client.commands.register"],
    }));
    writeFileSync(join(directory, "extension.ts"), source);
    return directory;
}

function adapters() {
    const preferences: ClientExtensionPreferencesAdapter = {
        async get() {
            return undefined;
        },
        async set() {},
        async delete() {},
    };
    const modelSettings: ClientExtensionModelSettingsAdapter = {
        current() {
            return undefined;
        },
        async update() {
            return { status: "rejected", reason: "invalid" } as const;
        },
        subscribe() {
            return () => {};
        },
    };
    const picker: ClientExtensionPickerAdapter = {
        async request() {
            return { outcome: "cancelled" } as const;
        },
    };
    const notice: ClientExtensionNoticeAdapter = {
        post() {},
    };
    return { preferences, modelSettings, picker, notice };
}

const ALIASED = `
    export function activateClient(vera) {
        vera.commands.register({
            name: "plugins",
            aliases: ["customize"],
            description: "Browse plugins",
            usage: "/plugins",
            run() { return { kind: "text", text: "opened" }; },
        });
    }
`;

test("an extension command keeps its alias on the descriptor, not as a second command", async () => {
    const registry = await startClientExtensionRegistry({
        extensions: [{ path: extensionDirectory(ALIASED), enabled: true, config: null }],
        ...adapters(),
    });

    expect(registry.commands().map((command) => command.name)).toEqual(["plugins"]);
    expect(registry.commands()[0]?.aliases).toEqual(["customize"]);
    await registry.close();
});

test("an alias cannot take a reserved command name", async () => {
    const failures: string[] = [];
    const registry = await startClientExtensionRegistry({
        extensions: [{ path: extensionDirectory(ALIASED), enabled: true, config: null }],
        ...adapters(),
        reservedCommandNames: ["customize"],
        onFailure(failure) {
            failures.push(failure.message);
        },
    });

    expect(registry.commands()).toEqual([]);
    expect(failures[0]).toContain("/customize");
    await registry.close();
});

test("an alias is a command name, not free text", async () => {
    const failures: string[] = [];
    const registry = await startClientExtensionRegistry({
        extensions: [{
            path: extensionDirectory(`
                export function activateClient(vera) {
                    vera.commands.register({
                        name: "plugins",
                        aliases: ["Customize Me"],
                        description: "Browse plugins",
                        usage: "/plugins",
                        run() { return { kind: "text", text: "opened" }; },
                    });
                }
            `),
            enabled: true,
            config: null,
        }],
        ...adapters(),
        onFailure(failure) {
            failures.push(failure.message);
        },
    });

    expect(registry.commands()).toEqual([]);
    expect(failures[0]).toContain("Invalid client extension command registration");
    await registry.close();
});
