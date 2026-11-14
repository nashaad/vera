import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, openSync, closeSync, fstatSync, readSync, opendirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { arch, platform } from "node:os";
import { validateImageBytes, IMAGE_ATTACHMENT_LIMITS } from "../attachments/image.ts";
import { inspectImageWithSharp } from "../attachments/sharp-image-inspector.ts";
import { veraFeedbackDirectoryIn } from "../profile-paths.ts";
import { VERA_PRODUCT_VERSION } from "../release/manifest.ts";

export type FeedbackKind = "bug" | "feature";
export type FeedbackSource = "window" | "terminal" | "chat";

export interface FeedbackInput {
    readonly kind: FeedbackKind;
    readonly title: string;
    readonly description: string;
    readonly source: FeedbackSource;
    readonly sessionId?: string;
    readonly imagePaths?: readonly string[];
}

export const FEEDBACK_MAX_REPORTS = 500;
export const FEEDBACK_MAX_IMAGES = 4;
export const FEEDBACK_MAX_IMAGE_BYTES = 10 * 1_024 * 1_024;

const EXTENSIONS: Readonly<Record<string, string>> = {
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp",
};

export async function saveFeedback(home: string, input: FeedbackInput, write: typeof writeFileSync = writeFileSync): Promise<string> {
    if (input.kind !== "bug" && input.kind !== "feature") throw new Error("Choose Bug or Feature request.");
    if (typeof input.title !== "string" || input.title.trim().length === 0 || input.title.length > 200) {
        throw new Error("Title is required and must be at most 200 characters.");
    }
    if (typeof input.description !== "string" || input.description.length > 20_000) {
        throw new Error("Description must be at most 20000 characters.");
    }
    if (input.source !== "window" && input.source !== "terminal" && input.source !== "chat") throw new Error("Invalid report source.");
    if (input.sessionId !== undefined && (typeof input.sessionId !== "string" || input.sessionId.length > 256)) throw new Error("Invalid session id.");
    const paths = input.imagePaths ?? [];
    if (!Array.isArray(paths) || paths.length > FEEDBACK_MAX_IMAGES || paths.some((path) => typeof path !== "string")) {
        throw new Error("Add up to 4 images.");
    }
    const images: { bytes: Buffer; extension: string }[] = [];
    for (const path of paths) {
        const fd = openSync(path, "r");
        let bytes: Buffer;
        try {
            const info = fstatSync(fd);
            if (!info.isFile() || info.size > FEEDBACK_MAX_IMAGE_BYTES) throw new Error("Each image must be at most 10 MB.");
            const buffer = Buffer.alloc(Math.min(info.size + 1, FEEDBACK_MAX_IMAGE_BYTES + 1));
            let length = 0;
            while (length < buffer.length) {
                const read = readSync(fd, buffer, length, buffer.length - length, null);
                if (read === 0) break;
                length += read;
            }
            if (length > info.size) throw new Error("Image changed while being read.");
            bytes = buffer.subarray(0, length);
        } finally {
            closeSync(fd);
        }
        if (bytes.length > FEEDBACK_MAX_IMAGE_BYTES) throw new Error("Each image must be at most 10 MB.");
        const image = await validateImageBytes(bytes, { ...IMAGE_ATTACHMENT_LIMITS, maxBytes: FEEDBACK_MAX_IMAGE_BYTES }, inspectImageWithSharp);
        images.push({ bytes, extension: EXTENSIONS[image.mediaType]! });
    }
    const parent = veraFeedbackDirectoryIn(home);
    mkdirSync(parent, { recursive: true });
    const lock = join(parent, ".lock");
    for (let attempt = 0; ; attempt++) {
        try { mkdirSync(lock); break; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (attempt >= 200) throw new Error(`Cannot save a report while ${lock} exists. If no report is being saved, remove that folder and try again.`);
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
    try {
        let count = 0;
        const directory = opendirSync(parent);
        try {
            while (count < FEEDBACK_MAX_REPORTS) {
                const entry = directory.readSync();
                if (entry === null) break;
                if (entry.isDirectory() && !entry.name.startsWith(".")) count++;
            }
        } finally { directory.closeSync(); }
        if (count >= FEEDBACK_MAX_REPORTS) throw new Error(`The report limit is reached. Move reports out of ${parent} to save another.`);
        const createdAt = new Date().toISOString();
        const id = `${createdAt.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
        const temp = mkdtempSync(join(parent, ".report-"));
        try {
            const imageNames = images.map((image, index) => `image-${index + 1}.${image.extension}`);
            images.forEach((image, index) => write(join(temp, imageNames[index]!), image.bytes, { flag: "wx" }));
            const report = {
                id, kind: input.kind, title: input.title.trim(), description: input.description,
                created_at: createdAt, source: input.source, vera_version: VERA_PRODUCT_VERSION,
                os: platform(), architecture: arch(), ...(input.sessionId === undefined ? {} : { session_id: input.sessionId }),
                images: imageNames,
            };
            write(join(temp, "report.json"), `${JSON.stringify(report, null, 4)}\n`, { flag: "wx" });
            const destination = join(parent, id);
            renameSync(temp, destination);
            return destination;
        } catch (error) {
            rmSync(temp, { recursive: true, force: true });
            throw error;
        }
    } finally {
        rmSync(lock, { recursive: true, force: true });
    }
}
