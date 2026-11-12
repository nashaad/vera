import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { savePastedImage, PASTED_IMAGE_KEEP_MS } from "../../clients/desktop/src/pasted-image.ts";
import {
    imageState,
    nextImageNumber,
    pastedImagePaths,
    readyAttachments,
    type ComposerImage,
} from "../../clients/ui/src/composer/images.ts";
import { addDraftImages } from "../../clients/ui/src/composer/useImages.ts";
import { initialWatch, reduceWatch } from "../../clients/ui/src/session/transcript.ts";
import type { ImageReply } from "../../clients/ui/src/session/model.ts";
import { MAX_IMAGE_REPLIES } from "../../clients/ui/src/session/model.ts";
import { attachImageCommand, parseSessionLine, type SessionMessage } from "../../clients/ui/src/session/wire.ts";

function line(value: unknown): SessionMessage {
    const message = parseSessionLine(JSON.stringify(value));
    if (message === undefined) throw new Error("test line did not parse");
    return message;
}

const first: ComposerImage = { requestId: "i1", number: 1, name: "a.png" };
const second: ComposerImage = { requestId: "i2", number: 2, name: "b.png" };

describe("image replies", () => {
    test("attached and rejected replies parse and collect on the watch", () => {
        let watch = reduceWatch(initialWatch("a"), line({
            type: "image_attached",
            requestId: "i1",
            attachment: { id: "att-1", name: "a.png", mediaType: "image/png", bytes: 10, width: 1, height: 1 },
        }));
        watch = reduceWatch(watch, line({ type: "image_attachment_rejected", requestId: "i2", error: "Too large" }));
        expect(watch.images).toEqual([
            { requestId: "i1", outcome: "attached", attachmentId: "att-1" },
            { requestId: "i2", outcome: "rejected", error: "Too large" },
        ]);
    });

    test("the watch keeps only the newest replies", () => {
        let watch = initialWatch("a");
        for (let index = 0; index < MAX_IMAGE_REPLIES + 5; index += 1) {
            watch = reduceWatch(watch, line({ type: "image_attachment_rejected", requestId: `r${index}`, error: "no" }));
        }
        expect(watch.images).toHaveLength(MAX_IMAGE_REPLIES);
        expect(watch.images[0]?.requestId).toBe("r5");
    });

    test("an attach command names the request and the path", () => {
        expect(JSON.parse(attachImageCommand("i1", "/tmp/a.png"))).toEqual({ type: "attach_image", requestId: "i1", path: "/tmp/a.png" });
    });
});

describe("composer images", () => {
    const replies: readonly ImageReply[] = [{ requestId: "i1", outcome: "attached", attachmentId: "att-1" }];

    test("an image is attaching until its reply arrives", () => {
        expect(imageState(second, replies)).toEqual({ kind: "attaching" });
        expect(imageState(first, replies)).toEqual({ kind: "attached", attachmentId: "att-1" });
    });

    test("a prompt waits until every image has an attachment id", () => {
        expect(readyAttachments([first, second], replies)).toEqual({ kind: "waiting" });
        expect(readyAttachments([first], replies)).toEqual({ kind: "ready", attachmentIds: ["att-1"] });
        expect(readyAttachments([], [])).toEqual({ kind: "ready", attachmentIds: [] });
    });

    test("numbers keep counting up after a removal", () => {
        expect(nextImageNumber([])).toBe(1);
        expect(nextImageNumber([second])).toBe(3);
    });

    test("draft images skip duplicates", () => {
        const drafts = addDraftImages([], ["/a/one.png", "/a/one.png", "/a/two.jpg"]);
        expect(drafts.map((image) => [image.number, image.name])).toEqual([[1, "one.png"], [2, "two.jpg"]]);
    });

    test("pasted text counts as images only when every word is an absolute image path", () => {
        expect(pastedImagePaths("/Users/me/Shot\\ 1.png /tmp/b.JPG")).toEqual(["/Users/me/Shot 1.png", "/tmp/b.JPG"]);
        expect(pastedImagePaths("look at /tmp/b.png")).toEqual([]);
        expect(pastedImagePaths("/tmp/a.png\n/tmp/b.png")).toEqual([]);
        expect(pastedImagePaths("relative.png")).toEqual([]);
    });
});

describe("pasted image files", () => {
    test("are written for image types and old ones are swept", async () => {
        const directory = await mkdtemp(join(tmpdir(), "vera-pasted-test-"));
        try {
            const old = await savePastedImage(directory, new Uint8Array([1, 2, 3]), "image/png");
            if (old === undefined) throw new Error("expected a file");
            const past = (Date.now() - PASTED_IMAGE_KEEP_MS - 60_000) / 1_000;
            await utimes(old, past, past);
            expect(await savePastedImage(directory, new Uint8Array([1]), "text/plain")).toBeUndefined();
            expect(await savePastedImage(directory, new Uint8Array([]), "image/png")).toBeUndefined();
            const kept = await savePastedImage(directory, new Uint8Array([4]), "image/jpeg");
            expect(kept?.endsWith(".jpg")).toBe(true);
            expect(await readdir(directory)).toHaveLength(1);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
