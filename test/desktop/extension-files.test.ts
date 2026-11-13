import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    extensionsDirectory,
    isFolderName,
    listExtensionFolders,
    readExtensionMain,
} from "../../clients/desktop/src/extension-files.ts";
import {
    MAX_LISTED_EXTENSIONS,
    MAX_MAIN_BYTES,
    MAX_MANIFEST_BYTES,
} from "../../clients/ui/src/protocol/desktop-extensions.ts";

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

async function folder(name: string, files: Record<string, string>): Promise<void> {
    await mkdir(join(directory, name), { recursive: true });
    for (const [file, text] of Object.entries(files)) {
        await mkdir(join(directory, name, file, ".."), { recursive: true });
        await writeFile(join(directory, name, file), text);
    }
}

test("the extensions directory lives under the home's desktop machine folder", () => {
    expect(extensionsDirectory("/h")).toBe(join("/h", "machine", "desktop", "extensions"));
});

test("a missing extensions directory lists as empty", async () => {
    const result = await listExtensionFolders(join(home, "nowhere"));
    expect(result).toEqual({ ok: true, folders: [], truncated: false });
});

test("@core listing hands over raw manifests without parsing them", async () => {
    await folder("alpha", { "vera.desktop.json": '{"id":"alpha"}' });
    await folder("beta", { "vera.desktop.json": "not json {" });
    const result = await listExtensionFolders(directory);
    expect(result).toEqual({
        ok: true,
        truncated: false,
        folders: [
            { directory: "alpha", text: '{"id":"alpha"}' },
            { directory: "beta", text: "not json {" },
        ],
    });
});

test("a folder without a manifest, a dot folder and a loose file are handled", async () => {
    await folder("empty", {});
    await folder(".hidden", { "vera.desktop.json": "{}" });
    await writeFile(join(directory, "loose.txt"), "x");
    const result = await listExtensionFolders(directory);
    expect(result).toEqual({
        ok: true,
        truncated: false,
        folders: [{ directory: "empty", problem: "No vera.desktop.json in this folder." }],
    });
});

test("@core a manifest over the size cap is refused with a reason and its text is not returned", async () => {
    await folder("big", { "vera.desktop.json": "x".repeat(MAX_MANIFEST_BYTES + 1) });
    await folder("edge", { "vera.desktop.json": "x".repeat(MAX_MANIFEST_BYTES) });
    const result = await listExtensionFolders(directory);
    if (!result.ok) throw new Error(result.reason);
    expect(result.folders[0]).toEqual({ directory: "big", problem: "The file is larger than 64 KiB." });
    expect(result.folders[1]?.text?.length).toBe(MAX_MANIFEST_BYTES);
});

test("a manifest that is a symlink out of its folder is refused", async () => {
    const outside = join(home, "outside.json");
    await writeFile(outside, '{"id":"link"}');
    await mkdir(join(directory, "link"));
    await symlink(outside, join(directory, "link", "vera.desktop.json"));
    const result = await listExtensionFolders(directory);
    expect(result).toEqual({
        ok: true,
        truncated: false,
        folders: [{ directory: "link", problem: "The file path must stay inside the extension folder." }],
    });
});

test("a folder name that is not an extension id is reported and not read", async () => {
    await folder("has space", { "vera.desktop.json": "{}" });
    const result = await listExtensionFolders(directory);
    expect(result).toEqual({
        ok: true,
        truncated: false,
        folders: [{ directory: "has space", problem: "The folder name is not a valid extension id." }],
    });
});

test("the listing is capped and says so", async () => {
    for (let index = 0; index < MAX_LISTED_EXTENSIONS + 3; index += 1) {
        await mkdir(join(directory, `ext${String(index).padStart(4, "0")}`));
    }
    const result = await listExtensionFolders(directory);
    if (!result.ok) throw new Error(result.reason);
    expect(result.folders).toHaveLength(MAX_LISTED_EXTENSIONS);
    expect(result.truncated).toBe(true);
});

test("an extension's main is read from inside its folder", async () => {
    await folder("alpha", { "vera.desktop.json": "{}", "dist/main.js": "export function activate() {}" });
    expect(await readExtensionMain(directory, "alpha", "dist/main.js")).toEqual({ ok: true, source: "export function activate() {}" });
    expect(await readExtensionMain(directory, "alpha", "./dist/main.js")).toEqual({ ok: true, source: "export function activate() {}" });
});

