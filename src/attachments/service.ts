import type {
    SessionImageAttachmentMetadata,
    SessionStore,
} from "../store/session-store.ts";
import {
    validateImageBytes,
    type ImageValidationLimits,
    type InspectImageBytes,
} from "./image.ts";
import { inspectImageWithSharp } from "./sharp-image-inspector.ts";
import {
    AttachmentStore,
    type StoredImageAttachment,
} from "./store.ts";

export class ImageAttachmentService {
    private readonly limits: ImageValidationLimits;
    private readonly files: AttachmentStore;

    constructor(
        private readonly session: SessionStore,
        limits: ImageValidationLimits,
        private readonly inspect: InspectImageBytes = inspectImageWithSharp,
    ) {
        this.limits = copyLimits(limits);
        this.files = new AttachmentStore(session.path);
    }

    async attach(
        data: Uint8Array,
        sourceName: string,
    ): Promise<StoredImageAttachment> {
        const snapshot = copyBytes(data);
        const validated = await validateImageBytes(
            snapshot,
            this.limits,
            this.inspect,
        );
        const stored = await this.files.saveImage(
            snapshot,
            validated,
            sourceName,
        );
        return this.session.appendAttachment(stored);
    }
}

function copyLimits(limits: ImageValidationLimits): ImageValidationLimits {
    const copy = {
        maxBytes: limits.maxBytes,
        maxWidth: limits.maxWidth,
        maxHeight: limits.maxHeight,
    };
    for (const [name, value] of Object.entries(copy)) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new Error(`${name} must be a positive integer`);
        }
    }
    return copy;
}

function copyBytes(data: Uint8Array): Uint8Array {
    const getter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(Uint8Array.prototype) as object,
        "byteLength",
    )?.get;
    if (getter === undefined) throw new Error("Uint8Array byte length is unavailable");
    try {
        const copy = new Uint8Array(getter.call(data) as number);
        copy.set(data);
        return copy;
    } catch {
        throw new TypeError("Image data must be a Uint8Array");
    }
}
