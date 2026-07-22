import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { ImageAttachmentService } from "../../src/attachments/service.ts";
import type { InspectedImage } from "../../src/attachments/image.ts";
import { SessionStore } from "../../src/store/session-store.ts";

const directories: string[] = [];
const limits = { maxBytes: 100, maxWidth: 100, maxHeight: 100 };

afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) =>
        rm(path, { recursive: true, force: true })
    ));
});

test("image attachment service stores bytes before durable metadata", async () => {
    const root = await temporaryDirectory();
    const session = await SessionStore.create(join(root, "session.jsonl"), {
        sessionId: "session-1",
        cwd: root,
    });
    const source = Uint8Array.from([1, 2, 3]);
    const service = new ImageAttachmentService(
        session,
        limits,
        async () => ({ mediaType: "image/png", width: 2, height: 3 }),
    );

    const attached = await service.attach(source, "/outside/screenshot.png");

    expect(session.attachmentRecords()).toEqual([attached]);
    expect(Array.from(await readFile(
        join(`${session.path}.attachments`, attached.id),
    ))).toEqual([1, 2, 3]);
    expect(attached.name).toBe("screenshot.png");
});

test("image attachment service owns one immutable byte snapshot", async () => {
    const root = await temporaryDirectory();
    const session = await SessionStore.create(join(root, "session.jsonl"), {
        sessionId: "session-1",
        cwd: root,
    });
    const source = Uint8Array.from([4, 5, 6]);
    const service = new ImageAttachmentService(
        session,
        limits,
        async (decoderInput): Promise<InspectedImage> => {
            source[0] = 9;
            decoderInput[1] = 8;
            return { mediaType: "image/png", width: 1, height: 1 };
        },
    );

    const attached = await service.attach(source, "image.png");

    expect(Array.from(await readFile(
        join(`${session.path}.attachments`, attached.id),
    ))).toEqual([4, 5, 6]);
});

test("content deduplication returns the canonical session metadata", async () => {
    const root = await temporaryDirectory();
    const session = await SessionStore.create(join(root, "session.jsonl"), {
        sessionId: "session-1",
        cwd: root,
    });
    const service = new ImageAttachmentService(
        session,
        limits,
        async () => ({ mediaType: "image/png", width: 1, height: 1 }),
    );
    const data = Uint8Array.from([1]);

    const first = await service.attach(data, "first.png");
    const second = await service.attach(data, "second.png");

    expect(second).toEqual(first);
    expect(session.attachmentRecords()).toEqual([first]);
});

test("attachment service hydrates only canonical verified session content", async () => {
    const root = await temporaryDirectory();
    const session = await SessionStore.create(join(root, "session.jsonl"), {
        sessionId: "session-1",
        cwd: root,
    });
    const service = new ImageAttachmentService(
        session,
        limits,
        async () => ({ mediaType: "image/png", width: 1, height: 1 }),
    );
    const attached = await service.attach(
        Uint8Array.from([1, 2, 3]),
        "screen.png",
    );

    expect(await service.readContent(attached.id)).toEqual({
        type: "image",
        mediaType: "image/png",
        data: Uint8Array.from([1, 2, 3]),
    });
    await expect(service.readContent("missing.png")).rejects.toThrow(
        "Image attachment missing.png is not in this session",
    );
});

test("metadata failure leaves content-addressed bytes safe for concurrent use", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "session.jsonl");
    let appendCalls = 0;
    const session = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: root,
    });
    session.appendAttachment = async () => {
        appendCalls += 1;
        throw new Error("session append failed");
    };
    const service = new ImageAttachmentService(
        session,
        limits,
        async () => ({ mediaType: "image/png", width: 1, height: 1 }),
    );

    await expect(service.attach(Uint8Array.from([7]), "image.png"))
        .rejects.toThrow("session append failed");

    expect(appendCalls).toBe(1);
    const files = await Array.fromAsync(
        new Bun.Glob("*.png").scan(`${path}.attachments`),
    );
    expect(files).toHaveLength(1);
});

test("metadata failure preserves a file created by an earlier attach", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "session.jsonl");
    const session = await SessionStore.create(path, {
        sessionId: "session-1",
        cwd: root,
    });
    const service = new ImageAttachmentService(
        session,
        limits,
        async () => ({ mediaType: "image/png", width: 1, height: 1 }),
    );
    const data = Uint8Array.from([7]);
    const attached = await service.attach(data, "first.png");
    session.appendAttachment = async () => {
        throw new Error("session append failed");
    };

    await expect(service.attach(data, "second.png"))
        .rejects.toThrow("session append failed");

    expect(Array.from(await readFile(
        join(`${path}.attachments`, attached.id),
    ))).toEqual([7]);
});

test("validation failure writes neither bytes nor metadata", async () => {
    const root = await temporaryDirectory();
    const session = await SessionStore.create(join(root, "session.jsonl"), {
        sessionId: "session-1",
        cwd: root,
    });
    const service = new ImageAttachmentService(
        session,
        { ...limits, maxBytes: 1 },
        async () => ({ mediaType: "image/png", width: 1, height: 1 }),
    );

    await expect(service.attach(Uint8Array.from([1, 2]), "image.png"))
        .rejects.toThrow("maximum is 1");
    expect(session.attachmentRecords()).toEqual([]);
    await expect(readFile(`${session.path}.attachments`)).rejects.toThrow();
});

async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "vera-attachment-service-"));
    directories.push(path);
    return path;
}
