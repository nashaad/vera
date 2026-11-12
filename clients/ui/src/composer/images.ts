import type { ImageReply } from "../session/model.ts";

export const IMAGE_LIMIT = 8;

export interface ComposerImage {
    readonly requestId: string;
    // Shown on the chip as "Image N"; numbers keep counting up while the composer holds images.
    readonly number: number;
    readonly name: string;
}

export interface ImageAttaching {
    readonly kind: "attaching";
}

export interface ImageReady {
    readonly kind: "attached";
    readonly attachmentId: string;
}

export interface ImageFailed {
    readonly kind: "rejected";
    readonly error: string;
}

export type ImageState = ImageAttaching | ImageReady | ImageFailed;

export function imageState(image: ComposerImage, replies: readonly ImageReply[]): ImageState {
    const reply = replies.findLast((candidate) => candidate.requestId === image.requestId);
    if (reply === undefined) return { kind: "attaching" };
    return reply.outcome === "attached"
        ? { kind: "attached", attachmentId: reply.attachmentId }
        : { kind: "rejected", error: reply.error };
}

export function nextImageNumber(images: readonly ComposerImage[]): number {
    return (images.at(-1)?.number ?? 0) + 1;
}

export function imageLabel(image: ComposerImage): string {
    return `Image ${image.number}`;
}

export interface ImagesWaiting {
    readonly kind: "waiting";
}

export interface ImagesReady {
    readonly kind: "ready";
    readonly attachmentIds: readonly string[];
}

// A prompt goes out only once every held image has its attachment id.
export function readyAttachments(images: readonly ComposerImage[], replies: readonly ImageReply[]): ImagesWaiting | ImagesReady {
    const attachmentIds: string[] = [];
    for (const image of images) {
        const state = imageState(image, replies);
        if (state.kind !== "attached") return { kind: "waiting" };
        attachmentIds.push(state.attachmentId);
    }
    return { kind: "ready", attachmentIds };
}

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;

// Text pasted as one line of absolute image paths, with backslash-escaped spaces; empty for anything else.
export function pastedImagePaths(text: string): readonly string[] {
    const line = text.trim();
    if (line.length === 0 || line.includes("\n")) return [];
    const paths = line.split(/(?<!\\) +/).map((part) => part.replace(/\\(.)/g, "$1"));
    return paths.every((path) => path.startsWith("/") && IMAGE_EXTENSION.test(path)) ? paths : [];
}

export function isImageFile(name: string): boolean {
    return IMAGE_EXTENSION.test(name);
}

export function baseName(path: string): string {
    return path.split("/").filter((part) => part.length > 0).at(-1) ?? path;
}
