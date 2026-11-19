import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { IMAGE_ATTACHMENT_LIMITS, validateImageBytes, type ValidatedImage } from "../../attachments/image.ts";
import { inspectImageWithSharp } from "../../attachments/sharp-image-inspector.ts";
import type { VeraExtensionApi } from "../../sdk/extensions.ts";

export function activate(vera: VeraExtensionApi): void {
    vera.tools.register({
        name: "view_image",
        description: "View a still PNG, JPEG, GIF or WebP image at any path available to Vera, up to 20 MiB. Relative paths resolve from the workspace. A model without image input gets a note that the image was omitted.",
        inputSchema: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Path to the local image file, absolute or relative to the workspace.",
                },
            },
            required: ["path"],
            additionalProperties: false,
        },
        permissionInputs: [{ field: "path", kind: "path", verb: "read" }],
        async run({ input, workspace, signal }) {
            if (typeof input.path !== "string" || input.path.length === 0) {
                throw new Error("Image path must be a non-empty string");
            }
            const target = await imagePath(workspace, input.path, signal);
            const image = await validateFile(target, signal);
            const name = JSON.stringify(basename(input.path)).slice(1, -1)
                .replace(/[\u007f-\u009f\u2028\u2029]/g, (character) =>
                    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
                );
            const format = image.mediaType.slice("image/".length).toUpperCase();
            const output = `${name}: ${format}, ${image.width}x${image.height}, ${image.bytes} bytes`;
            return { output, imagePaths: [target] };
        },
    });
}

async function imagePath(workspace: string, path: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const root = resolve(workspace);
    const candidate = resolve(root, path);
    const realRoot = await realpath(root);
    let target: string;
    try {
        target = await realpath(candidate);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error(`Image path not found: ${path}`);
        }
        throw error;
    }
    signal.throwIfAborted();
    if (inside(root, candidate) !== inside(realRoot, target)) {
        throw new Error(`Image path crosses the workspace boundary through a symbolic link; use ${target} instead`);
    }
    return target;
}

function inside(root: string, path: string): boolean {
    const relativePath = relative(root, path);
    return relativePath === ""
        || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

async function validateFile(path: string, signal: AbortSignal): Promise<ValidatedImage> {
    const flags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
    const file = await open(path, flags);
    try {
        const info = await file.stat();
        if (!info.isFile()) throw new Error("Image must be a regular file");
        if (info.size > IMAGE_ATTACHMENT_LIMITS.maxBytes) {
            throw new Error(`Image is ${info.size} bytes; maximum is ${IMAGE_ATTACHMENT_LIMITS.maxBytes}`);
        }
        const buffer = new Uint8Array(info.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
            signal.throwIfAborted();
            const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        if (offset > info.size) throw new Error("Image changed while reading; try again");
        signal.throwIfAborted();
        const image = await validateImageBytes(buffer.subarray(0, offset), IMAGE_ATTACHMENT_LIMITS, inspectImageWithSharp);
        signal.throwIfAborted();
        return image;
    } finally {
        await file.close();
    }
}
