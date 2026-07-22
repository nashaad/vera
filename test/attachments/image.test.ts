import { expect, test } from "bun:test";

import {
    ImageValidationError,
    validateImageBytes,
    type InspectImageBytes,
} from "../../src/attachments/image.ts";

const LIMITS = { maxBytes: 1_000, maxWidth: 1_000, maxHeight: 1_000 };

test("image validation snapshots bytes and returns trusted decoder metadata", async () => {
    const source = new Uint8Array([1, 2, 3, 4]);
    let inspected: Uint8Array | undefined;
    const inspect: InspectImageBytes = async (data) => {
        inspected = data;
        source[0] = 99;
        data[0] = 88;
        return { mediaType: "image/png", width: 320, height: 240 };
    };

    expect(await validateImageBytes(source, LIMITS, inspect)).toEqual({
        mediaType: "image/png",
        width: 320,
        height: 240,
        bytes: 4,
        sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
    });
    expect(inspected).toEqual(new Uint8Array([88, 2, 3, 4]));
    expect(source).toEqual(new Uint8Array([99, 2, 3, 4]));
});

test("image validation enforces size before invoking the decoder", async () => {
    let called = false;
    const inspect: InspectImageBytes = async () => {
        called = true;
        return { mediaType: "image/png", width: 1, height: 1 };
    };

    await expectError(
        new Uint8Array(10),
        { ...LIMITS, maxBytes: 5 },
        inspect,
        "too_large",
    );
    expect(called).toBe(false);
    await expect(validateImageBytes(
        new Uint8Array([1]),
        { maxWidth: 1, maxHeight: 1 } as typeof LIMITS,
        inspect,
    )).rejects.toThrow("maxBytes must be a positive integer");

    let maxBytesReads = 0;
    await expectError(
        new Uint8Array(2),
        {
            get maxBytes(): number {
                maxBytesReads += 1;
                return maxBytesReads === 1 ? 1 : 100;
            },
            maxWidth: 1,
            maxHeight: 1,
        },
        inspect,
        "too_large",
    );
    expect(maxBytesReads).toBe(1);
});

test("image validation rejects unsupported, corrupt, and huge decoder results", async () => {
    await expectError(
        new Uint8Array([1]),
        LIMITS,
        async () => ({ mediaType: "image/tiff", width: 1, height: 1 }),
        "unsupported",
    );
    await expectError(
        new Uint8Array([1]),
        LIMITS,
        async () => {
            throw new Error("decode failed");
        },
        "corrupt",
    );
    await expectError(
        new Uint8Array([1]),
        LIMITS,
        async () => null as never,
        "corrupt",
    );
    await expectError(
        new Uint8Array([1]),
        LIMITS,
        async () => {
            throw new ImageValidationError("unsupported", "forged");
        },
        "corrupt",
    );
    await expectError(
        new Uint8Array([1]),
        LIMITS,
        async () => ({ mediaType: "image/webp", width: 0, height: 1 }),
        "corrupt",
    );
    await expectError(
        new Uint8Array([1]),
        LIMITS,
        async () => ({ mediaType: "image/jpeg", width: 1_001, height: 1 }),
        "dimensions_exceeded",
    );
    await expectError(
        new Uint8Array([1]),
        LIMITS,
        async () => ({
            mediaType: "image/gif",
            width: 1,
            height: 1,
            animated: true,
        }),
        "unsupported",
    );
});

test("image validation reads decoder metadata properties once", async () => {
    let mediaTypeReads = 0;
    const result = await validateImageBytes(
        new Uint8Array([1]),
        LIMITS,
        async () => ({
            get mediaType(): string {
                mediaTypeReads += 1;
                return mediaTypeReads === 1 ? "image/png" : "image/tiff";
            },
            width: 1,
            height: 1,
        }),
    );

    expect(result.mediaType).toBe("image/png");
    expect(mediaTypeReads).toBe(1);
});

test("image validation ignores an overridden byte iterator", async () => {
    const data = new Uint8Array([1]);
    Object.defineProperty(data, Symbol.iterator, {
        value: function* (): IterableIterator<number> {
            for (let index = 0; index < 10; index += 1) yield 9;
        },
    });

    const result = await validateImageBytes(
        data,
        { maxBytes: 1, maxWidth: 1, maxHeight: 1 },
        async (snapshot) => {
            expect(snapshot).toEqual(new Uint8Array([1]));
            return { mediaType: "image/png", width: 1, height: 1 };
        },
    );

    expect(result.bytes).toBe(1);
});

async function expectError(
    data: Uint8Array,
    limits: typeof LIMITS,
    inspect: InspectImageBytes,
    code: ImageValidationError["code"],
): Promise<void> {
    try {
        await validateImageBytes(data, limits, inspect);
        throw new Error("Expected image validation to fail");
    } catch (error) {
        expect(error).toBeInstanceOf(ImageValidationError);
        expect((error as ImageValidationError).code).toBe(code);
    }
}
