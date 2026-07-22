import { expect, test } from "bun:test";
import sharp from "sharp";

import { validateImageBytes } from "../../src/attachments/image.ts";
import { inspectImageWithSharp } from "../../src/attachments/sharp-image-inspector.ts";

const LIMITS = { maxBytes: 100_000, maxWidth: 100, maxHeight: 100 };

test("Sharp fully decodes each supported image format", async () => {
    const formats = ["png", "jpeg", "gif", "webp"] as const;
    for (const format of formats) {
        const encoded = await encodeImage(format);
        const validated = await validateImageBytes(
            encoded,
            LIMITS,
            inspectImageWithSharp,
        );

        expect(validated).toEqual(expect.objectContaining({
            mediaType: format === "jpeg" ? "image/jpeg" : `image/${format}`,
            width: 3,
            height: 2,
            bytes: encoded.byteLength,
        }));
    }
});

test("Sharp rejects truncated image payloads", async () => {
    const formats = ["png", "jpeg", "gif", "webp"] as const;
    for (const format of formats) {
        const encoded = await encodeImage(format);
        const truncated = encoded.subarray(0, Math.floor(encoded.length / 2));

        await expect(validateImageBytes(
            truncated,
            LIMITS,
            inspectImageWithSharp,
        )).rejects.toMatchObject({ code: "corrupt" });

        await expect(validateImageBytes(
            encoded.subarray(0, encoded.length - 1),
            LIMITS,
            inspectImageWithSharp,
        )).rejects.toMatchObject({ code: "corrupt" });
    }
});

test("Sharp applies the caller's pixel limit before full decode", async () => {
    const encoded = await sharp({
        create: {
            width: 20,
            height: 20,
            channels: 3,
            background: "blue",
        },
    }).png().toBuffer();

    await expect(validateImageBytes(
        encoded,
        { maxBytes: 100_000, maxWidth: 10, maxHeight: 10 },
        inspectImageWithSharp,
    )).rejects.toMatchObject({ code: "dimensions_exceeded" });

    await expect(validateImageBytes(
        encoded.subarray(0, encoded.length - 1),
        { maxBytes: 100_000, maxWidth: 10, maxHeight: 10 },
        inspectImageWithSharp,
    )).rejects.toMatchObject({ code: "corrupt" });
});

async function encodeImage(
    format: "png" | "jpeg" | "gif" | "webp",
): Promise<Uint8Array> {
    return sharp({
        create: {
            width: 3,
            height: 2,
            channels: 3,
            background: "red",
        },
    }).toFormat(format).toBuffer();
}
