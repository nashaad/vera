import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import {
    hydrateImageAttachments,
    ImageAttachmentService,
    OMITTED_IMAGE_TEXT,
    sessionAttachmentSource,
} from "../../src/attachments/service.ts";
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

test("image attachment service owns a selected regular file", async () => {
    const root = await temporaryDirectory();
    const sourcePath = join(root, "selected.png");
    await writeFile(sourcePath, Uint8Array.from([4, 5, 6]));
    const session = await SessionStore.create(join(root, "session.jsonl"), {
        sessionId: "session-1",
        cwd: root,
    });
    const service = new ImageAttachmentService(
        session,
        limits,
        async () => ({ mediaType: "image/png", width: 2, height: 3 }),
    );

    const attached = await service.attachFile(sourcePath);

    expect(attached.name).toBe("selected.png");
    expect(attached.source).toBe(sourcePath);
    expect(Array.from(await readFile(
        join(`${session.path}.attachments`, attached.id),
    ))).toEqual([4, 5, 6]);
});

test("a client copy records the user's original path and name, which survive reopening", async () => {
    const root = await temporaryDirectory();
    const copy = join(root, "drop-1", "Screenshot 2026-09-23 at 1.10.00 AM.png");
    await Bun.write(copy, Uint8Array.from([7, 8, 9]));
    const sessionPath = join(root, "session.jsonl");
    const session = await SessionStore.create(sessionPath, {
        sessionId: "session-1",
        cwd: root,
    });
    const service = new ImageAttachmentService(
        session,
        limits,
        async () => ({ mediaType: "image/png", width: 2, height: 3 }),
    );

    const attached = await service.attachFile(copy, undefined, "/Users/crow/Desktop/treasure map.png");

    expect(attached.source).toBe("/Users/crow/Desktop/treasure map.png");
    expect(attached.name).toBe("treasure map.png");
    const reopened = await SessionStore.open(sessionPath);
    expect(sessionAttachmentSource(reopened)(attached.id))
        .toBe("/Users/crow/Desktop/treasure map.png");
});

test("hydration puts the image source line before each image, also when images are omitted", async () => {
    const image = { type: "image" as const, mediaType: "image/png" as const, data: Uint8Array.from([1]) };
    const messages = [{
        role: "user" as const,
        content: [
            { type: "text" as const, text: "which cove is this? [Image 1]" },
            { type: "image_attachment" as const, attachmentId: "a.png" },
            { type: "image_attachment" as const, attachmentId: "old.png" },
        ],
    }];
    const source = (id: string) => id === "a.png" ? "/Users/crow/Desktop/cove.png" : undefined;

    const shown = await hydrateImageAttachments(messages, async () => image, new Map(), false, source);
    expect(shown[0]!.content).toEqual([
        { type: "text", text: "which cove is this? [Image 1]" },
        { type: "text", text: "[Image source: /Users/crow/Desktop/cove.png]" },
        image,
        image,
    ]);

    const omitted = await hydrateImageAttachments(messages, async () => image, new Map(), true, source);
    expect(omitted[0]!.content).toEqual([
        { type: "text", text: "which cove is this? [Image 1]" },
        { type: "text", text: "[Image source: /Users/crow/Desktop/cove.png]" },
        { type: "text", text: OMITTED_IMAGE_TEXT },
        { type: "text", text: OMITTED_IMAGE_TEXT },
    ]);
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
