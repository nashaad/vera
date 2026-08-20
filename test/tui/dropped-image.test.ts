import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { materializeDroppedImage } from "../../clients/tui/dropped-image.ts";
import { pastedImagePaths } from "../../clients/tui/image-path.ts";

async function scratch(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "dropped-image-test-"));
}

/**
 * What Ghostty delivers when the macOS capture thumbnail is dragged in:
 * ASCII spaces backslash-escaped, the narrow no-break space before the
 * meridiem left bare, and a trailing space after the path.
 */
const DROPPED_CAPTURE_NAME = `Screenshot 2026-08-19 at 10.20.08\u202fPM.png`;
const dropped = (directory: string): string =>
    `${join(directory, DROPPED_CAPTURE_NAME).replaceAll(" ", "\\ ")} `;

describe("materializeDroppedImage", () => {
    test("copies the bytes out of the dropped location", async () => {
        const source = await scratch();
        const original = join(source, "Screenshot.png");
        await writeFile(original, "image-bytes");

        const { path, release } = await materializeDroppedImage(original);
        expect(path).not.toBe(original);
        expect(await readFile(path, "utf8")).toBe("image-bytes");

        // The copy outlives the original, which is the whole point.
        await rm(source, { recursive: true, force: true });
        expect(await readFile(path, "utf8")).toBe("image-bytes");

        await release();
        expect(existsSync(path)).toBe(false);
    });

    test("keeps a name carrying a narrow no-break space", async () => {
        const source = await scratch();
        const original = join(source, DROPPED_CAPTURE_NAME);
        await writeFile(original, "bytes");

        const { path, release } = await materializeDroppedImage(original);
        expect(path.endsWith(DROPPED_CAPTURE_NAME)).toBe(true);
        expect(await readFile(path, "utf8")).toBe("bytes");

        await release();
        await rm(source, { recursive: true, force: true });
    });

    test("recovers a capture whose thumbnail already filed it away", async () => {
        const captures = await scratch();
        const vanished = join(
            "/var/folders/xx/T/TemporaryItems/NSIRD_screencaptureui_zExC81",
            DROPPED_CAPTURE_NAME,
        );
        await writeFile(join(captures, DROPPED_CAPTURE_NAME), "filed-bytes");

        const { path, release } = await materializeDroppedImage(vanished, {
            savedCaptures: async () => captures,
        });
        expect(await readFile(path, "utf8")).toBe("filed-bytes");

        await release();
        await rm(captures, { recursive: true, force: true });
    });

    test("hands back the dropped path when the file is nowhere", async () => {
        const source = await scratch();
        const missing = join(source, "Gone.png");

        const { path } = await materializeDroppedImage(missing, {
            savedCaptures: async () => source,
        });
        // The host reports the failure against the name the person dropped.
        expect(path).toBe(missing);

        await rm(source, { recursive: true, force: true });
    });

    test("keeps two drops of the same name apart", async () => {
        const first = await scratch();
        const second = await scratch();
        await writeFile(join(first, "Screenshot.png"), "first");
        await writeFile(join(second, "Screenshot.png"), "second");

        const [one, two] = await Promise.all([
            materializeDroppedImage(join(first, "Screenshot.png")),
            materializeDroppedImage(join(second, "Screenshot.png")),
        ]);
        expect(one.path).not.toBe(two.path);
        expect(await readFile(one.path, "utf8")).toBe("first");
        expect(await readFile(two.path, "utf8")).toBe("second");

        // Releasing one drop leaves the other readable.
        await one.release();
        expect(await readFile(two.path, "utf8")).toBe("second");

        await two.release();
        await rm(first, { recursive: true, force: true });
        await rm(second, { recursive: true, force: true });
    });

    test("releasing twice is not an error", async () => {
        const source = await scratch();
        await writeFile(join(source, "Screenshot.png"), "bytes");

        const { path, release } = await materializeDroppedImage(
            join(source, "Screenshot.png"),
        );
        await release();
        await release();
        expect(existsSync(path)).toBe(false);

        await rm(source, { recursive: true, force: true });
    });

    test("leaves nothing behind once released", async () => {
        const source = await scratch();
        await writeFile(join(source, "Screenshot.png"), "bytes");

        const { path, release } = await materializeDroppedImage(
            join(source, "Screenshot.png"),
        );
        const scratchDirectory = join(path, "..");
        expect(await readdir(scratchDirectory)).toEqual(["Screenshot.png"]);

        await release();
        expect(existsSync(scratchDirectory)).toBe(false);

        await rm(source, { recursive: true, force: true });
    });
});

describe("a dropped capture, from terminal bytes to readable file", () => {
    test("the bytes Ghostty sends end up as an image the host can read", async () => {
        const source = await scratch();
        await writeFile(join(source, DROPPED_CAPTURE_NAME), "capture-bytes");

        const paths = pastedImagePaths(dropped(source));
        expect(paths).toEqual([join(source, DROPPED_CAPTURE_NAME)]);

        const { path, release } = await materializeDroppedImage(paths[0]!);
        expect(await readFile(path, "utf8")).toBe("capture-bytes");

        await release();
        await rm(source, { recursive: true, force: true });
    });

    test("a capture survives the thumbnail deleting it mid-drop", async () => {
        const temporary = await scratch();
        const captures = await scratch();
        await writeFile(join(temporary, DROPPED_CAPTURE_NAME), "capture-bytes");
        await writeFile(join(captures, DROPPED_CAPTURE_NAME), "capture-bytes");

        const paths = pastedImagePaths(dropped(temporary));
        // macOS files the capture and drops the temporary copy.
        await rm(temporary, { recursive: true, force: true });

        const { path, release } = await materializeDroppedImage(paths[0]!, {
            savedCaptures: async () => captures,
        });
        expect(await readFile(path, "utf8")).toBe("capture-bytes");

        await release();
        await rm(captures, { recursive: true, force: true });
    });
});
