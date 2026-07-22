import { createHash } from "node:crypto";
import {
    chmod,
    mkdir,
    mkdtemp,
    rm,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { AttachmentStore } from "../../src/attachments/store.ts";
import type { ValidatedImage } from "../../src/attachments/image.ts";

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) =>
        rm(path, { recursive: true, force: true })
    ));
});

describe("AttachmentStore", () => {
    test("copies validated bytes into private session-owned storage", async () => {
        const root = await temporaryDirectory();
        const sourcePath = join(root, "outside", "photo.png");
        const data = Uint8Array.from([1, 2, 3, 4]);
        const store = new AttachmentStore(join(root, "session.jsonl"));

        const stored = await store.saveImage(data, metadata(data), sourcePath);
        data[0] = 9;

        expect(stored.name).toBe("photo.png");
        expect(stored.id).toBe(`${stored.sha256}.png`);
        expect(Array.from(await store.readImage(stored))).toEqual([1, 2, 3, 4]);
        expect((await stat(store.path)).mode & 0o777).toBe(0o700);
        expect((await stat(join(store.path, stored.id))).mode & 0o777).toBe(0o600);
        expect(JSON.stringify(stored)).not.toContain("outside");
    });

    test("reopens attachments without the original source", async () => {
        const root = await temporaryDirectory();
        const sessionPath = join(root, "session.jsonl");
        const data = Uint8Array.from([5, 6, 7]);
        const first = new AttachmentStore(sessionPath);
        const stored = await first.saveImage(data, metadata(data), "image.png");

        const reopened = new AttachmentStore(sessionPath);
        expect(Array.from(await reopened.readImage(stored))).toEqual([5, 6, 7]);
    });

    test("deduplicates identical content without replacing stored bytes", async () => {
        const root = await temporaryDirectory();
        const data = Uint8Array.from([8, 9]);
        const store = new AttachmentStore(join(root, "session.jsonl"));
        const first = await store.saveImage(data, metadata(data), "one.png");
        const path = join(store.path, first.id);
        await chmod(path, 0o400);

        const second = await store.saveImage(data, metadata(data), "two.png");

        expect(second.id).toBe(first.id);
        expect(second.name).toBe("two.png");
        expect((await stat(path)).mode & 0o777).toBe(0o400);
    });

    test("rejects bytes that do not match validation metadata", async () => {
        const root = await temporaryDirectory();
        const data = Uint8Array.from([1, 2, 3]);
        const store = new AttachmentStore(join(root, "session.jsonl"));

        await expect(store.saveImage(
            Uint8Array.from([1, 2, 4]),
            metadata(data),
            "photo.png",
        )).rejects.toThrow("do not match");
    });

    test("detects corruption when reading stored bytes", async () => {
        const root = await temporaryDirectory();
        const data = Uint8Array.from([1, 2, 3]);
        const store = new AttachmentStore(join(root, "session.jsonl"));
        const stored = await store.saveImage(data, metadata(data), "photo.png");
        await writeFile(join(store.path, stored.id), Uint8Array.from([3, 2, 1]));

        await expect(store.readImage(stored)).rejects.toThrow("does not match");
    });

    test("rejects a corrupt file occupying a content address", async () => {
        const root = await temporaryDirectory();
        const data = Uint8Array.from([1, 2, 3]);
        const store = new AttachmentStore(join(root, "session.jsonl"));
        const stored = await store.saveImage(data, metadata(data), "photo.png");
        await writeFile(join(store.path, stored.id), Uint8Array.from([3, 2, 1]));

        await expect(store.saveImage(data, metadata(data), "photo.png"))
            .rejects.toThrow("conflicts");
    });

    test("stores only a bounded basename", async () => {
        const root = await temporaryDirectory();
        const data = Uint8Array.from([1]);
        const store = new AttachmentStore(join(root, "session.jsonl"));

        const stored = await store.saveImage(data, metadata(data), "../../photo.png");
        expect(stored.name).toBe("photo.png");
        const windows = await store.saveImage(data, metadata(data), "C:\\outside\\other.png");
        expect(windows.name).toBe("other.png");
        await expect(store.saveImage(data, metadata(data), `${"x".repeat(256)}.png`))
            .rejects.toThrow("too long");
    });

    test("rejects storage redirected through a symlink", async () => {
        const root = await temporaryDirectory();
        const target = join(root, "outside");
        await mkdir(target);
        const store = new AttachmentStore(join(root, "session.jsonl"));
        await symlink(target, store.path, "dir");
        const data = Uint8Array.from([1]);

        await expect(store.saveImage(data, metadata(data), "photo.png"))
            .rejects.toThrow("must be a directory");
        expect((await stat(target)).mode & 0o777).not.toBe(0o700);
    });

    test("does not follow a symlink occupying an attachment ID", async () => {
        const root = await temporaryDirectory();
        const data = Uint8Array.from([1]);
        const store = new AttachmentStore(join(root, "session.jsonl"));
        const stored = await store.saveImage(data, metadata(data), "photo.png");
        const outside = join(root, "outside.png");
        await writeFile(outside, data);
        await rm(join(store.path, stored.id));
        await symlink(outside, join(store.path, stored.id));

        await expect(store.readImage(stored)).rejects.toThrow();
        await expect(store.saveImage(data, metadata(data), "photo.png"))
            .rejects.toThrow();
    });
});

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "vera-attachments-"));
    directories.push(path);
    return path;
}

function metadata(data: Uint8Array): ValidatedImage {
    return {
        mediaType: "image/png",
        bytes: data.byteLength,
        width: 1,
        height: 1,
        sha256: createHash("sha256").update(data).digest("hex"),
    };
}
