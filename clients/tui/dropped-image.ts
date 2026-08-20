import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";

/**
 * A screenshot dragged from the capture thumbnail names a file macOS deletes
 * as soon as the thumbnail dismisses, and the directory holding it is barred
 * to processes the capture did not grant. The path is only good for the
 * moment it arrives, so the bytes are taken then rather than when the host
 * gets around to reading them.
 */

/** Where macOS files a capture once the thumbnail is done with it. */
async function savedCaptureDirectory(): Promise<string> {
    const fallback = join(homedir(), "Desktop");
    if (process.platform !== "darwin") return fallback;
    try {
        const read = Bun.spawn(
            ["defaults", "read", "com.apple.screencapture", "location"],
            { stdout: "pipe", stderr: "ignore" },
        );
        const configured = (await new Response(read.stdout).text()).trim();
        if (await read.exited !== 0 || configured.length === 0) return fallback;
        return configured.startsWith("~")
            ? join(homedir(), configured.slice(1))
            : configured;
    } catch {
        return fallback;
    }
}

/** A copy the caller owns, or undefined when neither location holds the file. */
async function copyIntoScratch(
    source: string,
    scratch: string,
): Promise<string | undefined> {
    const destination = join(scratch, basename(source));
    try {
        await copyFile(source, destination);
        return destination;
    } catch {
        return undefined;
    }
}

/**
 * Take a dropped image out of wherever it landed and into a directory this
 * process owns, returning the path to hand onward.
 *
 * The original is tried first. A capture whose thumbnail already dismissed is
 * looked for under the same name where macOS files it, which is the same
 * image and the one the person meant.
 */
export async function materializeDroppedImage(
    path: string,
    options: {
        /** Where a dismissed capture is looked for. Defaults to the macOS setting. */
        readonly savedCaptures?: () => Promise<string>;
    } = {},
): Promise<{ path: string; release: () => Promise<void> }> {
    const root = join(tmpdir(), "vera-dropped-images");
    await mkdir(root, { recursive: true });
    const scratch = await mkdtemp(join(root, "drop-"));
    let released = false;
    const release = async (): Promise<void> => {
        if (released) return;
        released = true;
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
    };

    const direct = await copyIntoScratch(path, scratch);
    if (direct !== undefined) return { path: direct, release };

    const locate = options.savedCaptures ?? savedCaptureDirectory;
    const saved = join(await locate(), basename(path));
    if (saved !== path) {
        const recovered = await copyIntoScratch(saved, scratch);
        if (recovered !== undefined) return { path: recovered, release };
    }

    await release();
    // The original path carries the name the person recognises, so the failure
    // the host reports names the file they dropped.
    return { path, release: async () => {} };
}