test("@core a main path that leaves the extension folder is refused", async () => {
    await folder("alpha", { "main.js": "inside" });
    await writeFile(join(directory, "secret.js"), "outside");
    await writeFile(join(home, "home-secret.js"), "outside");
    const refusal = { ok: false, reason: "The file path must stay inside the extension folder." } as const;
    for (const path of ["../secret.js", "..", "dist/../../secret.js", "../../../home-secret.js", "/etc/hosts", join(home, "home-secret.js"), "..\\secret.js", "a\0b"]) {
        expect(await readExtensionMain(directory, "alpha", path)).toEqual(refusal);
    }
});

test("@core a symlink inside the folder that points outside is refused, and one that points inside is read", async () => {
    await folder("alpha", { "real.js": "inside" });
    await writeFile(join(home, "outside.js"), "outside");
    await mkdir(join(home, "outside-dir"));
    await writeFile(join(home, "outside-dir", "main.js"), "outside");
    await symlink(join(home, "outside.js"), join(directory, "alpha", "file-link.js"));
    await symlink(join(home, "outside-dir"), join(directory, "alpha", "dir-link"));
    await symlink("real.js", join(directory, "alpha", "inside-link.js"));
    const refusal = { ok: false, reason: "The file path must stay inside the extension folder." } as const;
    expect(await readExtensionMain(directory, "alpha", "file-link.js")).toEqual(refusal);
    expect(await readExtensionMain(directory, "alpha", "dir-link/main.js")).toEqual(refusal);
    expect(await readExtensionMain(directory, "alpha", "inside-link.js")).toEqual({ ok: true, source: "inside" });
});

test("an extension folder that is itself a symlink to another folder reads from the target", async () => {
    await mkdir(join(home, "elsewhere"));
    await writeFile(join(home, "elsewhere", "main.js"), "linked");
    await symlink(join(home, "elsewhere"), join(directory, "linked"));
    expect(await readExtensionMain(directory, "linked", "main.js")).toEqual({ ok: true, source: "linked" });
    expect(await readExtensionMain(directory, "linked", "../outside.js")).toEqual({ ok: false, reason: "The file path must stay inside the extension folder." });
});

test("a main over the size cap, a directory and a missing file are refused with reasons", async () => {
    await folder("alpha", { "big.js": "x".repeat(MAX_MAIN_BYTES + 1), "edge.js": "x".repeat(MAX_MAIN_BYTES) });
    await mkdir(join(directory, "alpha", "sub"));
    expect(await readExtensionMain(directory, "alpha", "big.js")).toEqual({ ok: false, reason: "The file is larger than 1024 KiB." });
    const edge = await readExtensionMain(directory, "alpha", "edge.js");
    expect(edge.ok && edge.source.length).toBe(MAX_MAIN_BYTES);
    expect(await readExtensionMain(directory, "alpha", "sub")).toEqual({ ok: false, reason: "The path is not a file." });
    expect(await readExtensionMain(directory, "alpha", "missing.js")).toEqual({ ok: false, reason: "The file does not exist." });
});

test("arguments that are not an extension id and a path are refused before any read", async () => {
    await folder("alpha", { "main.js": "x" });
    expect(await readExtensionMain(directory, "../alpha", "main.js")).toEqual({ ok: false, reason: "That is not an extension id." });
    expect(await readExtensionMain(directory, "", "main.js")).toEqual({ ok: false, reason: "That is not an extension id." });
    expect(await readExtensionMain(directory, 5, "main.js")).toEqual({ ok: false, reason: "That is not an extension id." });
    expect(await readExtensionMain(directory, "alpha", 5)).toEqual({ ok: false, reason: "The main file must be a relative path." });
    expect(await readExtensionMain(directory, "alpha", "")).toEqual({ ok: false, reason: "The file path must stay inside the extension folder." });
    expect(await readExtensionMain(directory, "alpha", "a".repeat(300))).toEqual({ ok: false, reason: "The file path must stay inside the extension folder." });
});

test("folder names that could step out of the directory are not extension ids", () => {
    for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", ".hidden", "a..b", "-x", "a b", 5, undefined, "x".repeat(101)]) {
        expect(isFolderName(bad)).toBe(false);
    }
    for (const good of ["alpha", "a.b-c_d", "Ext1", "x".repeat(100)]) expect(isFolderName(good)).toBe(true);
});
