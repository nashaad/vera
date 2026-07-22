import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
    chmod,
    link,
    lstat,
    mkdir,
    open,
    unlink,
} from "node:fs/promises";
import { basename, join } from "node:path";

import type { ImageMediaType, ValidatedImage } from "./image.ts";

export interface StoredImageAttachment extends ValidatedImage {
    readonly id: string;
    readonly name: string;
}

export class AttachmentStore {
    readonly path: string;

    constructor(sessionPath: string) {
        if (sessionPath.length === 0) throw new Error("session path is required");
        this.path = `${sessionPath}.attachments`;
    }

    async saveImage(
        data: Uint8Array,
        image: ValidatedImage,
        sourceName: string,
    ): Promise<StoredImageAttachment> {
        const bytes = copyBytes(data);
        const metadata = copyMetadata(image);
        const name = displayName(sourceName);
        const actualHash = sha256(bytes);
        if (bytes.byteLength !== metadata.bytes || actualHash !== metadata.sha256) {
            throw new Error("Image bytes do not match validated metadata");
        }

        const id = `${metadata.sha256}.${extensionFor(metadata.mediaType)}`;
        await mkdir(this.path, { recursive: true, mode: 0o700 });
        await requireDirectory(this.path);
        await chmod(this.path, 0o700);
        await writeExclusive(join(this.path, id), bytes);

        return {
            id,
            name,
            ...metadata,
        };
    }

    async readImage(attachment: StoredImageAttachment): Promise<Uint8Array> {
        const metadata = copyMetadata(attachment);
        const expectedId = `${metadata.sha256}.${extensionFor(metadata.mediaType)}`;
        if (attachment.id !== expectedId) {
            throw new Error("Attachment reference does not match its metadata");
        }
        await requireDirectory(this.path);
        const data = await readNoFollow(join(this.path, expectedId));
        if (data.byteLength !== metadata.bytes || sha256(data) !== metadata.sha256) {
            throw new Error("Stored attachment does not match its metadata");
        }
        return data;
    }
}

async function writeExclusive(path: string, data: Uint8Array): Promise<void> {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
        await file.chmod(0o600);
        await file.writeFile(data);
        await file.sync();
    } finally {
        await file.close();
    }

    try {
        await link(temporaryPath, path);
    } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const existing = await readNoFollow(path);
        if (!sameBytes(existing, data)) {
            throw new Error("Stored attachment conflicts with validated bytes");
        }
    } finally {
        await unlink(temporaryPath).catch(() => undefined);
    }
}

async function requireDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error("Attachment storage path must be a directory");
    }
}

async function readNoFollow(path: string): Promise<Uint8Array> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        return new Uint8Array(await file.readFile());
    } finally {
        await file.close();
    }
}

function copyMetadata(image: ValidatedImage): ValidatedImage {
    const metadata = {
        mediaType: image.mediaType,
        bytes: image.bytes,
        width: image.width,
        height: image.height,
        sha256: image.sha256,
    };
    if (
        !isImageMediaType(metadata.mediaType)
        || !Number.isSafeInteger(metadata.bytes)
        || metadata.bytes <= 0
        || !Number.isSafeInteger(metadata.width)
        || metadata.width <= 0
        || !Number.isSafeInteger(metadata.height)
        || metadata.height <= 0
        || !/^[a-f0-9]{64}$/.test(metadata.sha256)
    ) {
        throw new Error("Invalid image metadata");
    }
    return metadata;
}

function displayName(sourceName: string): string {
    const name = basename(sourceName.replaceAll("\\", "/")).trim();
    if (name.length === 0 || name.includes("\0")) {
        throw new Error("attachment name is required");
    }
    if (Buffer.byteLength(name, "utf8") > 255) {
        throw new Error("attachment name is too long");
    }
    return name;
}

function extensionFor(mediaType: ImageMediaType): string {
    switch (mediaType) {
        case "image/png": return "png";
        case "image/jpeg": return "jpg";
        case "image/gif": return "gif";
        case "image/webp": return "webp";
    }
}

function isImageMediaType(value: string): value is ImageMediaType {
    return value === "image/png"
        || value === "image/jpeg"
        || value === "image/gif"
        || value === "image/webp";
}

function copyBytes(data: Uint8Array): Uint8Array {
    try {
        const getter = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(Uint8Array.prototype) as object,
            "byteLength",
        )?.get;
        if (getter === undefined) throw new Error("missing byte length getter");
        const copy = new Uint8Array(getter.call(data) as number);
        copy.set(data);
        return copy;
    } catch {
        throw new TypeError("Image data must be a Uint8Array");
    }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    return left.every((value, index) => value === right[index]);
}

function sha256(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

function isAlreadyExists(error: unknown): boolean {
    return error instanceof Error
        && "code" in error
        && error.code === "EEXIST";
}
