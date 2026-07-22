import { createHash } from "node:crypto";

export type ImageMediaType =
    | "image/png"
    | "image/jpeg"
    | "image/gif"
    | "image/webp";

export type ImageValidationErrorCode =
    | "too_large"
    | "unsupported"
    | "corrupt"
    | "dimensions_exceeded";

export interface ImageValidationLimits {
    readonly maxBytes: number;
    readonly maxWidth: number;
    readonly maxHeight: number;
}

export interface InspectedImage {
    readonly mediaType: string;
    readonly width: number;
    readonly height: number;
    readonly animated?: boolean;
}

export type InspectImageBytes = (
    data: Uint8Array,
    limits: ImageValidationLimits,
) => Promise<InspectedImage>;

export interface ValidatedImage {
    readonly mediaType: ImageMediaType;
    readonly bytes: number;
    readonly width: number;
    readonly height: number;
    readonly sha256: string;
}

export class ImageValidationError extends Error {
    constructor(
        readonly code: ImageValidationErrorCode,
        message: string,
    ) {
        super(message);
        this.name = "ImageValidationError";
    }
}

export async function validateImageBytes(
    data: Uint8Array,
    limits: ImageValidationLimits,
    inspect: InspectImageBytes,
): Promise<ValidatedImage> {
    const validatedLimits = validateLimits(limits);
    const byteLength = typedArrayByteLength(data);
    if (byteLength > validatedLimits.maxBytes) {
        throw new ImageValidationError(
            "too_large",
            `Image is ${byteLength} bytes; maximum is ${validatedLimits.maxBytes}`,
        );
    }

    const snapshot = new Uint8Array(byteLength);
    snapshot.set(data);
    const decoderInput = new Uint8Array(byteLength);
    decoderInput.set(snapshot);
    const inspected = await inspectSnapshot(
        decoderInput,
        validatedLimits,
        inspect,
    );
    if (!isImageMediaType(inspected.mediaType)) {
        throw new ImageValidationError(
            "unsupported",
            `Image decoder reported unsupported type: ${inspected.mediaType}`,
        );
    }
    if (inspected.animated === true) {
        throw new ImageValidationError(
            "unsupported",
            "Animated images are not supported",
        );
    }
    if (
        !Number.isSafeInteger(inspected.width)
        || inspected.width <= 0
        || !Number.isSafeInteger(inspected.height)
        || inspected.height <= 0
    ) {
        throw new ImageValidationError(
            "corrupt",
            "Image decoder returned invalid dimensions",
        );
    }
    if (
        inspected.width > validatedLimits.maxWidth
        || inspected.height > validatedLimits.maxHeight
    ) {
        throw new ImageValidationError(
            "dimensions_exceeded",
            `Image is ${inspected.width}x${inspected.height}; maximum is ${validatedLimits.maxWidth}x${validatedLimits.maxHeight}`,
        );
    }
    return {
        mediaType: inspected.mediaType,
        bytes: snapshot.byteLength,
        width: inspected.width,
        height: inspected.height,
        sha256: createHash("sha256").update(snapshot).digest("hex"),
    };
}

async function inspectSnapshot(
    snapshot: Uint8Array,
    limits: ImageValidationLimits,
    inspect: InspectImageBytes,
): Promise<InspectedImage> {
    try {
        const value: unknown = await inspect(snapshot, limits);
        if (
            typeof value !== "object"
            || value === null
        ) {
            throw new Error("decoder returned invalid metadata");
        }
        const record = value as Record<string, unknown>;
        const mediaType = record.mediaType;
        const width = record.width;
        const height = record.height;
        const animated = record.animated;
        if (
            typeof mediaType !== "string"
            || typeof width !== "number"
            || typeof height !== "number"
            || (animated !== undefined && typeof animated !== "boolean")
        ) {
            throw new Error("decoder returned invalid metadata");
        }
        return {
            mediaType,
            width,
            height,
            ...(animated === undefined ? {} : { animated }),
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new ImageValidationError(
            "corrupt",
            `Image decoder could not read the file: ${message}`,
        );
    }
}

function isImageMediaType(value: string): value is ImageMediaType {
    return value === "image/png"
        || value === "image/jpeg"
        || value === "image/gif"
        || value === "image/webp";
}

function validateLimits(limits: ImageValidationLimits): ImageValidationLimits {
    const validated = {
        maxBytes: limits.maxBytes,
        maxWidth: limits.maxWidth,
        maxHeight: limits.maxHeight,
    };
    const values = [
        ["maxBytes", validated.maxBytes],
        ["maxWidth", validated.maxWidth],
        ["maxHeight", validated.maxHeight],
    ] as const;
    for (const [name, value] of values) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new Error(`${name} must be a positive integer`);
        }
    }
    return validated;
}

function typedArrayByteLength(data: Uint8Array): number {
    const getter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(Uint8Array.prototype) as object,
        "byteLength",
    )?.get;
    if (getter === undefined) throw new Error("Uint8Array byte length is unavailable");
    try {
        return getter.call(data) as number;
    } catch {
        throw new TypeError("Image data must be a Uint8Array");
    }
}
