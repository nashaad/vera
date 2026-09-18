import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadVeraConfig } from "../../src/config.ts";
import {
    digestExtensionDirectory,
    extensionDirectoryFor,
    installExtension,
    listExtensions,
    managedExtensionConfigs,
    ExtensionManagerError,
    extensionRegistryPathFor,
    removeExtension,
    setAnyExtensionEnabled,
    setExtensionEnabled,
} from "../../src/extensions/manager.ts";
import { includedExtensionIds } from "../../src/extensions/included.ts";

function temporaryExtension(id = "sample-extension"): {
    readonly root: string;
    readonly source: string;
} {
    const root = mkdtempSync(join(tmpdir(), "vera-extension-manager-"));
    const source = join(root, "source");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "vera.extension.json"), JSON.stringify({
        id,
        version: "1.2.3",
        sdk: "1",
        entrypoint: "extension.ts",
        capabilities: ["slash_commands", "context"],
    }));
    writeFileSync(join(source, "extension.ts"), "export default {};\n");
    writeFileSync(join(source, "README.txt"), "local extension\n");
    return { root, source };
}

test("install dry-run previews a local extension without writing state", () => {
    const { root, source } = temporaryExtension();
    const home = join(root, "home");
    try {
        const result = installExtension(source, {
            home,
            dryRun: true,
        });

        expect(result.record).toBeUndefined();
        expect(result.preview).toMatchObject({
            id: "sample-extension",
            version: "1.2.3",
            dryRun: true,
            capabilities: ["slash_commands", "context"],
        });
        expect(existsSync(extensionDirectoryFor({ home })))
            .toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("managed install records source and digest, and disabled copies stay on disk", () => {
    const { root, source } = temporaryExtension();
    const home = join(root, "home");
    try {
            const result = installExtension(source, { home });
        const directory = extensionDirectoryFor({ home });
        const installed = join(directory, "sample-extension");

        expect(result.record).toMatchObject({
            id: "sample-extension",
            version: "1.2.3",
            source: { kind: "local", path: source },
            digest: result.preview.digest,
            directory: "extensions/sample-extension",
            enabled: true,
        });
        expect(existsSync(installed)).toBe(true);
        expect(readFileSync(join(installed, "extension.ts"), "utf8"))
            .toContain("export default");
        expect(readdirSync(directory).some((name) => name.startsWith(".staging-")))
            .toBe(false);

        const disabled = setExtensionEnabled("sample-extension", false, { home });
        expect(disabled.enabled).toBe(false);
        expect(managedExtensionConfigs(directory)).toEqual([{
            path: installed,
            enabled: false,
            config: {},
        }]);
        expect(listExtensions({ home })).toEqual([expect.objectContaining({
            id: "sample-extension",
            enabled: false,
            managed: true,
            digest: result.preview.digest,
        })]);

        const enabled = setExtensionEnabled("sample-extension", true, { home });
        expect(enabled.enabled).toBe(true);
        expect(removeExtension("sample-extension", { home }).id)
            .toBe("sample-extension");
        expect(existsSync(installed)).toBe(false);
        expect(listExtensions({ home })).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("config loading uses the managed enabled state", () => {
    const { root, source } = temporaryExtension("config-extension");
    const home = join(root, "home");
    const configPath = join(home, ".vera", "config.json");
    try {
        mkdirSync(join(home, ".vera"), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "test/model",
        }));
        installExtension(source, { home });

        setExtensionEnabled("config-extension", false, { home });
        expect(loadVeraConfig({ path: configPath }).extensions).toEqual([{
            path: join(extensionDirectoryFor({ home }), "config-extension"),
            enabled: false,
            config: {},
        }]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test("registry paths are exact and cannot rename the whole extensions tree", () => {
    const { root, source } = temporaryExtension("safe-extension");
    const home = join(root, "home");
    try {
        installExtension(source, { home });
        const registryPath = extensionRegistryPathFor({ home });
        const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
            extensions: Array<Record<string, unknown>>;
        };
        registry.extensions[0]!.directory = "extensions/.";
        writeFileSync(registryPath, JSON.stringify({
            schema_version: 1,
            extensions: registry.extensions,
        }));
        expect(() => removeExtension("safe-extension", { home }))
            .toThrow(ExtensionManagerError);
        expect(existsSync(extensionDirectoryFor({ home }))).toBe(true);
        expect(existsSync(join(extensionDirectoryFor({ home }), "safe-extension")))
            .toBe(true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("managed markers preserve disabled state when the central registry disappears", () => {
    const { root, source } = temporaryExtension("marker-extension");
    const home = join(root, "home");
    try {
        installExtension(source, { home });
        setExtensionEnabled("marker-extension", false, { home });
        rmSync(extensionRegistryPathFor({ home }));
        expect(managedExtensionConfigs(extensionDirectoryFor({ home })))
            .toEqual([{
                path: join(extensionDirectoryFor({ home }), "marker-extension"),
                enabled: false,
                config: {},
            }]);
        expect(listExtensions({ home })[0]?.enabled).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("managed disabled state wins over an explicit config entry for the same path", () => {
    const { root, source } = temporaryExtension("explicit-extension");
    const home = join(root, "home");
    const configPath = join(home, ".vera", "config.json");
    try {
        mkdirSync(join(home, ".vera"), { recursive: true });
        installExtension(source, { home });
        writeFileSync(configPath, JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "test/model",
            extensions: [{
                path: join(extensionDirectoryFor({ home }), "explicit-extension"),
                enabled: true,
                config: {},
            }],
        }));
        setExtensionEnabled("explicit-extension", false, { home });
        expect(loadVeraConfig({ path: configPath }).extensions?.[0]?.enabled)
            .toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("stale managed records can be removed and reinstalled", () => {
    const { root, source } = temporaryExtension("stale-extension");
    const home = join(root, "home");
    try {
        installExtension(source, { home });
        rmSync(join(extensionDirectoryFor({ home }), "stale-extension"), {
            recursive: true,
        });
        expect(removeExtension("stale-extension", { home }).id)
            .toBe("stale-extension");
        expect(installExtension(source, { home }).record?.id)
            .toBe("stale-extension");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("source symlinks are rejected", () => {
    const { root, source } = temporaryExtension("symlink-extension");
    const home = join(root, "home");
    try {
        symlinkSync(join(source, "extension.ts"), join(source, "linked.ts"));
        expect(() => installExtension(source, { home }))
            .toThrow("Symlinks are not supported");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("extension mutations refuse a live registry lock and reclaim a dead one", () => {
    const { root, source } = temporaryExtension("locked-extension");
    const home = join(root, "home");
    const lockPath = `${extensionRegistryPathFor({ home })}.lock`;
    try {
        mkdirSync(join(home, ".vera"), { recursive: true });
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
        expect(() => installExtension(source, { home }))
            .toThrow("Another extension operation");
        writeFileSync(lockPath, JSON.stringify({ pid: 999_999 }));
        expect(installExtension(source, { home }).record?.id)
            .toBe("locked-extension");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("extension digest is deterministic and includes file content", () => {
    const { root, source } = temporaryExtension("digest-extension");
    try {
        const first = digestExtensionDirectory(source);
        const second = digestExtensionDirectory(source);
        expect(first).toBe(second);
        writeFileSync(join(source, "extension.ts"), "export default { changed: true };\n");
        expect(digestExtensionDirectory(source)).not.toBe(first);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("included extensions switch through the disabled list in config.json", () => {
    const root = mkdtempSync(join(tmpdir(), "vera-extension-manager-"));
    const home = join(root, "home");
    mkdirSync(join(home, ".vera"), { recursive: true });
    const configPath = join(home, ".vera", "config.json");
    try {
        expect(setAnyExtensionEnabled("vera.btw", false, { home })).toEqual({ id: "vera.btw" });
        expect(loadVeraConfig({ path: configPath }).disabled_included_extensions).toEqual(["vera.btw"]);
        setAnyExtensionEnabled("vera.btw", false, { home });
        expect(loadVeraConfig({ path: configPath }).disabled_included_extensions).toEqual(["vera.btw"]);
        setAnyExtensionEnabled("vera.btw", true, { home });
        expect(loadVeraConfig({ path: configPath }).disabled_included_extensions).toEqual([]);
        expect(() => setAnyExtensionEnabled("vera.nothing", false, { home })).toThrow(
            "No managed extension named vera.nothing is installed",
        );
        expect(() => setAnyExtensionEnabled("acme.missing", false, { home })).toThrow(
            "No managed extension named acme.missing is installed",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("every included extension uses the vera. prefix", () => {
    for (const id of includedExtensionIds()) {
        expect(id.startsWith("vera.")).toBe(true);
    }
});
