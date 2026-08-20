import { expect, test } from "bun:test";

import { runCli } from "../../clients/cli/main.ts";
import {
    parseExtensionManagerCommand,
    renderExtensionList,
    tokenizeExtensionManagerArguments,
} from "../../src/extensions/manager-command.ts";
import type {
    ExtensionManagerOptions,
    ExtensionManagerTarget,
} from "../../src/extensions/manager.ts";

test("extension manager command parsing keeps profile default and explicit project scope", () => {
    expect(parseExtensionManagerCommand([
        "extension", "install", "./local-extension", "--dry-run",
    ])).toEqual({
        command: {
            operation: "install",
            source: "./local-extension",
            scope: "profile",
            dryRun: true,
        },
    });
    expect(parseExtensionManagerCommand([
        "extension", "disable", "sample.extension", "--project",
    ])).toEqual({
        command: {
            operation: "disable",
            id: "sample.extension",
            scope: "project",
        },
    });
    expect(parseExtensionManagerCommand(["extension", "reload"])).toEqual({
        command: { operation: "reload" },
    });
    expect(parseExtensionManagerCommand(["extension", "remove"])).toEqual({
        error: "Usage: vera extension remove <id> [--project]",
    });
});

test("extension command tokenization preserves quoted local paths", () => {
    expect(tokenizeExtensionManagerArguments(
        `install "/tmp/My Local Extension" --dry-run`,
    )).toEqual({
        words: ["install", "/tmp/My Local Extension", "--dry-run"],
    });
    expect(tokenizeExtensionManagerArguments("install 'unfinished"))
        .toEqual({ error: "Unclosed quote in extension command" });
});

test("extension CLI renders dry-run plans and delegates mutations", async () => {
    let output = "";
    let errorOutput = "";
    const calls: string[] = [];
    const extensionManager = {
        install: (
            source: string,
            target: ExtensionManagerTarget,
            options: ExtensionManagerOptions & { readonly dryRun?: boolean } = {},
        ) => {
            calls.push(`install:${source}:${target.scope}:${options.dryRun === true}`);
            return {
                preview: {
                    scope: target.scope as "profile" | "project",
                    id: "sample.extension",
                    version: "1.0.0",
                    source,
                    destination: "/managed/extensions/sample.extension",
                    digest: "sha256:abc",
                    capabilities: ["context"],
                    dryRun: options.dryRun === true,
                },
            };
        },
        list: () => [{
            scope: "profile" as const,
            id: "sample.extension",
            version: "1.0.0",
            enabled: true,
            managed: true,
            path: "/managed/extensions/sample.extension",
            digest: "sha256:abc",
            capabilities: ["context"],
        }],
        setEnabled: (id: string, enabled: boolean) => {
            calls.push(`set:${id}:${enabled}`);
            return {
                id,
                version: "1.0.0",
                source: { kind: "local" as const, path: "/source" },
                digest: "sha256:abc",
                directory: "extensions/sample.extension",
                enabled,
                installedAt: "2026-08-20T00:00:00.000Z",
            };
        },
        remove: (id: string) => {
            calls.push(`remove:${id}`);
            return {
                id,
                version: "1.0.0",
                source: { kind: "local" as const, path: "/source" },
                digest: "sha256:abc",
                directory: "extensions/sample.extension",
                enabled: true,
                installedAt: "2026-08-20T00:00:00.000Z",
            };
        },
    };

    expect(await runCli(["extension", "install", "/source", "--dry-run"], {
        extensionManager,
        stdout: { write: (text) => output += text },
        stderr: { write: (text) => errorOutput += text },
    })).toBe(0);
    expect(output).toContain("Extension install plan (dry run)");
    expect(output).toContain("sha256:abc");
    expect(errorOutput).toBe("");

    output = "";
    expect(await runCli(["extension", "list"], {
        extensionManager,
        stdout: { write: (text) => output += text },
    })).toBe(0);
    expect(output).toContain("sample.extension");
    expect(renderExtensionList(extensionManager.list())).toBe(output);

    expect(await runCli(["extension", "disable", "sample.extension"], {
        extensionManager,
        stdout: { write() {} },
    })).toBe(0);
    expect(await runCli(["extension", "remove", "sample.extension"], {
        extensionManager,
        stdout: { write() {} },
    })).toBe(0);
    expect(calls).toEqual([
        "install:/source:profile:true",
        "set:sample.extension:false",
        "remove:sample.extension",
    ]);
});
