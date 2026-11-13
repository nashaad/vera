import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExtensionLogs, extensionLogsDir } from "../../clients/desktop/src/extension-logs.ts";

const homes: string[] = [];

function trialHome(): string {
    const home = mkdtempSync(join(tmpdir(), "vera-extension-logs-"));
    homes.push(home);
    return home;
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test("lines carry an ISO time, level and text, and newlines become spaces", async () => {
    const home = trialHome();
    expect(extensionLogsDir(home)).toBe(join(home, "machine", "desktop", "logs"));
    const logs = new ExtensionLogs(join(home, "logs"));
    logs.append("ext.one", "info", "hello\nworld");
    expect(existsSync(join(home, "logs", "ext.one.log"))).toBe(false);
    await logs.flush();
    expect(readFileSync(join(home, "logs", "ext.one.log"), "utf8")).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z info hello world\n$/,
    );
    await logs.close();
});

test("queued lines reach disk together after the 250 ms window, at most once per window", async () => {
    const dir = join(trialHome(), "logs");
    const logs = new ExtensionLogs(dir);
    for (let i = 0; i < 100; i++) logs.append("ext", "info", `line ${i}`);
    expect(existsSync(join(dir, "ext.log"))).toBe(false);
    await wait(400);
    const lines = readFileSync(join(dir, "ext.log"), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(100);
    expect(lines[99]?.endsWith("line 99")).toBe(true);
    logs.append("ext", "info", "later");
    await wait(50);
    expect(readFileSync(join(dir, "ext.log"), "utf8")).not.toContain("later");
    await wait(300);
    expect(readFileSync(join(dir, "ext.log"), "utf8")).toContain("later");
    await logs.close();
});

test("a line over 8 KiB is cut to 8 KiB", async () => {
    const dir = join(trialHome(), "logs");
    const logs = new ExtensionLogs(dir);
    logs.append("ext", "warn", "z".repeat(20_000));
    await logs.flush();
    const line = readFileSync(join(dir, "ext.log"), "utf8").slice(0, -1);
    expect(Buffer.byteLength(line)).toBe(8 * 1024);
    await logs.close();
});

test("a write past 1 MiB renames the file to .1, and a later rotation replaces it", async () => {
    const dir = join(trialHome(), "logs");
    const logs = new ExtensionLogs(dir);
    const text = "x".repeat(20_000);
    for (let round = 0; round < 6; round++) {
        for (let i = 0; i < 60; i++) logs.append("ext", "info", `${round} ${text}`);
        await logs.flush();
    }
    expect(readdirSync(dir).sort()).toEqual(["ext.log", "ext.log.1"]);
    expect(readFileSync(join(dir, "ext.log"), "utf8")).toMatch(/ info 4 x/);
    expect(readFileSync(join(dir, "ext.log.1"), "utf8")).toMatch(/ info 2 x/);
    await logs.close();
});

test("read returns the requested bytes, and restarts from 0 past the end", async () => {
    const dir = join(trialHome(), "logs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ext.log"), "abcdefghij");
    const logs = new ExtensionLogs(dir);
    expect(await logs.read("ext", 2, 3)).toEqual({ text: "cde", nextOffset: 5, size: 10 });
    expect(await logs.read("ext", 50, 3)).toEqual({ text: "abc", nextOffset: 3, size: 10 });
    expect(await logs.read("missing", 0, 10)).toEqual({ text: "", nextOffset: 0, size: 0 });
});

test("read caps the limit at 64 KiB", async () => {
    const dir = join(trialHome(), "logs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ext.log"), "a".repeat(100_000));
    const chunk = await new ExtensionLogs(dir).read("ext", 0, 1_000_000);
    expect(chunk.text.length).toBe(64 * 1024);
    expect(chunk.nextOffset).toBe(64 * 1024);
    expect(chunk.size).toBe(100_000);
});

test("paged reads never split a multi-byte character", async () => {
    const dir = join(trialHome(), "logs");
    mkdirSync(dir, { recursive: true });
    const original = "aé€\u{1F600}".repeat(5);
    writeFileSync(join(dir, "ext.log"), original);
    const logs = new ExtensionLogs(dir);
    let offset = 0;
    let out = "";
    let size = 0;
    while (offset < size || size === 0) {
        const chunk = await logs.read("ext", offset, 4);
        out += chunk.text;
        size = chunk.size;
        if (chunk.nextOffset === offset) break;
        offset = chunk.nextOffset;
    }
    expect(out).toBe(original);
    expect(out).not.toContain("�");
});

test("an extension id that could leave the logs directory is refused", async () => {
    const logs = new ExtensionLogs(join(trialHome(), "logs"));
    for (const id of ["", ".hidden", "../up", "a/b", "a\\b", "a..b"]) {
        expect(() => logs.append(id, "info", "x")).toThrow(RangeError);
        await expect(logs.read(id, 0, 1)).rejects.toThrow(RangeError);
    }
});

test("a write to an unwritable directory resolves without throwing or creating files", async () => {
    const home = trialHome();
    writeFileSync(join(home, "blocker"), "not a directory");
    const logs = new ExtensionLogs(join(home, "blocker", "logs"));
    logs.append("ext", "error", "lost");
    await expect(logs.flush()).resolves.toBeUndefined();
    expect(existsSync(join(home, "blocker", "logs"))).toBe(false);
    await logs.close();
});

test("close writes what is queued and ignores later lines", async () => {
    const dir = join(trialHome(), "logs");
    const logs = new ExtensionLogs(dir);
    logs.append("ext", "error", "boom");
    await logs.close();
    logs.append("ext", "error", "later");
    await wait(300);
    const text = readFileSync(join(dir, "ext.log"), "utf8");
    expect(text).toMatch(/ error boom\n$/);
    expect(text).not.toContain("later");
});
