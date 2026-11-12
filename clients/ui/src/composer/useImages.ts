import { useCallback, useEffect, useRef, useState } from "react";

import type { ImageReply } from "../session/model.ts";
import { attachImageCommand } from "../session/wire.ts";
import {
    baseName,
    IMAGE_LIMIT,
    imageLabel,
    imageState,
    nextImageNumber,
    type ComposerImage,
} from "./images.ts";
import { freshRequestId } from "./requests.ts";

export interface SessionImages {
    readonly images: readonly ComposerImage[];
    readonly add: (paths: readonly string[]) => void;
    readonly remove: (requestId: string) => void;
    readonly clear: () => void;
}

// Each image is attached as soon as it is added; a refused one leaves the composer with the host's reason.
export function useSessionImages(
    send: (line: string) => void,
    replies: readonly ImageReply[],
    onRefused: (reason: string) => void,
): SessionImages {
    const [images, setImages] = useState<readonly ComposerImage[]>([]);
    const held = useRef<readonly ComposerImage[]>([]);
    const update = useCallback((next: readonly ComposerImage[]) => {
        held.current = next;
        setImages(next);
    }, []);

    useEffect(() => {
        const refused: string[] = [];
        const kept = held.current.filter((image) => {
            const state = imageState(image, replies);
            if (state.kind !== "rejected") return true;
            refused.push(`${imageLabel(image)}: ${state.error}`);
            return false;
        });
        if (refused.length === 0) return;
        update(kept);
        onRefused(refused.join(" "));
    }, [replies, update, onRefused]);

    const add = useCallback((paths: readonly string[]) => {
        const next = [...held.current];
        for (const path of paths.slice(0, Math.max(0, IMAGE_LIMIT - next.length))) {
            const requestId = freshRequestId("image");
            send(attachImageCommand(requestId, path));
            next.push({ requestId, number: nextImageNumber(next), name: baseName(path) });
        }
        update(next);
    }, [send, update]);
    const remove = useCallback((requestId: string) => {
        update(held.current.filter((image) => image.requestId !== requestId));
    }, [update]);
    const clear = useCallback(() => update([]), [update]);
    return { images, add, remove, clear };
}

export interface DraftImage {
    readonly path: string;
    readonly number: number;
    readonly name: string;
}

// New Chat has no session to attach to yet, so it holds paths and the session attaches them once it opens.
export function addDraftImages(images: readonly DraftImage[], paths: readonly string[]): readonly DraftImage[] {
    const next = [...images];
    for (const path of paths) {
        if (next.length >= IMAGE_LIMIT) break;
        if (next.some((image) => image.path === path)) continue;
        next.push({ path, number: (next.at(-1)?.number ?? 0) + 1, name: baseName(path) });
    }
    return next;
}
