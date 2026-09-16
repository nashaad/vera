import { afterEach, expect, test } from "bun:test";
import {
    mkdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    defaultHostExtensionConfigs,
    EXPLORER_EXTENSION_ID,
    SESSION_IDENTITY_EXTENSION_ID,
} from "../../src/extensions/bundled-host.ts";
import { loadExtensionManifest } from "../../src/extensions/manifest.ts";
import {
    startExtensionRegistry,
    type ExtensionRegistryFailure,
} from "../../src/extensions/registry.ts";
import { agentNameKey, parseAgentName } from "../../extensions/session-identity/names.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("session identity is a default bundled host extension", () => {
    const [config] = defaultHostExtensionConfigs([]);
    expect(config?.enabled).toBe(true);
    expect(loadExtensionManifest(config!.path).manifest.id)
        .toBe(SESSION_IDENTITY_EXTENSION_ID);
    expect(defaultHostExtensionConfigs([
        SESSION_IDENTITY_EXTENSION_ID, EXPLORER_EXTENSION_ID, "vera.budget",
        "example.command-hooks", "example.plan",
    ]))
        .toEqual([]);
});

test("the bundled namer uses the public sessions.identity seam", async () => {
    const [config] = defaultHostExtensionConfigs([]);
    const registry = await startExtensionRegistry({
        extensions: [config!],
    });
    const provider = registry.sessionIdentity();
    expect(provider).toBeDefined();
    const identity = provider!.mint({ taken: () => false });
    expect(parseAgentName(identity.name)).not.toBeNull();
    expect(identity.key).toBe(agentNameKey(identity.name)!);
    expect(Object.keys(identity).sort()).toEqual(["key", "name"]);
    expect(provider!.keyOf?.(`${identity.name}:UAT-tester`)).toBe(identity.key);
    await registry.close();
});

test("duplicate session identity providers disable the later extension", async () => {
    const failures: ExtensionRegistryFailure[] = [];
    const first = createIdentityExtension("first.identity");
    const second = createIdentityExtension("second.identity");
    const registry = await startExtensionRegistry({
        extensions: [
            { path: first, enabled: true, config: {} },
            { path: second, enabled: true, config: {} },
        ],
        onFailure: (failure) => failures.push(failure),
    });
    expect(registry.sessionIdentity()?.mint({ taken: () => false }).name)
        .toBe("first:0001");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain("Duplicate session identity provider");
    await registry.close();
});

test("session identity registration is capability-gated", async () => {
    const failures: ExtensionRegistryFailure[] = [];
    const denied = createDirectory();
    writeFileSync(join(denied, "vera.extension.json"), JSON.stringify({
        id: "denied.identity",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities: ["commands.register"],
    }));
    writeFileSync(join(denied, "extension.ts"), `
        export function activate(vera) {
            vera.sessions.registerIdentity({
                mint() {
                    return { name: "x", key: "x", env: {} };
                },
            });
        }
    `);
    const registry = await startExtensionRegistry({
        extensions: [{ path: denied, enabled: true, config: {} }],
        onFailure: (failure) => failures.push(failure),
    });
    expect(registry.sessionIdentity()).toBeUndefined();
    expect(failures[0]?.message).toContain("sessions.identity");
    await registry.close();
});

function createIdentityExtension(id: string): string {
    const directory = createDirectory();
    writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
        id,
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities: ["sessions.identity"],
    }));
    writeFileSync(join(directory, "extension.ts"), `
        export function activate(vera) {
            vera.sessions.registerIdentity({
                mint() {
                    return {
                        name: ${JSON.stringify(id === "first.identity" ? "first:0001" : "second:0002")},
                        key: ${JSON.stringify(id === "first.identity" ? "first:0001" : "second:0002")},
                        env: {},
                    };
                },
            });
        }
    `);
    return directory;
}

function createDirectory(): string {
    const directory = join(
        tmpdir(),
        `vera-session-identity-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    mkdirSync(directory);
    temporaryDirectories.push(directory);
    return directory;
}
