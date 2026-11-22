import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extensionsDirectory, isFolderName, readExtensionMain } from "../../clients/desktop/src/extension-files.ts";
import { MAX_MAIN_BYTES } from "../../clients/ui/src/protocol/desktop-extensions.ts";

let home: string;
let directory: string;

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "vera-extension-files-"));
    directory = extensionsDirectory(home);
    await mkdir(directory, { recursive: true });
});

afterEach(async () => {
    await rm(home, { recursive: true, force: true });
});

async function extensionFile(path: string, text: string): Promise<void> {
    const target = join(directory, "alpha", path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, text);
}

function read(path: unknown) {
    return readExtensionMain(join(directory, "alpha"), path);
}

test("the extensions directory lives under the home's desktop machine folder", () => {
    expect(extensionsDirectory("/h")).toBe(join("/h", "machine", "desktop", "extensions"));
});

test("an extension main is read from inside its folder", async () => {
    await extensionFile("dist/main.js", "export function activate() {}");
    expect(await read("dist/main.js")).toEqual({ ok: true, source: "export function activate() {}" });
    expect(await read("./dist/main.js")).toEqual({ ok: true, source: "export function activate() {}" });
});

test("@core main paths that leave the extension folder are refused", async () => {
    await extensionFile("main.js", "inside");
    await writeFile(join(directory, "secret.js"), "outside");
    await writeFile(join(home, "home-secret.js"), "outside");
    const refusal = { ok: false, reason: "The file path must stay inside the extension folder." } as const;
    for (const path of ["../secret.js", "..", "dist/../../secret.js", "../../../home-secret.js", "/etc/hosts", join(home, "home-secret.js"), "..\\secret.js", "a\0b"]) {
        expect(await read(path)).toEqual(refusal);
    }
});

test("@core symlinks cannot read outside the extension folder", async () => {
    await extensionFile("real.js", "inside");
    await writeFile(join(home, "outside.js"), "outside");
    await mkdir(join(home, "outside-dir"));
    await writeFile(join(home, "outside-dir", "main.js"), "outside");
    await symlink(join(home, "outside.js"), join(directory, "alpha", "file-link.js"));
    await symlink(join(home, "outside-dir"), join(directory, "alpha", "dir-link"));
    await symlink("real.js", join(directory, "alpha", "inside-link.js"));
    const refusal = { ok: false, reason: "The file path must stay inside the extension folder." } as const;
    expect(await read("file-link.js")).toEqual(refusal);
    expect(await read("dir-link/main.js")).toEqual(refusal);
    expect(await read("inside-link.js")).toEqual({ ok: true, source: "inside" });
});

test("@core a main is capped at 1 MiB and only regular files are read", async () => {
    await extensionFile("big.js", "x".repeat(MAX_MAIN_BYTES + 1));
    await extensionFile("edge.js", "x".repeat(MAX_MAIN_BYTES));
    await mkdir(join(directory, "alpha", "sub"));
    expect(await read("big.js")).toEqual({ ok: false, reason: "The file is larger than 1024 KiB." });
    const edge = await read("edge.js");
    expect(edge.ok && edge.source.length).toBe(MAX_MAIN_BYTES);
    expect(await read("sub")).toEqual({ ok: false, reason: "The path is not a file." });
    expect(await read("missing.js")).toEqual({ ok: false, reason: "The file does not exist." });
});

test("an extension folder that is itself a symlink to another folder reads from the target", async () => {
    await mkdir(join(home, "elsewhere"));
    await writeFile(join(home, "elsewhere", "main.js"), "linked");
    await symlink(join(home, "elsewhere"), join(directory, "linked"));
    expect(await readExtensionMain(join(directory, "linked"), "main.js")).toEqual({ ok: true, source: "linked" });
    expect(await readExtensionMain(join(directory, "linked"), "../outside.js")).toEqual({ ok: false, reason: "The file path must stay inside the extension folder." });
});

test("folder names that could step out of the directory are not extension ids", () => {
    for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", ".hidden", "a..b", "-x", "a b", 5, undefined, "x".repeat(101)]) {
        expect(isFolderName(bad)).toBe(false);
    }
    for (const good of ["alpha", "a.b-c_d", "Ext1", "x".repeat(100)]) expect(isFolderName(good)).toBe(true);
});

test("invalid and overlong main paths are refused before reading", async () => {
    await extensionFile("main.js", "x");
    expect(await read(5)).toEqual({ ok: false, reason: "The main file must be a relative path." });
    expect(await read("")).toEqual({ ok: false, reason: "The file path must stay inside the extension folder." });
    expect(await read("a".repeat(300))).toEqual({ ok: false, reason: "The file path must stay inside the extension folder." });
});
