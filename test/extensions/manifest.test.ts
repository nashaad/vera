import { expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    EXTENSION_MANIFEST_FILENAME,
    loadExtensionManifest,
    parseExtensionManifest,
} from "../../src/extensions/manifest.ts";

test("an extension manifest declares one runtime entrypoint", () => {
    expect(parseExtensionManifest({
        id: "acme.context-tools",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities: [
            "commands.register",
            "models.complete",
        ],
    })).toEqual({
        id: "acme.context-tools",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities: [
            "commands.register",
            "models.complete",
        ],
    });
});

test("manifest identity, SDK, entrypoint, and capabilities are explicit", () => {
    for (const manifest of [
        {},
        validManifest({ id: "Context Tools" }),
        validManifest({ version: "" }),
        validManifest({ sdk: "2" }),
        validManifest({ entrypoint: "/tmp/extension.ts" }),
        validManifest({ capabilities: "commands.register" }),
        validManifest({ capabilities: ["commands.register", ""] }),
        validManifest({
            capabilities: ["commands.register", "commands.register"],
        }),
    ]) {
        expect(parseExtensionManifest(manifest)).toBeUndefined();
    }
});

test("loading resolves a real entrypoint inside the extension directory", () => {
    const directory = temporaryExtension();
    const loaded = loadExtensionManifest(directory);
    const canonicalDirectory = realpathSync(directory);

    expect(loaded.directory).toBe(canonicalDirectory);
    expect(loaded.manifestPath).toBe(
        join(canonicalDirectory, EXTENSION_MANIFEST_FILENAME),
    );
    expect(loaded.entrypointPath).toBe(
        join(canonicalDirectory, "extension.ts"),
    );
    expect(loaded.manifest.id).toBe("acme.context-tools");
});

test("an entrypoint cannot leave through a relative path or symlink", () => {
    const parent = mkdtempSync(join(tmpdir(), "vera-extension-parent-"));
    const outside = join(parent, "outside.ts");
    writeFileSync(outside, "export default function activate() {}\n");

    const relativeDirectory = join(parent, "relative");
    mkdirSync(relativeDirectory);
    writeFileSync(
        join(relativeDirectory, EXTENSION_MANIFEST_FILENAME),
        JSON.stringify(validManifest({ entrypoint: "../outside.ts" })),
    );
    expect(() => loadExtensionManifest(relativeDirectory)).toThrow(
        "entrypoint leaves its directory",
    );

    const symlinkDirectory = join(parent, "symlink");
    mkdirSync(symlinkDirectory);
    symlinkSync(outside, join(symlinkDirectory, "extension.ts"));
    writeFileSync(
        join(symlinkDirectory, EXTENSION_MANIFEST_FILENAME),
        JSON.stringify(validManifest()),
    );
    expect(() => loadExtensionManifest(symlinkDirectory)).toThrow(
        "entrypoint must be a file inside",
    );
});

test("a manifest cannot leave through a symlink", () => {
    const parent = mkdtempSync(join(tmpdir(), "vera-manifest-parent-"));
    const directory = join(parent, "extension");
    mkdirSync(directory);
    writeFileSync(
        join(parent, "outside.json"),
        JSON.stringify(validManifest()),
    );
    writeFileSync(
        join(directory, "extension.ts"),
        "export default function activate() {}\n",
    );
    symlinkSync(
        join(parent, "outside.json"),
        join(directory, EXTENSION_MANIFEST_FILENAME),
    );

    expect(() => loadExtensionManifest(directory)).toThrow(
        "manifest must be a file inside",
    );
});

test("an internal path whose name begins with two dots is still contained", () => {
    const directory = mkdtempSync(join(tmpdir(), "vera-extension-hidden-"));
    const hiddenDirectory = join(directory, "..hidden");
    mkdirSync(hiddenDirectory);
    writeFileSync(
        join(directory, EXTENSION_MANIFEST_FILENAME),
        JSON.stringify(validManifest({
            entrypoint: "./..hidden/extension.ts",
        })),
    );
    writeFileSync(
        join(hiddenDirectory, "extension.ts"),
        "export default function activate() {}\n",
    );

    expect(loadExtensionManifest(directory).entrypointPath).toBe(
        join(realpathSync(directory), "..hidden", "extension.ts"),
    );
});

function temporaryExtension(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-extension-"));
    writeFileSync(
        join(directory, EXTENSION_MANIFEST_FILENAME),
        JSON.stringify(validManifest()),
    );
    writeFileSync(
        join(directory, "extension.ts"),
        "export default function activate() {}\n",
    );
    return directory;
}

function validManifest(
    patch: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        id: "acme.context-tools",
        version: "1.0.0",
        sdk: "1",
        entrypoint: "./extension.ts",
        capabilities: ["commands.register"],
        ...patch,
    };
}
