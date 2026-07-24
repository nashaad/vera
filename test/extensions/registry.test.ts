import {
    afterEach,
    expect,
    test,
} from "bun:test";
import {
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VeraExtensionConfig } from "../../src/config.ts";
import {
    startExtensionRegistry,
    type ExtensionRegistryFailure,
} from "../../src/extensions/registry.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("registry loads enabled extensions in order and invokes by workspace", async () => {
    const workspace = createDirectory();
    const cleanupPath = join(workspace, "cleanup.txt");
    const first = createExtension("first.extension", `
        import { appendFile } from "node:fs/promises";
        export function activate(vera) {
            vera.commands.register({
                name: "alpha",
                description: "Alpha",
                usage: "/alpha",
                run({ workspace }) {
                    return { kind: "text", text: workspace };
                },
            });
            vera.onDispose(() =>
                appendFile(${JSON.stringify(cleanupPath)}, "first\\n")
            );
        }
    `);
    const disabled = createExtension("disabled.extension", `
        export function activate() {
            throw new Error("must not load");
        }
    `);
    const second = createExtension("second.extension", `
        import { appendFile } from "node:fs/promises";
        export function activate(vera) {
            vera.commands.register({
                name: "beta",
                description: "Beta",
                usage: "/beta",
                run() { return { kind: "notice", level: "info", text: "ok" }; },
            });
            vera.onDispose(() =>
                appendFile(${JSON.stringify(cleanupPath)}, "second\\n")
            );
        }
    `);
    const registry = await startExtensionRegistry({
        extensions: [
            configured(first),
            configured(disabled, false),
            configured(second),
        ],
    });

    expect(registry.commands().map((command) => command.name)).toEqual([
        "alpha",
        "beta",
    ]);
    await expect(registry.invokeCommand(
        "alpha",
        "",
        workspace,
    )).resolves.toMatchObject({
        source: "first.extension/alpha",
        body: { kind: "text", text: workspace },
    });
    await registry.close();
    expect(readFileSync(cleanupPath, "utf8")).toBe("second\nfirst\n");
});

test("registry isolates duplicate IDs and command collisions", async () => {
    const first = createExtension("same.extension", commandSource(
        "shared",
        "first",
    ));
    const duplicateId = createExtension(
        "same.extension",
        commandSource("other", "duplicate"),
    );
    const collision = createExtension(
        "collision.extension",
        commandSource("shared", "collision"),
    );
    const failures: ExtensionRegistryFailure[] = [];
    const registry = await startExtensionRegistry({
        extensions: [
            configured(first),
            configured(duplicateId),
            configured(collision),
        ],
        onFailure: (failure) => failures.push(failure),
    });

    expect(registry.commands()).toHaveLength(1);
    await expect(registry.invokeCommand(
        "shared",
        "",
        createDirectory(),
    )).resolves.toMatchObject({
        body: { kind: "text", text: "first" },
    });
    expect(failures.map((failure) => failure.message)).toEqual([
        "Duplicate extension ID: same.extension",
        expect.stringContaining("collides with same.extension"),
    ]);
    await registry.close();
});

test("registry reports a broken extension and keeps later extensions", async () => {
    const broken = createExtension("broken.extension", `
        export function activate() {
            throw new Error("broken load");
        }
    `);
    const healthy = createExtension(
        "healthy.extension",
        commandSource("healthy", "ready"),
    );
    const failures: ExtensionRegistryFailure[] = [];
    const registry = await startExtensionRegistry({
        extensions: [configured(broken), configured(healthy)],
        onFailure: (failure) => failures.push(failure),
    });

    expect(registry.commands().map((command) => command.name)).toEqual([
        "healthy",
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain("broken load");
    await registry.close();
});

test("registry rejects collisions with bundled client commands", async () => {
    const collision = createExtension(
        "collision.extension",
        commandSource("help", "not bundled"),
    );
    const failures: ExtensionRegistryFailure[] = [];
    const registry = await startExtensionRegistry({
        extensions: [configured(collision)],
        onFailure: (failure) => failures.push(failure),
    });

    expect(registry.commands()).toEqual([]);
    expect(failures[0]?.message).toContain(
        "/help from collision.extension collides with a bundled client command",
    );
    await registry.close();
});

test("registry removes commands after an unexpected child exit", async () => {
    const crashing = createExtension("crashing.extension", `
        export function activate(vera) {
            vera.commands.register({
                name: "crash",
                description: "Crash",
                usage: "/crash",
                run() {
                    process.exit(7);
                },
            });
        }
    `);
    const failures: ExtensionRegistryFailure[] = [];
    const registry = await startExtensionRegistry({
        extensions: [configured(crashing)],
        onFailure: (failure) => failures.push(failure),
    });

    await expect(registry.invokeCommand(
        "crash",
        "",
        createDirectory(),
    )).rejects.toThrow();
    await waitFor(() => registry.commands().length === 0);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.extensionId).toBe("crashing.extension");
    await expect(registry.invokeCommand(
        "crash",
        "",
        createDirectory(),
    )).rejects.toThrow("unavailable");
    await expect(registry.close()).rejects.toThrow("exited");
});

function createExtension(
    id: string,
    source: string,
): string {
    const directory = createDirectory();
    writeFileSync(join(directory, "vera.extension.json"), JSON.stringify({
        id,
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities: ["commands.register"],
    }));
    writeFileSync(join(directory, "extension.ts"), source);
    return directory;
}

function commandSource(name: string, text: string): string {
    return `
        export function activate(vera) {
            vera.commands.register({
                name: ${JSON.stringify(name)},
                description: "Test command",
                usage: "/${name}",
                run() { return { kind: "text", text: ${JSON.stringify(text)} }; },
            });
        }
    `;
}

function configured(
    path: string,
    enabled: boolean = true,
): VeraExtensionConfig {
    return { path, enabled, config: null };
}

function createDirectory(): string {
    const directory = join(
        tmpdir(),
        `vera-extension-registry-${crypto.randomUUID()}`,
    );
    mkdirSync(directory);
    temporaryDirectories.push(directory);
    return directory;
}

async function waitFor(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) {
            return;
        }
        await Bun.sleep(5);
    }
    throw new Error("condition was not reached");
}
