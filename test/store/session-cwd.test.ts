import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rewriteSessionCwd } from "../../src/store/session-cwd.ts";
import {
    readIndexedLiveContext,
    readSessionIndexMetadata,
    readSessionSnapshot,
    SessionStore,
} from "../../src/store/session-store.ts";

const directories: string[] = [];

afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-session-cwd-"));
    directories.push(directory);
    return directory;
}

function userMessage(text: string) {
    return { role: "user", content: [{ type: "text", text }] } as const;
}

function afterHeader(path: string): Buffer {
    const bytes = readFileSync(path);
    return bytes.subarray(bytes.indexOf(0x0a) + 1);
}

function headerOf(path: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path, "utf8").split("\n")[0]!);
}

async function sessionWithBody(directory: string, name: string, chunks: number): Promise<{ path: string; cwd: string }> {
    const cwd = join(directory, `${name}.jsonl.files`);
    const path = join(directory, `${name}.jsonl`);
    const store = await SessionStore.create(path, { sessionId: name, cwd });
    await store.appendMessage(userMessage("first"));
    for (let index = 0; index < chunks; index += 1) {
        await store.appendMessage(userMessage(`${index} ${"x".repeat(90_000)}`));
    }
    return { path, cwd };
}

test("@core rewriting the cwd changes line 1 only and every loader sees the new folder", async () => {
    const directory = temporaryDirectory();
    const { path } = await sessionWithBody(directory, "moved", 8);
    chmodSync(path, 0o640);
    const body = afterHeader(path);
    const originalHeader = headerOf(path);
    const target = join(directory, "project");

    await rewriteSessionCwd(path, target);

    expect(afterHeader(path).equals(body)).toBe(true);
    expect(headerOf(path)).toEqual({ ...originalHeader, cwd: target });
    expect(Object.keys(headerOf(path))).toEqual(Object.keys(originalHeader));
    expect(statSync(path).mode & 0o7777).toBe(0o640);
    expect(readdirSync(directory)).toEqual(["moved.jsonl"]);
    const reopened = await SessionStore.open(path);
    expect(reopened.header.cwd).toBe(target);
    expect((await readIndexedLiveContext(path)).header.cwd).toBe(target);
    expect((await readSessionSnapshot(path)).header.cwd).toBe(target);
    expect(await readSessionIndexMetadata(path)).toMatchObject({
        header: { id: "moved", cwd: target },
        hasUserContent: true,
        title: "first",
    });
    await reopened.appendMessage(userMessage("after the move"));
    expect((await SessionStore.open(path)).header.cwd).toBe(target);
});

test("a body larger than the copy buffer and a body of one record both copy byte for byte", async () => {
    const directory = temporaryDirectory();
    for (const [name, chunks] of [["large", 40], ["small", 0]] as const) {
        const { path } = await sessionWithBody(directory, name, chunks);
        const body = afterHeader(path);

        await rewriteSessionCwd(path, join(directory, "project"));

        expect(afterHeader(path).equals(body)).toBe(true);
        expect(readdirSync(directory).some((entry) => entry.endsWith(".moving"))).toBe(false);
    }
});

test("a failure before the replace leaves the original untouched and removes the temporary copy", async () => {
    const directory = temporaryDirectory();
    const { path } = await sessionWithBody(directory, "kept", 3);
    chmodSync(path, 0o600);
    const before = readFileSync(path);

    await expect(rewriteSessionCwd(path, join(directory, "project"), {
        beforeReplace: async () => {
            expect(statSync(`${path}.moving`).isFile()).toBe(true);
            throw new Error("forced failure");
        },
    })).rejects.toThrow("forced failure");

    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(directory)).toEqual(["kept.jsonl"]);
    expect((await SessionStore.open(path)).header.cwd).toBe(join(directory, "kept.jsonl.files"));
});

test("a temporary copy left by a crashed move is replaced", async () => {
    const directory = temporaryDirectory();
    const { path } = await sessionWithBody(directory, "stale", 1);
    const body = afterHeader(path);
    writeFileSync(`${path}.moving`, "half a copy");

    await rewriteSessionCwd(path, join(directory, "project"));

    expect(afterHeader(path).equals(body)).toBe(true);
    expect(readdirSync(directory)).toEqual(["stale.jsonl"]);
});

test("a file without a valid header is refused and left as it was", async () => {
    const directory = temporaryDirectory();
    const header = { type: "session", version: 1, id: "x", timestamp: new Date().toISOString(), cwd: "/a" };
    const cases: Record<string, string> = {
        empty: "",
        "no newline": JSON.stringify(header),
        "not json": "not json\nrest\n",
        "not an object": "[1,2]\nrest\n",
        "wrong type": `${JSON.stringify({ ...header, type: "message" })}\nrest\n`,
        "empty cwd": `${JSON.stringify({ ...header, cwd: "" })}\nrest\n`,
        "header over 64 KiB": `${JSON.stringify({ ...header, pad: "p".repeat(70_000) })}\nrest\n`,
    };
    for (const [name, content] of Object.entries(cases)) {
        const path = join(directory, `${name.replaceAll(" ", "-")}.jsonl`);
        writeFileSync(path, content);

        await expect(rewriteSessionCwd(path, "/b")).rejects.toThrow();

        expect(readFileSync(path, "utf8")).toBe(content);
        expect(readdirSync(directory).some((entry) => entry.endsWith(".moving"))).toBe(false);
    }
});

test("an empty or invalid cwd is refused before anything is written", async () => {
    const directory = temporaryDirectory();
    const { path } = await sessionWithBody(directory, "bad", 0);
    const before = readFileSync(path);

    await expect(rewriteSessionCwd(path, "")).rejects.toThrow("empty or invalid");
    await expect(rewriteSessionCwd(path, "/with\0nul")).rejects.toThrow("empty or invalid");

    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSync(directory)).toEqual(["bad.jsonl"]);
});
