import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { watchSettled } from "../../clients/desktop/src/package-watch.ts";

async function waitFor(check: () => boolean, ms = 2_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check() && Date.now() < deadline) await Bun.sleep(20);
}

function withFolder(run: (folder: string) => Promise<void>): Promise<void> {
    const folder = mkdtempSync(join(tmpdir(), "vera-package-watch-"));
    return run(folder).finally(() => rmSync(folder, { recursive: true, force: true }));
}

test("@core an install in the package folder reaches the window once, after it settles", async () => {
    await withFolder(async (folder) => {
        let settled = 0;
        const stop = watchSettled(folder, 100, () => {
            settled += 1;
        });
        try {
            mkdirSync(join(folder, ".tmp-1"));
            mkdirSync(join(folder, ".tmp-1", "inner"));
            renameSync(join(folder, ".tmp-1"), join(folder, "1.0.0-local.1"));
            await waitFor(() => settled > 0);
            await Bun.sleep(250);
            expect(settled).toBe(1);
        } finally {
            stop();
        }
    });
});

test("a stopped watch reports nothing", async () => {
    await withFolder(async (folder) => {
        let settled = 0;
        const stop = watchSettled(folder, 50, () => {
            settled += 1;
        });
        stop();
        mkdirSync(join(folder, "1.0.0"));
        await Bun.sleep(300);
        expect(settled).toBe(0);
    });
});

test("a missing folder gives a watch that does nothing", () => {
    const stop = watchSettled(join(tmpdir(), "vera-package-watch-missing", "nothing"), 50, () => {
        throw new Error("not expected");
    });
    stop();
});
