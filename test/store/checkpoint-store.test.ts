import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    CheckpointStore,
    sha256Text,
} from "../../src/store/checkpoint-store.ts";

const temporaryDirectories: string[] = [];

afterAll(() => {
    for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("checkpoint store round-trips an existing file blob", async () => {
    const store = new CheckpointStore(join(temporaryDirectory(), "checkpoints"));
    await store.write("checkpoint-1", { existed: true, content: "before" });
    expect(await store.read("checkpoint-1")).toEqual({
        existed: true,
        content: "before",
    });
});

test("checkpoint store discards content for a file that did not exist", async () => {
    const store = new CheckpointStore(join(temporaryDirectory(), "checkpoints"));
    await store.write("checkpoint-1", { existed: false, content: "ignored" });
    expect(await store.read("checkpoint-1")).toEqual({
        existed: false,
        content: "",
    });
});

test("checkpoint store creates its directory only on first write", async () => {
    const directory = join(temporaryDirectory(), "checkpoints");
    const store = new CheckpointStore(directory);
    expect(existsSync(directory)).toBe(false);
    await store.write("checkpoint-1", { existed: true, content: "x" });
    expect(existsSync(directory)).toBe(true);
});

test("checkpoint store refuses to overwrite an existing blob", async () => {
    const store = new CheckpointStore(join(temporaryDirectory(), "checkpoints"));
    await store.write("checkpoint-1", { existed: true, content: "first" });
    await expect(
        store.write("checkpoint-1", { existed: true, content: "second" }),
    ).rejects.toThrow();
});

test("checkpoint store rejects a malformed blob on read", async () => {
    const directory = join(temporaryDirectory(), "checkpoints");
    const store = new CheckpointStore(directory);
    await store.write("checkpoint-1", { existed: true, content: "ok" });
    writeFileSync(join(directory, "checkpoint-2.json"), "{\"existed\":true}\n");
    await expect(store.read("checkpoint-2")).rejects.toThrow(
        "Checkpoint blob checkpoint-2 is malformed",
    );
    // The valid blob is unaffected.
    expect(readFileSync(join(directory, "checkpoint-1.json"), "utf8")).toContain(
        "\"content\":\"ok\"",
    );
});

test("checkpoint store rejects an id with path separators", async () => {
    const store = new CheckpointStore(join(temporaryDirectory(), "checkpoints"));
    await expect(
        store.write("../escape", { existed: true, content: "x" }),
    ).rejects.toThrow("must not contain path separators");
});

test("checkpoint content digests are stable SHA-256 values", () => {
    expect(sha256Text("before")).toBe(
        "6db7d803e74f1ffa7d8f5adc0bf95b3e15bf4c8373fffadf546227cc6c6742cb",
    );
    expect(sha256Text("before")).not.toBe(sha256Text("after"));
});

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "vera-checkpoint-store-"));
    temporaryDirectories.push(directory);
    return directory;
}
