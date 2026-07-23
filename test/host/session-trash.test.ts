import { expect, test } from "bun:test";
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { trashSessionArtifacts } from "../../src/host/session-trash.ts";

test("session trash stages a complete recoverable bundle before removal", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-session-trash-test-"));
    const sessionPath = join(root, "session.jsonl");
    const attachmentsPath = `${sessionPath}.attachments`;
    const eventLogPath = join(root, "events.jsonl");
    const captured: Record<string, string> = {};
    await writeFile(sessionPath, "session");
    await mkdir(attachmentsPath);
    await writeFile(join(attachmentsPath, "image.png"), "image");
    await writeFile(eventLogPath, "events");

    try {
        await trashSessionArtifacts({
            sessionPath,
            attachmentsPath,
            eventLogPath,
        }, {
            moveToTrash: async ([bundle]) => {
                captured.session = await readFile(
                    join(bundle!, "session.jsonl"),
                    "utf8",
                );
                captured.image = await readFile(
                    join(bundle!, "attachments", "image.png"),
                    "utf8",
                );
                captured.events = await readFile(
                    join(bundle!, "events.jsonl"),
                    "utf8",
                );
            },
        });

        expect(captured).toEqual({
            session: "session",
            image: "image",
            events: "events",
        });
        await expect(stat(sessionPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(attachmentsPath))
            .rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(eventLogPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a trash adapter failure leaves every original artifact intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-session-trash-test-"));
    const sessionPath = join(root, "session.jsonl");
    const attachmentsPath = `${sessionPath}.attachments`;
    const eventLogPath = join(root, "events.jsonl");
    await writeFile(sessionPath, "session");
    await mkdir(attachmentsPath);
    await writeFile(join(attachmentsPath, "image.png"), "image");
    await writeFile(eventLogPath, "events");

    try {
        await expect(trashSessionArtifacts({
            sessionPath,
            attachmentsPath,
            eventLogPath,
        }, {
            moveToTrash: () => Promise.reject(new Error("trash unavailable")),
        })).rejects.toThrow("trash unavailable");

        expect(await readFile(sessionPath, "utf8")).toBe("session");
        expect(await readFile(join(attachmentsPath, "image.png"), "utf8"))
            .toBe("image");
        expect(await readFile(eventLogPath, "utf8")).toBe("events");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a partial original cleanup failure restores removed sidecars", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-session-trash-test-"));
    const sessionPath = join(root, "session.jsonl");
    const attachmentsPath = `${sessionPath}.attachments`;
    const eventLogPath = join(root, "events.jsonl");
    await writeFile(sessionPath, "session");
    await mkdir(attachmentsPath);
    await writeFile(join(attachmentsPath, "image.png"), "image");
    await writeFile(eventLogPath, "events");
    let removals = 0;

    try {
        await expect(trashSessionArtifacts({
            sessionPath,
            attachmentsPath,
            eventLogPath,
        }, {
            moveToTrash: async () => undefined,
            removeOriginal: async (path) => {
                removals += 1;
                if (removals === 2) {
                    throw new Error("cleanup failed");
                }
                await rm(path, { recursive: true });
            },
        })).rejects.toThrow("cleanup failed");

        expect(await readFile(sessionPath, "utf8")).toBe("session");
        expect(await readFile(join(attachmentsPath, "image.png"), "utf8"))
            .toBe("image");
        expect(await readFile(eventLogPath, "utf8")).toBe("events");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
