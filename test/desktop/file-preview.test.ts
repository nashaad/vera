import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readFilePreview } from "../../clients/desktop/src/file-preview.ts";
import { MAX_FILE_PREVIEW_BYTES } from "../../clients/ui/src/protocol/bridge.ts";

const roots: string[] = [];

function scratch(): string {
    const root = mkdtempSync(join(tmpdir(), "vera-preview-"));
    roots.push(root);
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("@core a text file reads whole when it fits", async () => {
    const root = scratch();
    writeFileSync(join(root, "nest.txt"), "feathers\nmud\n");
    expect(await readFilePreview(join(root, "nest.txt"))).toEqual({ ok: true, text: "feathers\nmud\n", size: 13, cut: false });
    writeFileSync(join(root, "empty.txt"), "");
    expect(await readFilePreview(join(root, "empty.txt"))).toEqual({ ok: true, text: "", size: 0, cut: false });
});

test("@core a file past the cap stops at the last whole line", async () => {
    const root = scratch();
    const line = "caw caw caw\n";
    const body = line.repeat(Math.ceil(MAX_FILE_PREVIEW_BYTES / line.length) + 10);
    writeFileSync(join(root, "long.txt"), body);
    const preview = await readFilePreview(join(root, "long.txt"));
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.cut).toBe(true);
    expect(preview.size).toBe(body.length);
    expect(preview.text.length).toBeLessThanOrEqual(MAX_FILE_PREVIEW_BYTES);
    expect(preview.text.endsWith(line)).toBe(true);
});

test("@core a cut with no newline leaves out a character split at the cap", async () => {
    const root = scratch();
    const body = `${"a".repeat(MAX_FILE_PREVIEW_BYTES - 1)}é and more`;
    writeFileSync(join(root, "one-line.txt"), body);
    const preview = await readFilePreview(join(root, "one-line.txt"));
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.cut).toBe(true);
    expect(preview.text).toBe("a".repeat(MAX_FILE_PREVIEW_BYTES - 1));
});

test("@core a binary file, a folder, a pipe and a missing path are refused", async () => {
    const root = scratch();
    writeFileSync(join(root, "crow.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    mkdirSync(join(root, "hold"));
    execFileSync("mkfifo", [join(root, "pipe")]);
    expect(await readFilePreview(join(root, "crow.png"))).toEqual({ ok: false, reason: "This file is not text." });
    expect(await readFilePreview(join(root, "hold"))).toEqual({ ok: false, reason: "This is a folder." });
    expect(await readFilePreview(join(root, "pipe"))).toEqual({ ok: false, reason: "This is not a regular file." });
    expect(await readFilePreview(join(root, "gone.txt"))).toEqual({ ok: false, reason: "This file is gone." });
});
