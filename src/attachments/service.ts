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
import type {
    ImageContent,
    ModelInputMessage,
    ModelMessage,
} from "../model/types.ts";
import type { AttachmentNameLookup } from "../engine/protocol.ts";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

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
        signal?: AbortSignal,
    ): Promise<StoredImageAttachment> {
        const snapshot = copyBytes(data);
        const validated = await validateImageBytes(
            snapshot,
            this.limits,
            this.inspect,
        );
        signal?.throwIfAborted();
        const stored = await this.files.saveImage(
            snapshot,
            validated,
            sourceName,
        );
        signal?.throwIfAborted();
        return this.session.appendAttachment(stored);
    }

    async attachFile(
        path: string,
        signal?: AbortSignal,
    ): Promise<StoredImageAttachment> {
        const selectedPath = resolveSelectedPath(path, this.session.header.cwd);
        signal?.throwIfAborted();
        const file = await open(selectedPath, "r");
        try {
            const info = await file.stat();
            if (!info.isFile()) {
                throw new Error("Image attachment must be a regular file");
            }
            if (info.size > this.limits.maxBytes) {
                throw new Error(
                    `Image is ${info.size} bytes; maximum is ${this.limits.maxBytes}`,
                );
            }
            const buffer = new Uint8Array(this.limits.maxBytes + 1);
            let offset = 0;
            while (offset < buffer.length) {
                signal?.throwIfAborted();
                const { bytesRead } = await file.read(
                    buffer,
                    offset,
                    buffer.length - offset,
                    offset,
                );
                if (bytesRead === 0) break;
                offset += bytesRead;
            }
            if (offset > this.limits.maxBytes) {
                throw new Error(
                    `Image exceeds the maximum of ${this.limits.maxBytes} bytes`,
                );
            }
            signal?.throwIfAborted();
            return this.attach(
                buffer.subarray(0, offset),
                basename(selectedPath),
                signal,
            );
        } finally {
            await file.close();
        }
    }

    async readContent(attachmentId: string): Promise<ImageContent> {
        return readSessionImageContent(this.session, attachmentId);
    }
}

function resolveSelectedPath(path: string, workspace: string): string {
    const expanded = path === "~" ? homedir()
        : path.startsWith("~/") ? join(homedir(), path.slice(2))
        : path;
    return isAbsolute(expanded) ? expanded : resolve(workspace, expanded);
}

/** Names the session's attachments, for transcripts that show what was sent. */
export function sessionAttachmentName(
    session: SessionStore,
): AttachmentNameLookup {
    return (id) => session.attachmentRecords().find(
        (record) => record.id === id,
    )?.name;
}

export async function readSessionImageContent(
    session: SessionStore,
    attachmentId: string,
): Promise<ImageContent> {
    const attachment = session.attachmentRecords().find(
        (candidate) => candidate.id === attachmentId,
    );
    if (attachment === undefined) {
        throw new Error(`Image attachment ${attachmentId} is not in this session`);
    }
    return {
        type: "image",
        mediaType: attachment.mediaType,
        data: await new AttachmentStore(session.path).readImage(attachment),
    };
}

export async function hydrateImageAttachments(
    messages: readonly ModelMessage[],
    readImage: (attachmentId: string) => Promise<ImageContent>,
    cache: Map<string, ImageContent> = new Map(),
): Promise<ModelInputMessage[]> {
    const hydrated: ModelInputMessage[] = [];
    for (const message of messages) {
        if (message.role !== "user") {
            hydrated.push(message);
            continue;
        }
        const content = [];
        for (const block of message.content) {
            if (block.type === "text") {
                content.push(block);
                continue;
            }
            let image = cache.get(block.attachmentId);
            if (image === undefined) {
                image = await readImage(block.attachmentId);
                cache.set(block.attachmentId, image);
            }
            content.push(image);
        }
        hydrated.push({ ...message, content });
    }
    return hydrated;
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
