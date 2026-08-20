import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
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
    projectExtensionDirectory,
    removeExtension,
    setExtensionEnabled,
} from "../../src/extensions/manager.ts";

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
        const result = installExtension(source, { scope: "profile" }, {
            home,
            dryRun: true,
        });

        expect(result.record).toBeUndefined();
        expect(result.preview).toMatchObject({
            id: "sample-extension",
            version: "1.2.3",
            scope: "profile",
            dryRun: true,
            capabilities: ["slash_commands", "context"],
        });
        expect(existsSync(extensionDirectoryFor({ scope: "profile" }, { home })))
            .toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("managed install records source and digest, and disabled copies stay on disk", () => {
    const { root, source } = temporaryExtension();
    const home = join(root, "home");
    try {
        const target = { scope: "profile" as const };
        const result = installExtension(source, target, { home });
        const directory = extensionDirectoryFor(target, { home });
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

        const disabled = setExtensionEnabled("sample-extension", false, target, { home });
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

        const enabled = setExtensionEnabled("sample-extension", true, target, { home });
        expect(enabled.enabled).toBe(true);
        expect(removeExtension("sample-extension", target, { home }).id)
            .toBe("sample-extension");
        expect(existsSync(installed)).toBe(false);
        expect(listExtensions({ home })).toEqual([]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("project installs use an explicit .vera scope and list alongside profile installs", () => {
    const { root, source } = temporaryExtension("project-extension");
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    try {
        const result = installExtension(
            source,
            { scope: "project", projectRoot },
            { home },
        );

        expect(result.preview.scope).toBe("project");
        expect(result.preview.projectRoot).toBe(projectRoot);
        expect(result.preview.destination).toBe(
            join(projectExtensionDirectory(projectRoot), "project-extension"),
        );
        expect(listExtensions({ home, projectRoot })).toEqual([
            expect.objectContaining({
                scope: "project",
                id: "project-extension",
                managed: true,
                enabled: true,
            }),
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("config loading uses managed enabled state for profile and project scopes", () => {
    const { root, source } = temporaryExtension("config-extension");
    const home = join(root, "home");
    const projectRoot = join(root, "project");
    const configPath = join(home, ".vera", "profiles", "default", "config.json");
    try {
        mkdirSync(join(home, ".vera", "profiles", "default"), { recursive: true });
        writeFileSync(configPath, JSON.stringify({
            schema_version: 1,
            provider: "openrouter",
            model: "test/model",
        }));
        installExtension(source, { scope: "profile" }, { home });
        installExtension(source, { scope: "project", projectRoot }, { home });

        setExtensionEnabled("config-extension", false, { scope: "profile" }, { home });
        expect(loadVeraConfig({ path: configPath, projectRoot }).extensions)
            .toEqual([
                {
                    path: join(home, ".vera", "profiles", "default", "extensions", "config-extension"),
                    enabled: false,
                    config: {},
                },
                {
                    path: join(projectRoot, ".vera", "extensions", "config-extension"),
                    enabled: true,
                    config: {},
                },
            ]);
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
