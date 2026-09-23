import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";

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

export async function materializeDroppedImage(
    path: string,
    options: {
        readonly savedCaptures?: () => Promise<string>;
    } = {},
): Promise<{ path: string; source: string; release: () => Promise<void> }> {
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
    if (direct !== undefined) return { path: direct, source: path, release };

    const locate = options.savedCaptures ?? savedCaptureDirectory;
    const saved = join(await locate(), basename(path));
    if (saved !== path) {
        const recovered = await copyIntoScratch(saved, scratch);
        if (recovered !== undefined) return { path: recovered, source: saved, release };
    }

    await release();
    return { path, source: path, release: async () => {} };
}
