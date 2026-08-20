import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { materializeDroppedImage } from "../../clients/tui/dropped-image.ts";

async function scratch(): Promise<string> {
    return await mkdtemp(join(tmpdir(), "dropped-image-test-"));
}

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
        const name = `Screenshot 2026-08-19 at 10.20.08\u202fPM.png`;
        const original = join(source, name);
        await writeFile(original, "bytes");

        const { path, release } = await materializeDroppedImage(original);
        expect(path.endsWith(name)).toBe(true);
        expect(await readFile(path, "utf8")).toBe("bytes");

        await release();
        await rm(source, { recursive: true, force: true });
    });

    test("hands back the dropped path when the file is nowhere", async () => {
        const source = await scratch();
        const missing = join(source, "Gone.png");

        const { path } = await materializeDroppedImage(missing);
        // The host reports the failure against the name the person dropped.
        expect(path).toBe(missing);

        await rm(source, { recursive: true, force: true });
    });
});
