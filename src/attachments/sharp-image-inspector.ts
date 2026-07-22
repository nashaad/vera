import sharp from "sharp";

import type {
    ImageValidationLimits,
    InspectedImage,
} from "./image.ts";

export async function inspectImageWithSharp(
    data: Uint8Array,
    limits: ImageValidationLimits,
): Promise<InspectedImage> {
    const input = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const metadata = await sharp(input, {
        animated: true,
        failOn: "warning" as const,
        limitInputPixels: false,
    }).metadata();
    if (
        metadata.mediaType === undefined
        || metadata.width === undefined
        || metadata.height === undefined
    ) {
        throw new Error("Image decoder returned incomplete metadata");
    }
    const inspected = {
        mediaType: metadata.mediaType,
        width: metadata.width,
        height: metadata.pageHeight ?? metadata.height,
        animated: (metadata.pages ?? 1) > 1,
    };
    const supported = isSupportedMediaType(inspected.mediaType);
    if (supported && !inspected.animated) {
        requireCompleteContainer(data, inspected.mediaType);
    }
    if (
        !supported
        || inspected.animated
        || inspected.width > limits.maxWidth
        || inspected.height > limits.maxHeight
    ) {
        return inspected;
    }

    await sharp(input, {
        failOn: "warning",
        limitInputPixels: maximumPixels(limits),
    }).stats();
    return inspected;
}

function requireCompleteContainer(data: Uint8Array, mediaType: string): void {
    if (mediaType === "image/png") {
        const end = [
            0x00, 0x00, 0x00, 0x00,
            0x49, 0x45, 0x4e, 0x44,
            0xae, 0x42, 0x60, 0x82,
        ];
        if (!endsWith(data, end)) throw new Error("PNG is missing IEND");
        return;
    }
    if (mediaType === "image/gif") {
        if (data[data.length - 1] !== 0x3b) {
            throw new Error("GIF is missing its trailer");
        }
        return;
    }
    if (mediaType === "image/jpeg") {
        if (data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) {
            throw new Error("JPEG is missing EOI");
        }
        return;
    }
    if (mediaType === "image/webp") {
        if (data.length < 12 || uint32le(data, 4) + 8 !== data.length) {
            throw new Error("WebP RIFF size does not match its bytes");
        }
    }
}

function endsWith(data: Uint8Array, expected: readonly number[]): boolean {
    if (data.length < expected.length) return false;
    const offset = data.length - expected.length;
    return expected.every((byte, index) => data[offset + index] === byte);
}

function uint32le(data: Uint8Array, offset: number): number {
    return data[offset]!
        + data[offset + 1]! * 0x100
        + data[offset + 2]! * 0x10000
        + data[offset + 3]! * 0x1000000;
}

function isSupportedMediaType(value: string): boolean {
    return value === "image/png"
        || value === "image/jpeg"
        || value === "image/gif"
        || value === "image/webp";
}

function maximumPixels(limits: ImageValidationLimits): number {
    const pixels = limits.maxWidth * limits.maxHeight;
    return Number.isSafeInteger(pixels) ? pixels : Number.MAX_SAFE_INTEGER;
}
